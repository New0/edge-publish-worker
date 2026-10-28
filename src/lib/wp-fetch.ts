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

import { signRequestTo } from './signature.js';

export interface WpOriginEnv {
  /** WordPress origin, e.g. "https://ia.example.com". */
  WP_SOURCE?: string;
  /** Base64 "user:pass" for HTTP Basic Auth. */
  WP_BASIC_AUTH?: string;
  /** A WordPress login cookie, for origins gated on wp-admin session instead. */
  WP_AUTH_COOKIE?: string;
}

/**
 * What a fetch may carry beyond the origin's own credentials: the shared
 * secret, used here to *sign* the request.
 *
 * It is the way in to an origin guarded from inside WordPress, where there is no
 * Basic Auth to send. Every Worker that fetches from WordPress already has it
 * bound, because the same secret verifies what the plugin sends — so it costs a
 * site nothing new to configure.
 *
 * A separate type rather than a field on WpOriginEnv, because the envs that
 * extend WpOriginEnv declare SYNC_SECRET *required*, and TypeScript cannot
 * merge an optional and a required property of one name into WorkerEnv.
 */
export type WpFetchEnv = WpOriginEnv & { SYNC_SECRET?: string };

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

/**
 * A caller's headers as a plain object, whatever shape `RequestInit` allowed.
 * A plain object — what every caller passes — is kept as written, key case
 * included; a `Headers` or a list of pairs is copied into one.
 */
function headersOf(init: HeadersInit | undefined): Record<string, string> {
  if (!init) return {};
  if (init instanceof Headers) return Object.fromEntries(init.entries());
  if (Array.isArray(init)) return Object.fromEntries(init);
  return init as Record<string, string>;
}

/** True when neither credential is configured. */
export function hasWpCredentials(env: WpFetchEnv): boolean {
  return Boolean(env.WP_BASIC_AUTH || env.WP_AUTH_COOKIE || env.SYNC_SECRET);
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

export interface WpFetchOptions {
  /**
   * Give up after this long, as a WpOriginError — the whole exchange, body
   * included. A fetch with no signal waits as long as the origin does, and
   * `update-page` fetches up to twenty pages inside the plugin's fifteen-second
   * client timeout.
   *
   * Opt-in rather than a default, unlike the Node twin's 30 s: the deadline
   * covers the body, and the uploads proxy streams its body to the visitor —
   * a large PDF on a slow connection would be cut off mid-download.
   */
  timeoutMs?: number;
}

/**
 * Is `url` on the WordPress origin? Refuses with a WpOriginError if not.
 *
 * **Credentials go to WordPress and nowhere else.** Until 2026-09-28 this
 * module signed and attached `WP_BASIC_AUTH` or the cookie to any URL it was
 * handed. Every caller happened to pass one on the origin, but the v1
 * signature covers `ts.nonce.body` and nothing else — no method, no host, no
 * path — so a signed empty-body GET sent anywhere else is, for five minutes,
 * also a valid request to the edge's own `GET /api/sync`, the stored
 * submissions. v2 (2026-09-29) binds the method and path, but v1 travels
 * beside it until every verifier refuses v1. The check is here, before any
 * header is built, rather than trusted to each caller.
 *
 * Compared as parsed origins, as `update-page`'s `isSameOrigin` does: a
 * prefix check accepts `https://wp.example.com.attacker.test`. With no
 * `WP_SOURCE` there is no origin to compare against, and nothing is sent.
 * The Node twin, `src/core/wp-fetch.mjs`, makes the same refusal against its
 * `wpOrigin`, with the same error type; keep the two in step.
 */
function assertOnWordPressOrigin(url: string, wpSource: string | undefined): string {
  if (!wpSource) {
    throw new WpOriginError(
      `Refusing to fetch ${url}: no WordPress origin (WP_SOURCE) is configured, so there is nowhere credentials may be sent.`
    );
  }
  let target: string;
  let origin: string;
  try {
    origin = new URL(wpSource).origin;
  } catch {
    throw new WpOriginError(`Refusing to fetch ${url}: WP_SOURCE (${wpSource}) is not a URL.`);
  }
  try {
    target = new URL(url).origin;
  } catch {
    throw new WpOriginError(`Refusing to fetch ${url}: not a URL, so not on the WordPress origin ${origin}.`);
  }
  if (target !== origin) {
    throw new WpOriginError(
      `Refusing to fetch ${url}: it is not on the WordPress origin ${origin}, ` +
        'and the request would carry that origin\'s credentials.'
    );
  }
  return origin;
}

/**
 * Fetch one URL from the WordPress origin.
 *
 * Refuses any URL off `WP_SOURCE` before building a header. Never follows
 * redirects. Throws WpOriginError on 3xx, on a refusal, or when the origin
 * does not answer in time, so a caller cannot mistake any of them for content.
 */
export async function fetchFromWordPress(
  url: string,
  env: WpFetchEnv,
  init: RequestInit = {},
  options: WpFetchOptions = {}
): Promise<Response> {
  const wpOrigin = assertOnWordPressOrigin(url, env.WP_SOURCE);
  const { timeoutMs } = options;

  /*
   * Signed when the secret is bound, and alongside Basic Auth rather than
   * instead of it. An origin in the middle of moving from one to the other
   * accepts either, and sending both is what lets that move happen without a
   * moment where nothing works.
   *
   * Only a string body (or none) can be signed: the signature covers the bytes
   * sent, and a stream or FormData has no bytes yet. Such a request goes
   * unsigned and fails at a guarded origin — visibly, as a refusal — rather
   * than being signed over something it will not send.
   *
   * Signed for this method and this URL (v2, beside v1, since 2026-09-29), so
   * the origin guard admits this request and no other.
   */
  const body = init.body === undefined || init.body === null ? '' : init.body;
  const own = headersOf(init.headers);
  // A caller that signed its own request wins whole. The caller's headers used
  // to be spread over the blanket ones, which was enough while both were v1;
  // a blanket X-EWS-Signature-V2 left beside a caller's own v1 would now be
  // judged alone, against the caller's nonce, and refused.
  const callerSigned = Object.keys(own).some((name) => /^x-ews-/i.test(name));
  const signed = env.SYNC_SECRET && typeof body === 'string' && !callerSigned
    ? await signRequestTo(env.SYNC_SECRET, init.method ?? 'GET', url, body)
    : {};

  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: wpAuthHeaders(env, { ...signed, ...own }),
      redirect: 'manual',
      // A caller's own signal wins over the deadline.
      ...(init.signal ? {} : timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
    });
  } catch (error) {
    // Named as what it is. A bare "The operation was aborted due to timeout"
    // in a per-page result says nothing about which origin or how long.
    // By name, not class: the runtime's timeout is a DOMException.
    if (timeoutMs && (error as { name?: unknown } | null)?.name === 'TimeoutError') {
      throw new WpOriginError(`WordPress origin did not answer ${url} within ${timeoutMs / 1000} s.`);
    }
    throw error;
  }

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
        : 'No SYNC_SECRET, WP_BASIC_AUTH or WP_AUTH_COOKIE is configured.'),
      response.status
    );
  }

  return response;
}
