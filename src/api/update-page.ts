/**
 * Incremental page update — shared Pages Function.
 *
 * The WordPress companion plugin calls this on publish: fetch the page from
 * WordPress, transform it, and write it into PAGES_CACHE where _middleware
 * serves it. This is the fast half of the two-path sync; the nightly full
 * rebuild is the authoritative half. See the `ews-sync-protocol` skill.
 *
 * The HTML transform is injected, not shared. The two sites' transform files
 * are 3% identical (1,006 lines against 111) — they are two different answers
 * to the same problem, not one file that drifted, and forcing them into a
 * common shape would be the wrong kind of reuse.
 */

import { authenticateSync, nonceChecker, refusal } from '../lib/auth.js';
import { createLimiter } from '../lib/rate-limit.js';
import { corsHeaders, getResponseOrigin } from '../lib/cors.js';
import { normalizePath, redirectEntry } from '../_middleware.js';
import { fetchFromWordPress, WpOriginError, type WpOriginEnv } from '../lib/wp-fetch.js';
import { ASSET_MANIFEST, loadAssetVersions, versionHtml, type VersionLookup } from '../lib/asset-versions.js';

export interface UpdatePageEnv extends WpOriginEnv {
  PAGES_CACHE: KVNamespace;
  SYNC_SECRET: string;
  ALLOWED_ORIGIN: string;
  PAGES_PROJECT?: string;
  /** '2' refuses a request signed v1 only; unset or anything else accepts it, logged (2026-09-29). */
  SIGNATURE_MIN_VERSION?: string;
  /**
   * Where signature nonces are recorded — the same binding `contact` and
   * `comment` already require, so this adds no new resource to a site.
   *
   * Required in the type, and still checked at runtime by `nonceChecker`: a
   * type says nothing about whether the binding actually arrived. If it did
   * not, the signature path fails closed rather than running without replay
   * protection.
   */
  DB: D1Database;
  /**
   * The site's own static files. Pages provides it to every Function; the
   * Workers front door binds it by this name. Read for one file,
   * `ews-assets.json`, which a build writes when it versions asset URLs.
   */
  ASSETS?: { fetch: (request: Request) => Promise<Response> };
}

/**
 * How a pushed page gets the build's asset versions: the build's map, and the
 * absolute spellings of this site that may appear in the page.
 */
interface Versioning {
  lookup: VersionLookup;
  origins: string[];
}

export interface PageSpec {
  /**
   * `render` does everything `update` does — fetch, the site's transform,
   * asset versioning, the hash — and stores nothing. It answers the hash the
   * page *would* be stored under, which is how reconcile finds divergence with
   * the transform the site actually runs, HTMLRewriter included, rather than a
   * Node imitation of it.
   *
   * Safe against a handler that predates it: those answer an unknown action
   * with a 400, or a per-page "Invalid action" inside a bulk request, and
   * write nothing. A reconcile against an old edge therefore reports
   * divergence as unchecked instead of quietly re-pushing every page.
   */
  action: 'update' | 'remove' | 'render' | 'redirect';
  path: string;
  source_url?: string;
  /**
   * For `redirect`: the path this one moved to. The middleware answers the old
   * path with a 301 to it. A handler that predates `redirect` refuses it per
   * page as "Invalid action" and writes nothing, so a plugin that sends one
   * to an old edge logs a failure rather than losing the move silently.
   */
  to?: string;
  post_type?: string;
  post_id?: number;
  /**
   * The post's `modified_gmt`, and the ordering key for this path.
   *
   * Optional only so a plugin that predates it keeps working; when absent the
   * write proceeds unordered, which is the old behaviour and is recorded as
   * such in the result.
   */
  version?: string;
}

export interface PageResult {
  path: string;
  action: string;
  size?: number;
  error?: string;
  /**
   * Set when nothing was written and that is correct.
   *
   * `stale`    a newer version is already stored.
   * `declined` the site's transform said it does not cache this path. A feed or
   *            a sitemap is not a page, and a site that serves them another way
   *            — a redirect, a rebuild — must be able to say so without the
   *            push being reported as broken. Before this, declining meant
   *            throwing, every publish logged two errors, and a real failure had
   *            to be spotted among them.
   */
  skipped?: 'stale' | 'declined';
  /** For `render`: the SHA-256 the page would be stored under. */
  hash?: string;
  /**
   * Set when the page stored (or rendered) tells search engines not to index
   * it. Reported, not refused: a page an owner hid on purpose is correct.
   * The plugin reads it for two things — a page WordPress says is noindex is
   * left out of the sitemap, and a home page that is noindex is almost always
   * "Discourage search engines" left ticked, which is worth a warning.
   */
  noindex?: true;
}

/**
 * Does this page's robots meta say `noindex` (or `none`, which includes it)?
 *
 * Plain string work, like the rest of the runtime: every `<meta>` whose name
 * is `robots` or `googlebot`, attributes in either order.
 */
export function robotsNoindex(html: string): boolean {
  for (const [tag] of html.matchAll(/<meta\b[^>]*>/gi)) {
    if (!/\bname\s*=\s*["']?(?:robots|googlebot)["'\s/>]/i.test(tag)) continue;
    const content = /\bcontent\s*=\s*(["'])(.*?)\1/i.exec(tag)?.[2] ?? '';
    if (/(?:^|[\s,])(?:noindex|none)(?:$|[\s,])/i.test(content)) return true;
  }
  return false;
}

/**
 * Site-supplied HTML transform: WordPress response in, storable HTML out.
 *
 * Returning `null` means "this site does not cache this path", which is a
 * decision, not a failure. Throwing still means the transform could not do its
 * job and the path is reported as an error.
 */
export type HtmlTransform = (
  response: Response,
  spec: { path: string; sourceOrigin: string; postType?: string; postId?: number }
) => Promise<string | null>;

export interface UpdatePageOptions {
  transform: HtmlTransform;
  /** Updates allowed per IP per minute. */
  rateLimit?: number;
  /** Pages accepted in one bulk request. */
  maxBulk?: number;
  /** How long one page's fetch from WordPress may take before it is that page's error. */
  fetchTimeoutMs?: number;
}

/**
 * `fetchTimeoutMs` and `concurrency` against the plugin's 15-second client
 * timeout (review of 2026-09-28). Twenty pages were fetched one after
 * another with no deadline: at a second a page the plugin gave up at page
 * fifteen and recorded all twenty as failed while the edge went on writing
 * them. Three at a time makes twenty pages seven rounds — seven seconds at a
 * second a page — and ten seconds is the most one page may add; three stays
 * well inside the six connections a Worker may hold open at once.
 */
const DEFAULTS = { rateLimit: 10, maxBulk: 20, windowMs: 60_000, fetchTimeoutMs: 10_000, concurrency: 3 };

/**
 * The longest path (and redirect target) accepted, in characters.
 *
 * A KV key is at most 512 bytes. `isValidPath` admits only ASCII, so a
 * character is a byte, and `normalizePath` adds at most `/index.html`. A path
 * past this reached KV and threw there, which took the whole bulk request
 * down with it (review of 2026-09-28). WordPress permalinks are nowhere near.
 */
export const MAX_PATH_LENGTH = 480;

/*
 * The per-isolate rate limit is createLimiter (lib/rate-limit.ts): a blunt cap
 * on a runaway plugin, not a global guarantee — the endpoint is authenticated,
 * and that is what protects it. The copy that lived here until 2026-09-28
 * kept every key it had ever seen for the isolate's whole life.
 */

/** Reject traversal, anything outside a safe URL path shape, and anything longer than a KV key. */
export function isValidPath(path: unknown): path is string {
  // A number or null in a bulk request threw here, outside any per-page
  // handling, and failed the request.
  if (typeof path !== 'string' || path.length > MAX_PATH_LENGTH) return false;
  if (!path.startsWith('/') || path.includes('..')) return false;

  /*
   * Unreserved characters, '/', and well-formed percent-escapes.
   *
   * The previous character class had no '%' in it, so every accented or
   * non-Latin slug — WordPress percent-encodes them in the permalink — came
   * back as `Invalid path`, per path, on every publish, forever. On a French
   * site that is most of the content, and because the bulk branch reports it
   * per path rather than failing the request, it was silent drift rather than
   * a visible error.
   *
   * A bare '%' or a truncated escape is still rejected: it cannot be resolved
   * to one KV key, so accepting it would store a page nobody can fetch. This
   * runs before the decode below, so decodeURIComponent cannot throw.
   */
  if (!/^\/(?:[A-Za-z0-9\-._~/]|%[0-9A-Fa-f]{2})*$/.test(path)) return false;

  // Traversal must not become reachable by spelling it '%2e%2e'. KV is flat, so
  // nothing escapes today — but this function is the gate a future caller that
  // does touch a filesystem would inherit, and WordPress never emits it anyway.
  return !decodeURIComponent(path).includes('..');
}

/**
 * Is `sourceUrl` really on `sourceOrigin`?
 *
 * Compares parsed origins. The site implementation used
 * `sourceUrl.startsWith(sourceDomain)`, which accepts
 * `https://ia.example.com.attacker.test/evil` — the Worker would then fetch
 * attacker-controlled HTML and write it into the site's own page cache under
 * a path the attacker chose. On an authenticated endpoint that is a smaller
 * hole than it looks, but it is still a content-injection primitive and the
 * string check buys nothing over parsing.
 */
export function isSameOrigin(sourceUrl: string, sourceOrigin: string): boolean {
  try {
    return new URL(sourceUrl).origin === new URL(sourceOrigin).origin;
  } catch {
    return false;
  }
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json' },
  });

/**
 * SHA-256 of the stored HTML, hex.
 *
 * Lets the nightly reconciliation diff by comparing hashes instead of
 * re-fetching and re-uploading every page, which is what keeps a nightly full
 * rebuild cheap enough to actually run every night.
 */
async function contentHash(html: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(html));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Is the incoming version older than what is already stored?
 *
 * **The rule the protocol calls "refuse to go backwards".** Two edits in quick
 * succession produce two pushes; the plugin debounces and dispatches out of
 * band, and a retried or merely slow first request can land after the second.
 * Without this the edge silently reverts to the older content, and it presents
 * as a WordPress bug — which is where the debugging time goes.
 *
 * Compared as time, not as strings, because `modified_gmt` is emitted in more
 * than one format across WordPress versions and a lexical compare on mixed
 * formats is wrong in exactly the cases that matter.
 *
 * An absent version on either side means "unordered", and the write proceeds:
 * a plugin older than this field must keep working, and refusing its writes
 * would be a worse failure than accepting a possible reorder.
 */
export function isStale(incoming?: string, stored?: string): boolean {
  if (!incoming || !stored) return false;
  const a = Date.parse(incoming);
  const b = Date.parse(stored);
  if (Number.isNaN(a) || Number.isNaN(b)) return false;
  return a < b;
}

/**
 * The path a page's relative references resolve against. The build serves
 * `/blog/post` as `/blog/post/index.html`, so a push that names it without the
 * trailing slash must resolve `style.css` in `/blog/post/`, as the build did,
 * not one directory up.
 */
function directoryPath(path: string): string {
  const last = path.split('/').pop() ?? '';
  return path.endsWith('/') || last.includes('.') ? path : `${path}/`;
}

/**
 * The absolute spellings of this site a pushed page may carry: its public
 * address (`ALLOWED_ORIGIN`, the same value the Workers front door passes the
 * default transform as `siteUrl`), the address this request arrived on, and the
 * WordPress origin, for a transform that left it in place.
 */
function siteOrigins(env: UpdatePageEnv, requestUrl: string): string[] {
  const found = new Set<string>();
  for (const value of String(env.ALLOWED_ORIGIN || '').split(',')) {
    if (value.trim() && value.trim() !== '*') found.add(value.trim());
  }
  try { found.add(new URL(requestUrl).origin); } catch { /* a Request always has one */ }
  if (env.WP_SOURCE) found.add(env.WP_SOURCE);
  return [...found];
}

/** Is a newer version than this push's already stored at `key`? Logged when it is. */
async function refusedAsStale(env: UpdatePageEnv, key: string, page: PageSpec): Promise<boolean> {
  if (!page.version) return false;
  const existing = await env.PAGES_CACHE.getWithMetadata<{ version?: string }>(key);
  if (!isStale(page.version, existing?.metadata?.version)) return false;
  console.warn(
    `[update-page] refused stale ${page.action} for ${page.path}: ` +
    `incoming ${page.version} is older than stored ${existing?.metadata?.version}`
  );
  return true;
}

/** Everything a fetch needs beyond the page: the transform, the versioning, the deadline. */
interface ApplyContext {
  transform: HtmlTransform;
  versioning: Versioning | null;
  fetchTimeoutMs: number;
}

/**
 * One page, and whatever happens to it is that page's result.
 *
 * **The whole of it is inside the try** (review of 2026-09-28). The remove,
 * redirect and ordering branches used to run before it, so any KV exception
 * there — a redirect whose metadata was over KV's 1 KiB limit, a transient
 * error — escaped the page, failed the bulk request with a 500 after some
 * pages were written and before the rest were tried, and the plugin read
 * every page as failed. A page's error is now in its own result, and the
 * plugin (`Publisher::read_bulk_response`) logs each one by path.
 */
async function applyOne(env: UpdatePageEnv, page: PageSpec, context: ApplyContext): Promise<PageResult> {
  try {
    return await applyOneUnguarded(env, page, context);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    if (!(error instanceof WpOriginError)) console.error(`[update-page] ${page.action} ${page.path} failed: ${message}`);
    return { path: page.path, action: 'error', error: message };
  }
}

async function applyOneUnguarded(env: UpdatePageEnv, page: PageSpec, context: ApplyContext): Promise<PageResult> {
  const { transform, versioning, fetchTimeoutMs } = context;
  // normalizePath is imported from _middleware on purpose: this writes the KV
  // key the middleware reads. Two copies that drift means cached pages stop
  // being served, silently.
  const key = normalizePath(page.path);

  if (page.action === 'remove') {
    /*
     * Ordered like a write, when the plugin says when it asked (review of
     * 2026-09-28). A remove deleted whatever was stored, so a slow unpublish
     * that landed after the post was published again took the new page down,
     * silently, until the next build. The plugin sends its dispatch time as
     * `version`; a remove without one — an older plugin — deletes as before.
     * Nothing is left behind: no tombstone, so a later update with any
     * version still writes.
     */
    if (await refusedAsStale(env, key, page)) return { path: page.path, action: 'skipped', skipped: 'stale' };
    await env.PAGES_CACHE.delete(key);
    return { path: page.path, action: 'removed' };
  }

  if (page.action === 'redirect') {
    // A path on this site. `//host/x` passes isValidPath — it starts with a
    // slash — and a browser reads it as another site: an open redirect.
    // isValidPath also caps its length: `to` is stored in the metadata below,
    // which KV limits to 1 KiB.
    if (!page.to || !isValidPath(page.to) || page.to.startsWith('//')) {
      return { path: page.path, action: 'error', error: 'redirect needs a valid "to" path' };
    }
    if (normalizePath(page.to) === key) {
      return { path: page.path, action: 'error', error: 'a path cannot redirect to itself' };
    }
    // Ordered like a page: a slow push of an older move must not undo a newer
    // one — nor replace a page republished at this path since.
    if (await refusedAsStale(env, key, page)) return { path: page.path, action: 'skipped', skipped: 'stale' };
    const body = redirectEntry(page.to);
    await env.PAGES_CACHE.put(key, body, {
      metadata: {
        updatedAt: new Date().toISOString(),
        postId: page.post_id,
        postType: page.post_type,
        version: page.version,
        // Read by reconcile and by the post-deploy refresh, which list keys
        // with their metadata and never their bodies: a redirect is not a page
        // to compare, nor one to overwrite with the build's copy.
        redirect: page.to,
        hash: await contentHash(body),
      },
    });
    return { path: page.path, action: 'redirected' };
  }

  if (!env.WP_SOURCE) {
    return { path: page.path, action: 'error', error: 'WP_SOURCE is not configured' };
  }
  if (!page.source_url) {
    return { path: page.path, action: 'error', error: 'source_url required for update' };
  }
  if (!isSameOrigin(page.source_url, env.WP_SOURCE)) {
    return { path: page.path, action: 'error', error: 'source_url must be on the configured WP_SOURCE origin' };
  }

  /*
   * Ordering is decided before the fetch, not after.
   *
   * A stale push is one we are going to discard, so fetching the page from
   * WordPress first would spend a round trip on the origin to produce bytes
   * nobody stores — and the pushes most likely to be stale are the retried
   * ones, which is exactly when the origin is already struggling.
   */
  // A render stores nothing, so there is nothing for ordering to protect.
  const renderOnly = page.action === 'render';

  if (!renderOnly && await refusedAsStale(env, key, page)) {
    return { path: page.path, action: 'skipped', skipped: 'stale' };
  }

  // Never follows redirects: a staging WordPress that redirects
  // unauthenticated traffic to production would otherwise have us cache the
  // live static page back over itself. See lib/wp-fetch.ts. Whatever throws
  // from here on — a refusal, the deadline, the transform, KV — is this
  // page's error, by applyOne.
  const upstream = await fetchFromWordPress(page.source_url, env, {
    headers: { Accept: 'text/html' },
  }, { timeoutMs: fetchTimeoutMs });
  if (!upstream.ok) {
    return { path: page.path, action: 'error', error: `HTTP ${upstream.status} from source` };
  }

  const transformed = await transform(upstream, {
    path: page.path,
    sourceOrigin: env.WP_SOURCE,
    postType: page.post_type,
    postId: page.post_id,
  });

  /*
   * The site declined this path. Nothing is written and nothing is wrong:
   * a feed or a sitemap is not a page, and a site that serves them by
   * redirect or rebuilds them elsewhere says so here. Reported so the
   * publisher can count it apart from both a delivery and a failure.
   */
  if (transformed === null) {
    return { path: page.path, action: 'skipped', skipped: 'declined' };
  }

  // After the site's transform, whatever it is, so every site gets the same
  // URLs its build wrote. Without this a pushed page links `style.css?ver=1.0`
  // — the theme's version, not the file's — which `_headers` caches as
  // immutable for a year, and a restyle never reaches that visitor.
  const html = versioning
    ? versionHtml(transformed, { pagePath: directoryPath(page.path), lookup: versioning.lookup, origins: versioning.origins })
    : transformed;

  // Everything above is exactly what a write does, which is the point: the
  // hash is the one `put` below would record.
  const noindex = robotsNoindex(html) ? { noindex: true as const } : {};
  if (renderOnly) {
    return { path: page.path, action: 'rendered', size: html.length, hash: await contentHash(html), ...noindex };
  }

  await env.PAGES_CACHE.put(key, html, {
    metadata: {
      updatedAt: new Date().toISOString(),
      postId: page.post_id,
      postType: page.post_type,
      version: page.version,
      // A content hash, so the nightly reconciliation can diff by comparing
      // hashes instead of re-fetching and re-uploading every page. That is
      // what keeps a nightly full rebuild cheap enough to actually run.
      hash: await contentHash(html),
    },
  });

  return { path: page.path, action: 'updated', size: html.length, ...noindex };
}

/**
 * `run` over `items`, at most `limit` at a time, results in the order given.
 *
 * Items that share a `keyOf` run one after another, in the order given:
 * a batch that names one KV key twice (`/about` and `/about/` are one key)
 * was written in order when the loop was sequential, and must still be.
 */
async function mapBounded<T, R>(
  items: T[],
  limit: number,
  keyOf: (item: T) => string | null,
  run: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const lastForKey = new Map<string, Promise<unknown>>();
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      const item = items[index];
      const key = keyOf(item);
      // Items are taken in order, so the one this waits for was taken
      // earlier and is already running: no slot waits on a queued item.
      const before = key === null ? undefined : lastForKey.get(key);
      const done = (async () => {
        if (before) await before.catch(() => {});
        results[index] = await run(item);
      })();
      if (key !== null) lastForKey.set(key, done);
      await done;
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export function createUpdatePageOptionsHandler(): PagesFunction<UpdatePageEnv> {
  return async (context) => {
    const origin = getResponseOrigin(
      context.request, context.env.ALLOWED_ORIGIN, context.env.PAGES_PROJECT
    );
    return new Response(null, { headers: corsHeaders(origin, 'POST, OPTIONS') });
  };
}

/**
 * The handler. Build it **once** per isolate — at module scope on Pages — and
 * reuse it: the rate limiter lives here, and a handler built per request has a
 * fresh, empty one every time. That is how the Workers front door disabled it
 * until 2026-09-28 (it now keeps one handler per site; see worker-entry.ts).
 */
export function createUpdatePageHandler(options: UpdatePageOptions): PagesFunction<UpdatePageEnv> {
  const maxBulk = options.maxBulk ?? DEFAULTS.maxBulk;
  const allow = createLimiter(options.rateLimit ?? DEFAULTS.rateLimit, DEFAULTS.windowMs);
  const fetchTimeoutMs = options.fetchTimeoutMs ?? DEFAULTS.fetchTimeoutMs;

  return async (context) => {
    // Read once. A signature covers the raw bytes, and a Request body can only
    // be consumed once — so the handler parses this string rather than calling
    // .json(), which would throw here and read as a wrong secret.
    const rawBody = await context.request.text();

    // Bearer allowed: update-page is one of the three calls the per-site
    // plugins that predate signing make. The reason for a refusal goes to the
    // log (the auth layer writes it), never to the caller: naming the failed
    // check tells whoever is guessing how to make progress.
    const auth = await authenticateSync(
      context.request, rawBody, context.env.SYNC_SECRET, nonceChecker(context.env.DB),
      { allowBearer: true, endpoint: 'update-page', minVersion: context.env.SIGNATURE_MIN_VERSION }
    );
    if (!auth.ok) {
      const { body, status } = refusal(auth);
      return json(body, status);
    }

    const ip = context.request.headers.get('CF-Connecting-IP') || 'unknown';
    if (!allow(ip)) {
      return json({ error: 'Rate limit exceeded.' }, 429);
    }

    try {
      // Omit, not intersect: `PageSpec & { action: ... | 'bulk' }` narrows the
      // union back to 'update' | 'remove' and makes the bulk branch dead code.
      const body = JSON.parse(rawBody) as Omit<PageSpec, 'action'> & {
        action: 'update' | 'remove' | 'render' | 'redirect' | 'bulk';
        pages?: PageSpec[];
      };

      // Read once per request, not per page: one manifest serves a bulk push.
      const { lookup, status: assetVersions } = await loadAssetVersions(context.env.ASSETS, context.request.url);
      if (assetVersions.state === 'unreadable') {
        console.warn(`[update-page] ${ASSET_MANIFEST} is unreadable (${assetVersions.reason}); pages go out unversioned`);
      }
      const versioning: Versioning | null = lookup
        ? { lookup, origins: siteOrigins(context.env, context.request.url) }
        : null;
      const apply: ApplyContext = { transform: options.transform, versioning, fetchTimeoutMs };

      if (body.action === 'bulk') {
        if (!Array.isArray(body.pages) || body.pages.length === 0) {
          return json({ error: 'pages array required for bulk action' }, 400);
        }
        if (body.pages.length > maxBulk) {
          return json({ error: `Maximum ${maxBulk} pages per bulk request` }, 400);
        }

        // JSON is whatever the sender wrote: a page may be null or a number,
        // and one such page must be that page's error, not the request's.
        const pages = body.pages as unknown[];
        const valid = (page: unknown): page is PageSpec =>
          typeof page === 'object' && page !== null && isValidPath((page as PageSpec).path);

        const results = await mapBounded<unknown, PageResult>(
          pages,
          DEFAULTS.concurrency,
          (page) => (valid(page) ? normalizePath(page.path) : null),
          async (page) => {
            if (!valid(page)) {
              const path = typeof page === 'object' && page !== null ? (page as { path?: unknown }).path : undefined;
              return { path: typeof path === 'string' && path ? path.slice(0, MAX_PATH_LENGTH) : '(missing)', action: 'error', error: 'Invalid path' };
            }
            if (!['update', 'remove', 'render', 'redirect'].includes(page.action)) {
              return { path: page.path, action: 'error', error: 'Invalid action' };
            }
            return applyOne(context.env, page, apply);
          }
        );

        return json({
          success: true, action: 'bulk', results,
          total: results.length, errors: results.filter((r) => r.error).length,
          assetVersions,
        });
      }

      if (!body.path || !isValidPath(body.path)) return json({ error: 'Valid path required' }, 400);
      if (body.action !== 'update' && body.action !== 'remove' && body.action !== 'render' && body.action !== 'redirect') {
        return json({ error: 'action must be "update", "remove", "render", "redirect", or "bulk"' }, 400);
      }

      const result = await applyOne(context.env, { ...body, action: body.action }, apply);
      return result.error
        ? json({ success: false, ...result, assetVersions }, 500)
        : json({ success: true, ...result, assetVersions });
    } catch (error) {
      console.error('[update-page] failed:', error);
      return json({
        error: 'Update failed',
        detail: error instanceof Error ? error.message : 'Unknown error',
      }, 500);
    }
  };
}
