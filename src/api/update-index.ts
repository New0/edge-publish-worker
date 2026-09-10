/**
 * Search index and sitemap updater — shared Pages Function.
 *
 * Called by the WordPress companion plugin on publish. Maintains the KV search
 * index and, on request, rebuilds the sitemap into PAGES_CACHE where
 * _middleware serves it.
 *
 * Authenticated. See the `ews-sync-protocol` skill: the bearer token here is
 * replayable and is scheduled to move to HMAC with a timestamp and nonce.
 */

import { authenticate } from '../lib/auth.js';
import { corsHeaders, getResponseOrigin } from '../lib/cors.js';

export interface UpdateIndexEnv {
  SEARCH_INDEX: KVNamespace;
  PAGES_CACHE: KVNamespace;
  SYNC_SECRET: string;
  /** Absolute site origin used to build sitemap <loc> values, e.g. "https://example.com". */
  ALLOWED_ORIGIN: string;
  PAGES_PROJECT?: string;
}

export interface SearchEntry {
  id: number;
  type: string;
  title: string;
  url: string;
  excerpt: string;
  content: string;
  date: string;
}

export interface UpdateIndexBody {
  action: 'add' | 'remove' | 'rebuild-sitemap';
  entry?: SearchEntry;
  url?: string;
}

const INDEX_KEY = 'search-index';
const SITEMAP_KEY = 'sitemap.xml';

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
    .map((e) => {
      const loc = escapeXml(`${origin}${e.url}`);
      const lastmod = e.date ? `\n    <lastmod>${escapeXml(e.date.split('T')[0])}</lastmod>` : '';
      return `  <url>\n    <loc>${loc}</loc>${lastmod}\n  </url>`;
    })
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>`;
}

async function readIndex(env: UpdateIndexEnv): Promise<SearchEntry[]> {
  const raw = await env.SEARCH_INDEX.get(INDEX_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as SearchEntry[]) : [];
  } catch {
    // A corrupt index must not take the endpoint down; rebuild from empty.
    return [];
  }
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
    if (!(await authenticate(context.request, context.env.SYNC_SECRET))) {
      return json({ error: 'Unauthorized' }, 401);
    }

    try {
      const body = (await context.request.json()) as UpdateIndexBody;

      if (body.action === 'add') {
        if (!body.entry?.url || !body.entry?.title) {
          return json({ error: 'entry with url and title required for add action' }, 400);
        }
        const index = await readIndex(context.env);
        // Upsert by URL: replacing rather than appending is what keeps the
        // index from growing a duplicate on every republish.
        const next = index.filter((e) => e.url !== body.entry!.url);
        next.push(body.entry);
        await context.env.SEARCH_INDEX.put(INDEX_KEY, JSON.stringify(next));
        return json({ success: true, action: 'add', url: body.entry.url, indexSize: next.length });
      }

      if (body.action === 'remove') {
        if (!body.url) return json({ error: 'url required for remove action' }, 400);
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
        const sitemap = generateSitemap(index, context.env.ALLOWED_ORIGIN);
        await context.env.PAGES_CACHE.put(SITEMAP_KEY, sitemap, {
          metadata: { updatedAt: new Date().toISOString(), type: 'sitemap' },
        });
        return json({
          success: true, action: 'rebuild-sitemap',
          entries: index.length, size: sitemap.length,
        });
      }

      return json({ error: 'action must be "add", "remove", or "rebuild-sitemap"' }, 400);
    } catch (error) {
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
