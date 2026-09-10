/**
 * The single way EdgeWPsync talks to a WordPress origin.
 *
 * Every fetch against a customer's WordPress goes through here, because the
 * failure mode this prevents is silent and expensive.
 *
 * ## Why redirects are an error, not something to follow
 *
 * A staging WordPress is normally hidden from crawlers so it cannot compete
 * with production for the same content. Two mechanisms are common:
 *
 *   1. HTTP Basic Auth  — unauthenticated requests get 401. Loud.
 *   2. Redirect-to-production — unauthenticated requests get 302 to the live
 *      site. Silent, and the dangerous one.
 *
 * Under (2), a fetch with `redirect: 'follow'` returns 200 and real HTML — from
 * the *already-static production site*. A rebuild then crawls its own output,
 * reports success, and quietly freezes the site at whatever it last contained.
 * New WordPress content never appears and nothing errors.
 *
 * So: `redirect: 'manual'`, and any 3xx is treated as an authentication
 * failure with a message that names what happened. Following a redirect off
 * the WordPress origin is also a validation bypass — checking the requested
 * URL's origin means nothing if the fetch then goes somewhere else.
 */

export interface WpOriginEnv {
  /** WordPress origin, e.g. "https://ia.example.com". */
  WP_SOURCE?: string;
  /** Base64 "user:pass" for HTTP Basic Auth. The recommended mechanism. */
  WP_BASIC_AUTH?: string;
  /** A WordPress login cookie, for origins gated on wp-admin session instead. */
  WP_AUTH_COOKIE?: string;
}

export class WpOriginError extends Error {
  constructor(message: string, readonly status?: number, readonly location?: string) {
    super(message);
    this.name = 'WpOriginError';
  }
}

/**
 * Credentials for the WordPress origin.
 *
 * Basic Auth is preferred and is the documented default for new environments.
 * Cookie auth is supported for origins that gate on a wp-admin session, but it
 * is strictly worse: cookies expire, cannot be rotated without a login, and a
 * login page that is down (503) makes the site unbuildable.
 */
export function wpAuthHeaders(
  env: WpOriginEnv,
  extra: Record<string, string> = {}
): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent': 'edgewpsync/1.0',
    ...extra,
  };
  if (env.WP_BASIC_AUTH) headers.Authorization = `Basic ${env.WP_BASIC_AUTH}`;
  if (env.WP_AUTH_COOKIE) headers.Cookie = env.WP_AUTH_COOKIE;
  return headers;
}

/** True when neither credential is configured. */
export function hasWpCredentials(env: WpOriginEnv): boolean {
  return Boolean(env.WP_BASIC_AUTH || env.WP_AUTH_COOKIE);
}

/**
 * Explain a 3xx from the WordPress origin in terms of the likely cause,
 * rather than as a bare status code.
 */
export function describeRedirect(status: number, location: string | null, wpOrigin: string): string {
  if (!location) {
    return `WordPress origin returned ${status} with no Location. Expected content.`;
  }
  let offOrigin = true;
  try {
    offOrigin = new URL(location, wpOrigin).origin !== new URL(wpOrigin).origin;
  } catch {
    /* unparseable Location — treat as off-origin */
  }
  if (offOrigin) {
    return (
      `WordPress origin redirected to ${location}, off the configured origin. ` +
      'This is what an unauthenticated request looks like when the staging site ' +
      'redirects visitors to production. Following it would rebuild the site ' +
      'from its own output. Check WP_BASIC_AUTH / WP_AUTH_COOKIE.'
    );
  }
  return (
    `WordPress origin redirected to ${location} (same origin, ${status}). ` +
    'Often a login redirect — check WP_AUTH_COOKIE.'
  );
}

/**
 * Fetch one URL from the WordPress origin.
 *
 * Never follows redirects. Throws WpOriginError on 3xx or a non-ok response,
 * so a caller cannot mistake an auth failure for content.
 */
export async function fetchFromWordPress(
  url: string,
  env: WpOriginEnv,
  init: RequestInit = {}
): Promise<Response> {
  const wpOrigin = env.WP_SOURCE ?? url;

  const response = await fetch(url, {
    ...init,
    headers: wpAuthHeaders(env, (init.headers as Record<string, string>) ?? {}),
    redirect: 'manual',
  });

  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get('Location');
    throw new WpOriginError(
      describeRedirect(response.status, location, wpOrigin),
      response.status,
      location ?? undefined
    );
  }

  if (response.status === 401 || response.status === 403) {
    throw new WpOriginError(
      `WordPress origin refused the request (${response.status}). ` +
      (hasWpCredentials(env)
        ? 'Credentials are set but were rejected.'
        : 'No WP_BASIC_AUTH or WP_AUTH_COOKIE is configured.'),
      response.status
    );
  }

  return response;
}
