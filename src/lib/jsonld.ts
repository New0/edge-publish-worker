/**
 * JSON-LD edits a static copy of a WordPress page needs.
 *
 * Twin of `src/transforms/jsonld.mjs`, which the build pipeline uses; the two
 * cannot share a file (this is TypeScript a site bundles, that is Node ESM),
 * so `src/tests/jsonld-parity.test.mjs` runs the same cases through both —
 * the pattern the four signature implementations already follow.
 */

/**
 * Remove every `SearchAction` from a JSON-LD body, and leave the rest alone.
 *
 * Yoast declares a site search at `/?s={search_term_string}`. A static host
 * ignores the query string, so the declaration promises search engines an
 * endpoint that returns the home page — and Google retired the sitelinks
 * search box it fed in 2024. Found live on both converted sites, 2026-09-18.
 *
 * Unparseable JSON is returned untouched: a page is never broken to remove a
 * declaration. `<` is escaped in the result so it cannot close its <script>.
 */
export function withoutSearchAction(json: string): string {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return json;
  }
  let changed = false;
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const record = node as Record<string, unknown>;
    if (record.potentialAction !== undefined) {
      const list = ([] as unknown[]).concat(record.potentialAction);
      const kept = list.filter((a) => !(a && typeof a === 'object' && (a as Record<string, unknown>)['@type'] === 'SearchAction'));
      if (kept.length !== list.length) {
        changed = true;
        if (kept.length === 0) delete record.potentialAction;
        else record.potentialAction = Array.isArray(record.potentialAction) ? kept : kept[0];
      }
    }
    Object.values(record).forEach(visit);
  };
  visit(data);
  return changed ? JSON.stringify(data).replace(/</g, '\\u003c') : json;
}

/** Apply `withoutSearchAction` to every JSON-LD block in a page. */
export function stripSearchActions(html: string): string {
  return html.replace(
    /(<script\b[^>]*type=["']application\/ld\+json["'][^>]*>)([\s\S]*?)(<\/script>)/gi,
    (_all, open: string, body: string, close: string) => open + withoutSearchAction(body) + close
  );
}
