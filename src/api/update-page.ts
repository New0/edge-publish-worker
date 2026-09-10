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

import { authenticate } from '../lib/auth.js';
import { corsHeaders, getResponseOrigin } from '../lib/cors.js';
import { normalizePath } from '../_middleware.js';
import { fetchFromWordPress, WpOriginError, type WpOriginEnv } from '../lib/wp-fetch.js';

export interface UpdatePageEnv extends WpOriginEnv {
  PAGES_CACHE: KVNamespace;
  SYNC_SECRET: string;
  ALLOWED_ORIGIN: string;
  PAGES_PROJECT?: string;
}

export interface PageSpec {
  action: 'update' | 'remove';
  path: string;
  source_url?: string;
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
  /** Set when the write was refused because a newer version is already stored. */
  skipped?: 'stale';
}

/** Site-supplied HTML transform: WordPress response in, storable HTML out. */
export type HtmlTransform = (
  response: Response,
  spec: { path: string; sourceOrigin: string; postType?: string; postId?: number }
) => Promise<string>;

export interface UpdatePageOptions {
  transform: HtmlTransform;
  /** Updates allowed per IP per minute. */
  rateLimit?: number;
  /** Pages accepted in one bulk request. */
  maxBulk?: number;
}

const DEFAULTS = { rateLimit: 10, maxBulk: 20, windowMs: 60_000 };

/**
 * Per-isolate rate limiter. Cloudflare may run many isolates, so this is a
 * blunt-force cap rather than a global guarantee — it bounds a runaway plugin,
 * it does not bound a determined attacker. The endpoint is authenticated;
 * that is what actually protects it.
 */
function makeRateLimiter(max: number, windowMs: number) {
  const seen = new Map<string, { count: number; resetAt: number }>();
  return (key: string): boolean => {
    const now = Date.now();
    const entry = seen.get(key);
    if (!entry || now > entry.resetAt) {
      seen.set(key, { count: 1, resetAt: now + windowMs });
      return true;
    }
    if (entry.count >= max) return false;
    entry.count++;
    return true;
  };
}

/** Reject traversal and anything outside a safe URL path shape. */
export function isValidPath(path: string): boolean {
  return /^\/[a-zA-Z0-9\-_/.]*$/.test(path) && !path.includes('..');
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

async function applyOne(
  env: UpdatePageEnv, page: PageSpec, transform: HtmlTransform
): Promise<PageResult> {
  // normalizePath is imported from _middleware on purpose: this writes the KV
  // key the middleware reads. Two copies that drift means cached pages stop
  // being served, silently.
  const key = normalizePath(page.path);

  if (page.action === 'remove') {
    await env.PAGES_CACHE.delete(key);
    return { path: page.path, action: 'removed' };
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
  if (page.version) {
    const existing = await env.PAGES_CACHE.getWithMetadata<{ version?: string }>(key);
    if (isStale(page.version, existing?.metadata?.version)) {
      console.warn(
        `[update-page] refused stale write for ${page.path}: ` +
        `incoming ${page.version} is older than stored ${existing?.metadata?.version}`
      );
      return { path: page.path, action: 'skipped', skipped: 'stale' };
    }
  }

  try {
    // Never follows redirects: a staging WordPress that redirects
    // unauthenticated traffic to production would otherwise have us cache the
    // live static page back over itself. See lib/wp-fetch.ts.
    const upstream = await fetchFromWordPress(page.source_url, env, {
      headers: { Accept: 'text/html' },
    });
    if (!upstream.ok) {
      return { path: page.path, action: 'error', error: `HTTP ${upstream.status} from source` };
    }

    const html = await transform(upstream, {
      path: page.path,
      sourceOrigin: env.WP_SOURCE,
      postType: page.post_type,
      postId: page.post_id,
    });

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

    return { path: page.path, action: 'updated', size: html.length };
  } catch (error) {
    if (error instanceof WpOriginError) {
      return { path: page.path, action: 'error', error: error.message };
    }
    return {
      path: page.path, action: 'error',
      error: error instanceof Error ? error.message : 'Unknown fetch error',
    };
  }
}

export function createUpdatePageOptionsHandler(): PagesFunction<UpdatePageEnv> {
  return async (context) => {
    const origin = getResponseOrigin(
      context.request, context.env.ALLOWED_ORIGIN, context.env.PAGES_PROJECT
    );
    return new Response(null, { headers: corsHeaders(origin, 'POST, OPTIONS') });
  };
}

export function createUpdatePageHandler(options: UpdatePageOptions): PagesFunction<UpdatePageEnv> {
  const maxBulk = options.maxBulk ?? DEFAULTS.maxBulk;
  const allow = makeRateLimiter(options.rateLimit ?? DEFAULTS.rateLimit, DEFAULTS.windowMs);

  return async (context) => {
    if (!(await authenticate(context.request, context.env.SYNC_SECRET))) {
      return json({ error: 'Unauthorized' }, 401);
    }

    const ip = context.request.headers.get('CF-Connecting-IP') || 'unknown';
    if (!allow(ip)) {
      return json({ error: 'Rate limit exceeded.' }, 429);
    }

    try {
      // Omit, not intersect: `PageSpec & { action: ... | 'bulk' }` narrows the
      // union back to 'update' | 'remove' and makes the bulk branch dead code.
      const body = (await context.request.json()) as Omit<PageSpec, 'action'> & {
        action: 'update' | 'remove' | 'bulk';
        pages?: PageSpec[];
      };

      if (body.action === 'bulk') {
        if (!Array.isArray(body.pages) || body.pages.length === 0) {
          return json({ error: 'pages array required for bulk action' }, 400);
        }
        if (body.pages.length > maxBulk) {
          return json({ error: `Maximum ${maxBulk} pages per bulk request` }, 400);
        }

        const results: PageResult[] = [];
        for (const page of body.pages) {
          if (!page.path || !isValidPath(page.path)) {
            results.push({ path: page.path || '(missing)', action: 'error', error: 'Invalid path' });
            continue;
          }
          if (!['update', 'remove'].includes(page.action)) {
            results.push({ path: page.path, action: 'error', error: 'Invalid action' });
            continue;
          }
          results.push(await applyOne(context.env, page, options.transform));
        }

        return json({
          success: true, action: 'bulk', results,
          total: results.length, errors: results.filter((r) => r.error).length,
        });
      }

      if (!body.path || !isValidPath(body.path)) return json({ error: 'Valid path required' }, 400);
      if (body.action !== 'update' && body.action !== 'remove') {
        return json({ error: 'action must be "update", "remove", or "bulk"' }, 400);
      }

      const result = await applyOne(
        context.env, { ...body, action: body.action }, options.transform
      );
      return result.error ? json({ success: false, ...result }, 500) : json({ success: true, ...result });
    } catch (error) {
      console.error('[update-page] failed:', error);
      return json({
        error: 'Update failed',
        detail: error instanceof Error ? error.message : 'Unknown error',
      }, 500);
    }
  };
}
