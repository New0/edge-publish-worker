/**
 * Search index and sitemap updater — shared Pages Function.
 *
 * Called by the WordPress companion plugin on publish. Maintains the KV search
 * index and, on request, rebuilds the sitemap into PAGES_CACHE where
 * _middleware serves it.
 *
 * Authenticated by signature, falling back to a bearer token for the per-site
 * plugins that predate signing. See the `ews-sync-protocol` skill.
 */

import { authenticateSync, nonceChecker, refusal } from '../lib/auth.js';
import { corsHeaders, getResponseOrigin, primaryOrigin } from '../lib/cors.js';
import { normalizePath } from '../_middleware.js';

export interface UpdateIndexEnv {
  SEARCH_INDEX: KVNamespace;
  PAGES_CACHE: KVNamespace;
  SYNC_SECRET: string;
  /** '2' refuses a request signed v1 only; unset or anything else accepts it, logged (2026-09-29). */
  SIGNATURE_MIN_VERSION?: string;
  /** Absolute site origin used to build sitemap <loc> values, e.g. "https://example.com". */
  ALLOWED_ORIGIN: string;
  PAGES_PROJECT?: string;
  /** Where signature nonces are recorded; see `UpdatePageEnv.DB`. */
  DB: D1Database;
  /**
   * The static build. The sitemap rebuild starts from the build's own
   * sitemap, which lists what the crawl found — home, archives, pages — and
   * not only the posts the search index holds.
   */
  ASSETS?: { fetch: (request: Request) => Promise<Response> };
}

export interface SearchEntry {
  id: number;
  type: string;
  title: string;
  url: string;
  excerpt: string;
  content: string;
  /** When it was first published. */
  date: string;
  /**
   * When it last changed — the sitemap's `<lastmod>`. Plugins before
   * 2026-09-26 sent only `date`, so an edit moved nothing and the sitemap
   * told crawlers a page updated today had not changed since it was written.
   */
  modified?: string;
  /**
   * The page as stored at the edge says `noindex`. It stays in the site's own
   * search, and leaves the sitemap: a sitemap that lists pages the pages
   * themselves refuse is a contradiction search consoles report.
   */
  noindex?: boolean;
}

export interface UpdateIndexBody {
  action: 'add' | 'remove' | 'rebuild-sitemap';
  entry?: SearchEntry;
  url?: string;
}

const INDEX_KEY = 'search-index';
const SITEMAP_KEY = 'sitemap.xml';
/**
 * Paths unpublished since the build, in SEARCH_INDEX beside the index: the
 * build's sitemap still lists them, and without a record of the removal a
 * rebuilt sitemap would keep advertising a page that is gone.
 */
const REMOVED_KEY = 'sitemap-removed';
const MAX_REMOVED = 1000;

/**
 * A sitemap `<lastmod>`: the date part of a W3C datetime, or nothing.
 *
 * A malformed one is worse than none — one site's older copy of this endpoint
 * wrote `2011-08-17 18:32:55`, which no parser accepts — so anything that does
 * not start with a calendar date is dropped rather than passed on.
 */
export function lastmodOf(value?: string): string | undefined {
  const day = /^(\d{4}-\d{2}-\d{2})(?:$|[T\s])/.exec(String(value ?? '').trim())?.[1];
  if (!day) return undefined;
  // A real calendar day: Date.parse rolls `2026-02-30` over into March
  // rather than refusing it, so the day is checked by writing it back.
  const parsed = new Date(`${day}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === day ? day : undefined;
}

/**
 * The home page is never removed from the sitemap.
 *
 * Until 2026-09-26 unpublishing a post removed `/` here: the plugin asked
 * WordPress for the permalink of a post no longer published, WordPress
 * answered `?p=ID`, and its path is `/`. Every rebuilt sitemap from then on
 * left the home page out. The plugin no longer sends it; this refuses it, and
 * ignores it in a list written before the fix, so an affected site repairs
 * itself at its next rebuild.
 */
const isHome = (urlOrPath: string) => sitemapKey(urlOrPath) === '/';

export function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Build a sitemap from index entries.
 *
 * Exported for testing: the escaping and the absolute-URL construction are the
 * parts that break, and both are cheap to pin.
 */
export function generateSitemap(entries: SearchEntry[], siteOrigin: string): string {
  const origin = siteOrigin.replace(/\/$/, '');
  const urls = entries
    .filter((e) => !e.noindex)
    .map((e) => {
      const loc = escapeXml(`${origin}${e.url}`);
      const day = lastmodOf(e.modified) ?? lastmodOf(e.date);
      const lastmod = day ? `\n    <lastmod>${escapeXml(day)}</lastmod>` : '';
      return `  <url>\n    <loc>${loc}</loc>${lastmod}\n  </url>`;
    })
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>`;
}

/** A URL or a path as the comparison key: the path, without its trailing slash. */
export function sitemapKey(urlOrPath: string): string {
  let pathname = urlOrPath;
  try { pathname = new URL(urlOrPath, 'https://x.invalid').pathname; } catch { /* keep as given */ }
  return pathname === '/' ? '/' : pathname.replace(/\/+$/, '');
}

/** `<loc>` and `<lastmod>` of each `<url>` in a sitemap. Plain string work, like the rest of the runtime. */
export function parseSitemap(xml: string): Array<{ path: string; lastmod?: string }> {
  const out: Array<{ path: string; lastmod?: string }> = [];
  for (const [, block] of xml.matchAll(/<url>([\s\S]*?)<\/url>/g)) {
    const loc = /<loc>\s*([^<\s]+)\s*<\/loc>/.exec(block)?.[1];
    if (!loc) continue;
    let path = loc.replace(/&amp;/g, '&');
    try { const u = new URL(path); path = u.pathname + u.search; } catch { /* already a path */ }
    const lastmod = /<lastmod>\s*([^<\s]+)\s*<\/lastmod>/.exec(block)?.[1];
    out.push({ path, ...(lastmod ? { lastmod } : {}) });
  }
  return out;
}

/**
 * The sitemap as it should be now: what the build listed, minus what has been
 * unpublished since, plus every post and page the index holds.
 *
 * Until 2026-09-21 the rebuild used the index alone, so a rebuilt sitemap
 * lost the home page and every archive — on the proving site, five URLs became
 * two. The build is the complete list as of its crawl; the index and the
 * removals are what the plugin has said since.
 *
 * A build path without an extension gets its trailing slash back: builds made
 * before the engine kept it listed `/about`, which a static host answers with
 * a redirect to `/about/`.
 */
export function mergeSitemap(
  build: Array<{ path: string; lastmod?: string }>,
  index: SearchEntry[],
  removed: string[],
): Array<{ path: string; lastmod?: string }> {
  const gone = new Set(removed.filter((p) => !isHome(p)).map(sitemapKey));
  const merged = new Map<string, { path: string; lastmod?: string }>();
  for (const entry of build) {
    const key = sitemapKey(entry.path);
    if (gone.has(key)) continue;
    const isFileOrQuery = /\.[a-z0-9]+$/i.test(key) || entry.path.includes('?');
    const path = key === '/' ? '/' : isFileOrQuery ? entry.path : `${key}/`;
    const lastmod = lastmodOf(entry.lastmod);
    merged.set(key, { path, ...(lastmod ? { lastmod } : {}) });
  }
  for (const entry of index) {
    if (!entry.url) continue;
    const key = sitemapKey(entry.url);
    // Noindex now, whatever the build listed then.
    if (entry.noindex) {
      merged.delete(key);
      continue;
    }
    const lastmod = lastmodOf(entry.modified) ?? lastmodOf(entry.date);
    merged.set(key, { path: entry.url, ...(lastmod ? { lastmod } : {}) });
  }
  return [...merged.values()];
}

/** Write a merged list as a sitemap document. */
export function renderSitemap(entries: Array<{ path: string; lastmod?: string }>, siteOrigin: string): string {
  const origin = siteOrigin.split(',')[0].trim().replace(/\/$/, '');
  const urls = entries
    .map((e) => {
      const loc = escapeXml(`${origin}${e.path}`);
      const lastmod = e.lastmod ? `\n    <lastmod>${escapeXml(e.lastmod)}</lastmod>` : '';
      return `  <url>\n    <loc>${loc}</loc>${lastmod}\n  </url>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>`;
}

async function readRemoved(env: UpdateIndexEnv): Promise<string[]> {
  try {
    const parsed = JSON.parse((await env.SEARCH_INDEX.get(REMOVED_KEY)) || '[]');
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === 'string') : [];
  } catch {
    return [];
  }
}

async function writeRemoved(env: UpdateIndexEnv, paths: string[]): Promise<void> {
  await env.SEARCH_INDEX.put(REMOVED_KEY, JSON.stringify([...new Set(paths)].slice(-MAX_REMOVED)));
}

/** The deployed build's sitemap, or nothing — the rebuild then falls back to the index. */
async function readBuildSitemap(env: UpdateIndexEnv, requestUrl: string): Promise<Array<{ path: string; lastmod?: string }> | null> {
  if (!env.ASSETS) return null;
  try {
    const response = await env.ASSETS.fetch(new Request(new URL('/sitemap.xml', requestUrl).toString()));
    if (!response.ok) return null;
    const entries = parseSitemap(await response.text());
    return entries.length ? entries : null;
  } catch {
    return null;
  }
}

/**
 * The stored index is there and cannot be read as one.
 *
 * Its own type so the handler can refuse with a message that names the key,
 * rather than the generic "Index update failed".
 */
class CorruptIndexError extends Error {}

/**
 * The index, or `[]` when there is none yet.
 *
 * **Absent and unreadable are different answers.** Until 2026-09-28 bad JSON
 * also came back as `[]`, "so a corrupt index must not take the endpoint
 * down" — and the next `add` then wrote an index of one entry over every
 * other post on the site, with nothing logged. Refusing keeps the stored
 * value for someone to look at, and every publish says so until they do.
 */
async function readIndex(env: UpdateIndexEnv): Promise<SearchEntry[]> {
  const raw = await env.SEARCH_INDEX.get(INDEX_KEY);
  if (raw === null || raw === '') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new CorruptIndexError(
      `"${INDEX_KEY}" in SEARCH_INDEX is not valid JSON (${raw.length} characters: ` +
        `${error instanceof Error ? error.message : 'unparseable'}); refusing to overwrite it`
    );
  }
  if (!Array.isArray(parsed)) {
    throw new CorruptIndexError(`"${INDEX_KEY}" in SEARCH_INDEX is JSON but not a list; refusing to overwrite it`);
  }
  return parsed as SearchEntry[];
}

/**
 * The most of a post's text the index keeps, in UTF-16 code units.
 *
 * The plugin sends the full post, and the whole index is one KV value, which
 * KV caps at 25 MiB: a site of long posts reaches that and every `add` fails
 * from then on. Twenty thousand characters is several thousand words — more
 * than a search result's snippet or ranking needs — and keeps a thousand
 * posts well under the limit. Text past it is not searchable at the edge.
 */
export const MAX_CONTENT_CHARS = 20_000;

/** `content` cut to the cap, never through a surrogate pair. */
export function capContent(content: unknown): string {
  const text = typeof content === 'string' ? content : '';
  if (text.length <= MAX_CONTENT_CHARS) return text;
  const cut = text.slice(0, MAX_CONTENT_CHARS);
  // A high surrogate at the end is half a character: an emoji, or any
  // character outside the Basic Multilingual Plane. Drop it rather than
  // store a string that is not valid UTF-16.
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

/** The five named entities WordPress and SEO plugins write in a title, plus numeric ones. */
const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[name.toLowerCase()] ?? whole;
  });
}

/**
 * The title a stored page gives itself: its `og:title`, else its `<title>`.
 *
 * For a post or page whose WordPress title is empty — a home page, or a page
 * whose theme prints its own heading — the plugin sends `title: ''`. Until
 * 2026-10-28 that was refused with 400, so an edit to such a page never
 * reached the search index or the sitemap (one live site had five such pages,
 * the home among them). The page the edge stored a moment earlier says what its title
 * is, through whichever SEO plugin wrote its head.
 */
export function titleFromPage(html: string): string {
  const end = html.search(/<\/head>/i);
  const head = end === -1 ? html : html.slice(0, end);
  const og = /<meta\s[^>]*property=["']og:title["'][^>]*>/i.exec(head)?.[0];
  const ogContent = og ? /\scontent=(["'])(.*?)\1/i.exec(og)?.[2] : undefined;
  const title = ogContent ?? /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1] ?? '';
  return decodeEntities(title.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json' },
  });

export function createUpdateIndexOptionsHandler(): PagesFunction<UpdateIndexEnv> {
  return async (context) => {
    const origin = getResponseOrigin(
      context.request, context.env.ALLOWED_ORIGIN, context.env.PAGES_PROJECT
    );
    return new Response(null, { headers: corsHeaders(origin, 'POST, OPTIONS') });
  };
}

export function createUpdateIndexHandler(): PagesFunction<UpdateIndexEnv> {
  return async (context) => {
    // Read once: a signature covers the raw bytes, and a body can only be
    // consumed once. See the same note in update-page.ts.
    const rawBody = await context.request.text();

    // Bearer allowed for the per-site plugins that predate signing; the auth
    // layer logs refusals, and every request that still uses one.
    const auth = await authenticateSync(
      context.request, rawBody, context.env.SYNC_SECRET, nonceChecker(context.env.DB),
      { allowBearer: true, endpoint: 'update-index', minVersion: context.env.SIGNATURE_MIN_VERSION }
    );
    if (!auth.ok) {
      const { body, status } = refusal(auth);
      return json(body, status);
    }

    try {
      const body = JSON.parse(rawBody) as UpdateIndexBody;

      if (body.action === 'add') {
        if (body.entry?.url && !body.entry.title?.trim()) {
          // No title from WordPress: the stored page's own. See titleFromPage.
          const stored = await context.env.PAGES_CACHE.get(normalizePath(body.entry.url), 'text');
          body.entry.title = stored ? titleFromPage(stored) : '';
        }
        if (!body.entry?.url || !body.entry?.title) {
          return json({ error: 'entry with url and title required for add action, and the page stored at that url gives no title either' }, 400);
        }
        /*
         * Read, modify, write — and not atomic. Two `add`s that overlap each
         * read the same index and the second write drops the first's entry
         * (measured in review, 2026-09-28: two concurrent adds leave one),
         * and the lost entry is back only when that post is published again.
         * KV has no compare-and-swap to close it here; the real fix is one
         * row per URL (D1, or a key per entry), which changes how search
         * reads the index — a design change, not a patch. Recorded, not done.
         */
        const index = await readIndex(context.env);
        // Upsert by URL: replacing rather than appending is what keeps the
        // index from growing a duplicate on every republish.
        const next = index.filter((e) => e.url !== body.entry!.url);
        next.push({ ...body.entry, content: capContent(body.entry.content) });
        await context.env.SEARCH_INDEX.put(INDEX_KEY, JSON.stringify(next));
        // Republished: no longer a removal the sitemap must honour.
        const removed = await readRemoved(context.env);
        if (removed.some((p) => sitemapKey(p) === sitemapKey(body.entry!.url))) {
          await writeRemoved(context.env, removed.filter((p) => sitemapKey(p) !== sitemapKey(body.entry!.url)));
        }
        return json({ success: true, action: 'add', url: body.entry.url, indexSize: next.length });
      }

      if (body.action === 'remove') {
        if (!body.url) return json({ error: 'url required for remove action' }, 400);
        if (isHome(body.url)) return json({ error: 'the home page is not removed from the index or the sitemap' }, 400);
        // Recorded even when the index never held it: the build's sitemap may.
        // And before the index is read, so the removal is kept even while a
        // corrupt index refuses the rest of this request.
        await writeRemoved(context.env, [...(await readRemoved(context.env)), body.url]);
        const index = await readIndex(context.env);
        const next = index.filter((e) => e.url !== body.url);
        if (next.length === index.length) {
          return json({
            success: true, action: 'remove', url: body.url,
            message: 'Entry not found in index', indexSize: next.length,
          });
        }
        await context.env.SEARCH_INDEX.put(INDEX_KEY, JSON.stringify(next));
        return json({ success: true, action: 'remove', url: body.url, indexSize: next.length });
      }

      if (body.action === 'rebuild-sitemap') {
        const index = await readIndex(context.env);
        const removed = await readRemoved(context.env);
        const build = await readBuildSitemap(context.env, context.request.url);
        const entries = mergeSitemap(build ?? [], index, removed);
        // One origin: ALLOWED_ORIGIN may list several (apex and www.), and a
        // comma list inside every <loc> is not a URL.
        const sitemap = renderSitemap(entries, primaryOrigin(context.env.ALLOWED_ORIGIN));
        await context.env.PAGES_CACHE.put(SITEMAP_KEY, sitemap, {
          metadata: { updatedAt: new Date().toISOString(), type: 'sitemap' },
        });
        return json({
          success: true, action: 'rebuild-sitemap',
          entries: entries.length, fromBuild: build?.length ?? 0, fromIndex: index.length,
          removed: removed.length, size: sitemap.length,
          // Said, not hidden: without the build's list the sitemap is posts only.
          ...(build ? {} : { warning: 'The build has no readable sitemap.xml; this sitemap lists indexed posts only.' }),
        });
      }

      return json({ error: 'action must be "add", "remove", or "rebuild-sitemap"' }, 400);
    } catch (error) {
      if (error instanceof CorruptIndexError) {
        // Nothing was written to the index. Logged as an error, because it
        // stays refused until someone repairs it or a full rebuild replaces it.
        console.error(`[update-index] ${error.message}. Repair the stored value, or delete the key and the index starts again from the next publish.`);
        return json({ error: 'The search index is unreadable; nothing was written to it.', detail: error.message }, 500);
      }
      console.error('[update-index] failed:', error);
      // Authenticated endpoint, so echoing the detail aids the plugin author
      // without exposing anything to an anonymous caller.
      return json({
        error: 'Index update failed',
        detail: error instanceof Error ? error.message : 'Unknown error',
      }, 500);
    }
  };
}
