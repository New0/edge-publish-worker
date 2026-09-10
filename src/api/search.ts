/**
 * Search — shared Pages Function backed by a KV-stored index.
 *
 * Falls back to telling the client to use the static `search-index.json` when
 * no KV index is present, so search degrades rather than failing.
 */

import { getResponseOrigin, corsHeaders } from '../lib/cors.js';

export interface SearchEnv {
  SEARCH_INDEX: KVNamespace;
  ALLOWED_ORIGIN: string;
  /** Cloudflare Pages project name, to admit preview deployments in CORS. */
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

export interface SearchResult {
  title: string;
  url: string;
  excerpt: string;
  score: number;
  type: string;
}

const MAX_RESULTS = 20;
const EXCERPT_CHARS = 150;

/** Field weights. Title matches dominate; an exact title match dominates further. */
const WEIGHT = { title: 10, exactTitle: 20, excerpt: 5, content: 2 };

/**
 * Rank index entries against a query. Exported so it can be unit-tested
 * without a KV namespace — the ranking is the part worth testing.
 */
export function searchIndex(entries: SearchEntry[], query: string): SearchResult[] {
  const queryLower = query.toLowerCase();
  const terms = queryLower.split(/\s+/).filter((t) => t.length > 1);
  const results: SearchResult[] = [];

  for (const entry of entries) {
    const title = entry.title.toLowerCase();
    const content = (entry.content || '').toLowerCase();
    const excerpt = (entry.excerpt || '').toLowerCase();

    let score = 0;
    for (const term of terms) {
      if (title.includes(term)) {
        score += WEIGHT.title;
        if (title === queryLower) score += WEIGHT.exactTitle;
      }
      if (excerpt.includes(term)) score += WEIGHT.excerpt;
      if (content.includes(term)) score += WEIGHT.content;
    }

    if (score > 0) {
      results.push({
        title: entry.title,
        url: entry.url,
        excerpt: entry.excerpt || `${(entry.content || '').substring(0, EXCERPT_CHARS)}...`,
        score,
        type: entry.type,
      });
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, MAX_RESULTS);
}

export const onRequestOptions: PagesFunction<SearchEnv> = async (context) => {
  const origin = getResponseOrigin(
    context.request, context.env.ALLOWED_ORIGIN, context.env.PAGES_PROJECT
  );
  return new Response(null, { headers: corsHeaders(origin, 'GET, OPTIONS') });
};

export const onRequestGet: PagesFunction<SearchEnv> = async (context) => {
  const origin = getResponseOrigin(
    context.request, context.env.ALLOWED_ORIGIN, context.env.PAGES_PROJECT
  );
  const headers = { ...corsHeaders(origin, 'GET, OPTIONS'), 'Content-Type': 'application/json' };

  const query = new URL(context.request.url).searchParams.get('q')?.trim();
  if (!query) {
    return new Response(JSON.stringify({ error: 'Search parameter missing.' }), {
      status: 400, headers,
    });
  }

  try {
    let entries: SearchEntry[] | null = null;
    if (context.env.SEARCH_INDEX) {
      const indexJson = await context.env.SEARCH_INDEX.get('search-index');
      if (indexJson) entries = JSON.parse(indexJson) as SearchEntry[];
    }

    if (entries) {
      const results = searchIndex(entries, query);
      return new Response(
        JSON.stringify({ query, results, total: results.length, source: 'server' }),
        { headers }
      );
    }

    return new Response(JSON.stringify({
      query, results: [], total: 0,
      message: 'Index not available. Use local search.',
      clientSearchUrl: '/search-index.json',
      source: 'fallback',
    }), { headers });
  } catch (error) {
    console.error('[search] failed:', error);
    return new Response(JSON.stringify({ error: 'Search failed.' }), { status: 500, headers });
  }
};
