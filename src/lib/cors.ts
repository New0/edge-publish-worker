/**
 * CORS and origin validation for EdgeWPsync-driven sites.
 *
 * Site-agnostic: the production origin and the Pages preview host both arrive
 * as configuration. The site implementations this replaces hardcoded their own
 * preview suffix (`.my-site.pages.dev`), which is exactly the kind of constant
 * that makes a file un-shareable.
 */

/*
 * `ALLOWED_ORIGIN`, read one way.
 *
 * It holds the site's origin, or several separated by commas — the apex and
 * the `www.` host, say, as StripeSiteEnv has always documented. Until
 * 2026-09-28 it was read two ways: checkout, account, portal and mail split it
 * and kept the first entry, while contact, form, comment, search and sync
 * compared the whole string. So a list made every contact, form and comment
 * post a 403 and put the comma string itself in Access-Control-Allow-Origin,
 * and a single value made checkout refuse the `www.` host. Every reader now
 * goes through `allowedOrigins` — account and portal only since 2026-10-28,
 * when a review found them still reading the first entry, so a `www.` buyer
 * could pay but never sign in or open billing.
 *
 * Parsed once per distinct value: an isolate sees one ALLOWED_ORIGIN for its
 * whole life, so a single remembered slot is enough and cannot grow.
 */
let parsedFrom: string | undefined;
let parsed: readonly string[] = Object.freeze([]);

/**
 * The origins ALLOWED_ORIGIN names, in the order it names them.
 *
 * Each entry is trimmed and reduced to its origin, so `https://a.test/` is
 * `https://a.test` — the form a browser's Origin header takes. An empty entry,
 * `*`, or anything that is not a URL is dropped: none of them can equal an
 * Origin header, and `*` must never reach Access-Control-Allow-Origin on an
 * endpoint that checks where a request came from.
 */
export function allowedOrigins(configured: unknown): readonly string[] {
  const raw = typeof configured === 'string' ? configured : '';
  if (raw === parsedFrom) return parsed;

  const list: string[] = [];
  for (const part of raw.split(',')) {
    const value = part.trim();
    if (!value || value === '*') continue;
    try {
      const { origin } = new URL(value);
      // `mailto:` and friends parse, with an opaque origin spelled "null".
      if (origin !== 'null' && !list.includes(origin)) list.push(origin);
    } catch {
      // Not a URL (`example.com`, a typo): it could never match, so it is not listed.
    }
  }

  parsedFrom = raw;
  parsed = Object.freeze(list);
  return parsed;
}

/**
 * The site's own address: the first origin ALLOWED_ORIGIN names, or '' when
 * it names none. What a link or a sender name is built from, when the request
 * itself does not say which of the site's hosts it came through.
 */
export function primaryOrigin(configured: unknown): string {
  return allowedOrigins(configured)[0] ?? '';
}

/**
 * Is `requestOrigin` allowed, given the site's configured origin (one, or a
 * comma-separated list) and, optionally, its Cloudflare Pages project name?
 *
 * Passing `pagesProject` admits that project's preview deployments
 * (`<project>.pages.dev` and `<hash>.<project>.pages.dev`). Omit it and only
 * the configured origins are allowed.
 */
export function isAllowedOrigin(
  requestOrigin: string,
  configuredOrigin: string,
  pagesProject?: string
): boolean {
  let origin: string;
  let hostname: string;
  try {
    ({ origin, hostname } = new URL(requestOrigin));
  } catch {
    return false; // not a parseable URL — including the literal "null" a sandboxed page sends
  }

  if (allowedOrigins(configuredOrigin).includes(origin)) return true;
  if (!pagesProject) return false;

  const root = `${pagesProject}.pages.dev`;
  // Exact project host, or a preview subdomain of it. The `.` prefix matters:
  // without it, `evil-my-site.pages.dev` would match `my-site.pages.dev`.
  return hostname === root || hostname.endsWith(`.${root}`);
}

/**
 * The value to send back in Access-Control-Allow-Origin. Echoes the request
 * origin when it is allowed, otherwise falls back to the site's first
 * configured origin — one origin, as the header requires; never the list and
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
  return primaryOrigin(configuredOrigin);
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
