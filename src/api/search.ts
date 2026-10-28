/**
 * Search — shared Pages Function backed by a KV-stored index.
 *
 * Falls back to telling the client to use the static `search-index.json` when
 * no KV index is present, so search degrades rather than failing.
 */

import { getResponseOrigin, corsHeaders } from '../lib/cors.js';

export interface SearchEnv {
  SEARCH_INDEX: KVNamespace;
  /** The site's origin, or several comma-separated (lib/cors.ts). */
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

/*
 * What one query may cost. Each term is a substring scan of every entry's
 * content, so the work is terms × index size — and until 2026-09-28 neither
 * was bounded: a 16 KB query against a 3 MB index held the CPU for six
 * seconds. Nobody types more than a sentence into a search box.
 */
export const MAX_QUERY_CHARS = 200;
export const MAX_QUERY_TERMS = 10;

/*
 * How long a parsed index is reused. JSON.parse of a multi-megabyte index on
 * every request was most of a request's CPU. Nothing cheap marks a new index
 * — update-index and the build's upload write the one key without metadata
 * or a version — so a new index is picked up within this long instead. KV
 * itself already takes up to a minute to show a write in other locations, so
 * this at most doubles a delay that exists anyway.
 */
export const INDEX_TTL_MS = 60_000;

const INDEX_KEY = 'search-index';

/** Field weights. Title matches dominate; an exact title match dominates further. */
const WEIGHT = { title: 10, exactTitle: 20, excerpt: 5, content: 2 };

/**
 * A query's terms: lower-cased, longer than one character, each once. A word
 * repeated is one term, so repeating it neither multiplies the work nor
 * inflates the score.
 */
export function queryTerms(query: string): string[] {
  return [...new Set(query.toLowerCase().split(/\s+/).filter((t) => t.length > 1))];
}

/** An entry with the lower-cased text the ranking compares against. */
interface Prepared {
  entry: SearchEntry;
  title: string;
  content: string;
  excerpt: string;
}

/*
 * Lower-casing every entry's content was the other per-request cost. Done
 * once per parsed index instead, and keyed by the array itself: the cached
 * index is the same array from one request to the next, and an index nothing
 * holds any more takes its lower-cased copy with it.
 */
const prepared = new WeakMap<SearchEntry[], Prepared[]>();

function prepare(entries: SearchEntry[]): Prepared[] {
  let ready = prepared.get(entries);
  if (!ready) {
    ready = entries.map((entry) => ({
      entry,
      title: (entry.title || '').toLowerCase(),
      content: (entry.content || '').toLowerCase(),
      excerpt: (entry.excerpt || '').toLowerCase(),
    }));
    prepared.set(entries, ready);
  }
  return ready;
}

/**
 * Rank index entries against a query. Exported so it can be unit-tested
 * without a KV namespace — the ranking is the part worth testing.
 */
export function searchIndex(entries: SearchEntry[], query: string): SearchResult[] {
  const queryLower = query.toLowerCase();
  const terms = queryTerms(query);
  const results: SearchResult[] = [];

  for (const { entry, title, content, excerpt } of prepare(entries)) {
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

/*
 * The parsed index, per KV namespace. An isolate serves one site, so in
 * production this holds one entry; keying by the binding keeps two sites —
 * or two tests — from ever answering from each other's index.
 */
const indexCache = new WeakMap<KVNamespace, { entries: SearchEntry[] | null; at: number }>();

async function loadIndex(kv: KVNamespace): Promise<SearchEntry[] | null> {
  const now = Date.now();
  const cached = indexCache.get(kv);
  if (cached && now - cached.at < INDEX_TTL_MS) return cached.entries;

  const raw = await kv.get(INDEX_KEY);
  let entries: SearchEntry[] | null = null;
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      entries = Array.isArray(parsed) ? (parsed as SearchEntry[]) : null;
    } catch (error) {
      // A corrupt index degrades to the client-side search, as a missing one
      // does, and is re-read after the TTL — rather than re-parsed, and
      // failed, on every request.
      console.error('[search] the index in KV is not valid JSON:', error instanceof Error ? error.message : error);
    }
  }
  indexCache.set(kv, { entries, at: now });
  return entries;
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
  // Refused before the index is touched: see MAX_QUERY_CHARS.
  if (query.length > MAX_QUERY_CHARS) {
    return new Response(JSON.stringify({ error: `Search query too long (at most ${MAX_QUERY_CHARS} characters).` }), {
      status: 400, headers,
    });
  }
  if (queryTerms(query).length > MAX_QUERY_TERMS) {
    return new Response(JSON.stringify({ error: `Too many search terms (at most ${MAX_QUERY_TERMS}).` }), {
      status: 400, headers,
    });
  }

  try {
    const entries = context.env.SEARCH_INDEX ? await loadIndex(context.env.SEARCH_INDEX) : null;

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
