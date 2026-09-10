/**
 * CORS and origin validation for EdgeWPsync-driven sites.
 *
 * Site-agnostic: the production origin and the Pages preview host both arrive
 * as configuration. The site implementations this replaces hardcoded their own
 * preview suffix (`.newo-me.pages.dev`), which is exactly the kind of constant
 * that makes a file un-shareable.
 */

/**
 * Is `requestOrigin` allowed, given the site's configured origin and,
 * optionally, its Cloudflare Pages project name?
 *
 * Passing `pagesProject` admits that project's preview deployments
 * (`<project>.pages.dev` and `<hash>.<project>.pages.dev`). Omit it and only
 * the exact configured origin is allowed.
 */
export function isAllowedOrigin(
  requestOrigin: string,
  configuredOrigin: string,
  pagesProject?: string
): boolean {
  if (requestOrigin === configuredOrigin) return true;
  if (!pagesProject) return false;

  try {
    const { hostname } = new URL(requestOrigin);
    const root = `${pagesProject}.pages.dev`;
    // Exact project host, or a preview subdomain of it. The `.` prefix matters:
    // without it, `evil-newo-me.pages.dev` would match `newo-me.pages.dev`.
    return hostname === root || hostname.endsWith(`.${root}`);
  } catch {
    return false; // not a parseable URL
  }
}

/**
 * The value to send back in Access-Control-Allow-Origin. Echoes the request
 * origin when it is allowed, otherwise falls back to the configured origin —
 * never `*`, which would defeat the check entirely on a credentialed endpoint.
 */
export function getResponseOrigin(
  request: Request,
  configuredOrigin: string,
  pagesProject?: string
): string {
  const requestOrigin = request.headers.get('Origin');
  if (requestOrigin && isAllowedOrigin(requestOrigin, configuredOrigin, pagesProject)) {
    return requestOrigin;
  }
  return configuredOrigin;
}

export function corsHeaders(
  origin: string,
  methods = 'GET, POST, OPTIONS'
): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': methods,
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    Vary: 'Origin',
  };
}
