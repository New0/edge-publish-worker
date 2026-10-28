/**
 * KV-first page serving — shared Pages Functions middleware.
 *
 * Serves HTML from the PAGES_CACHE KV namespace when the incremental sync has
 * written a fresher copy there, falling through to the static build otherwise.
 * Also proxies `/wp-content/uploads/*` from the WordPress origin when an image
 * is missing locally, which happens whenever media is added between full builds.
 *
 * Site-agnostic: the WordPress origin arrives as `WP_SOURCE`. The site
 * implementation this replaces carried a hardcoded `DEFAULT_WP_SOURCE`, which
 * is precisely what made the file unshareable. Here there is no default — an
 * unset binding disables the proxy rather than silently pointing every site at
 * one site's WordPress.
 */

import { fetchFromWordPress, type WpFetchEnv, type WpOriginEnv } from './lib/wp-fetch.js';
import { resolvePrices, resolveProducts, type StripeEnv } from './lib/stripe.js';
import { pricesOnPage, productsOnPage, renderCommerce } from './lib/commerce-html.js';

export interface MiddlewareEnv extends WpOriginEnv, StripeEnv {
  PAGES_CACHE: KVNamespace;
  /**
   * Sent as `X-Robots-Tag` on every response, when set — for a site that is
   * not meant to be found (a build environment with `discoverable: false`,
   * docs/SEO.md). One header covers what a robots meta cannot: pages served
   * from KV and from the build alike, and every file that is not HTML.
   */
  X_ROBOTS_TAG?: string;
}

/** A robots directive list: words, commas, colons, spaces. Anything else is not sent. */
const ROBOTS_TAG = /^[A-Za-z0-9 ,:_-]{1,200}$/;

/** The response with the site's `X-Robots-Tag`, when it has one. */
export function withRobotsTag(response: Response, env: Partial<MiddlewareEnv>): Response {
  const tag = String(env.X_ROBOTS_TAG ?? '').trim();
  if (!tag || !ROBOTS_TAG.test(tag)) return response;
  // A response from the build or another function may have immutable headers.
  const out = new Response(response.body, response);
  out.headers.set('X-Robots-Tag', tag);
  return out;
}

/**
 * Prices and the buy script, for a site that sells (docs/STRIPE-COMMERCE.md).
 *
 * Only when a Stripe key is bound, and only for a page that carries a Buy
 * block: every other page, and every site that sells nothing, goes out exactly
 * as it did before. Never throws — a page with an unresolvable price still
 * renders, with the button disabled.
 */
/** What lets work outlive the response: a stale price is refreshed after it. */
type WaitUntil = (promise: Promise<unknown>) => void;

async function withCommerce(html: string, env: MiddlewareEnv, waitUntil?: WaitUntil): Promise<string> {
  if (!env.STRIPE_SECRET_KEY) return html;
  const prices = pricesOnPage(html);
  const products = productsOnPage(html);
  if (!prices.length && !products.length) return html;
  try {
    // Two keys, one map: the ids cannot collide, their prefixes differ. Asked
    // together: an array literal awaits its elements in order, so a page with
    // both kinds paid two D1 reads, and possibly two Stripe waits, in a row.
    const [byPrice, byProduct] = await Promise.all([
      prices.length ? resolvePrices(env, prices, undefined, undefined, waitUntil) : new Map(),
      products.length ? resolveProducts(env, products, undefined, undefined, waitUntil) : new Map(),
    ]);
    const views = new Map([...byPrice, ...byProduct]);
    return renderCommerce(html, views);
  } catch {
    return html;
  }
}

/** The static build's HTML, through withCommerce; anything else untouched. */
async function staticWithCommerce(response: Response, env: MiddlewareEnv, waitUntil?: WaitUntil): Promise<Response> {
  if (!env.STRIPE_SECRET_KEY || !/text\/html/i.test(response.headers.get('Content-Type') || '')) return response;
  const html = await response.text();
  const rendered = await withCommerce(html, env, waitUntil);
  const headers = new Headers(response.headers);
  headers.delete('Content-Length');
  // A price may change; a page carrying one must not be cached for long.
  if (rendered !== html) headers.set('Cache-Control', 'public, max-age=60');
  return new Response(rendered, { status: response.status, statusText: response.statusText, headers });
}

/**
 * A page that moved, as `update-page` stores it (action `redirect`).
 *
 * When WordPress changes a published post's address — a new slug, a new
 * parent — the plugin sends the old path a redirect to the new one. Before
 * 2026-09-26 it sent only the new path: the old URL kept its cached copy
 * forever, or answered the build's stale copy until the next build and a 404
 * after it, and every link and ranking it had earned went nowhere. WordPress
 * answers an old slug with a 301 (`wp_old_slug_redirect`); the edge now does
 * the same.
 *
 * The entry is a small HTML page that starts with this mark. The mark is what
 * this middleware reads, so serving costs the one KV read it always did; the
 * page itself carries a meta refresh and a canonical, so a site still running
 * an older middleware sends its visitor on rather than showing them nothing.
 */
export const REDIRECT_MARK = '<!-- ews-redirect ';

/** The stored body for a redirect to `to`, a path `update-page` has validated. */
export function redirectEntry(to: string): string {
  return `${REDIRECT_MARK}${to} -->\n<!DOCTYPE html><html><head><meta charset="utf-8">`
    + `<meta name="robots" content="noindex"><link rel="canonical" href="${to}">`
    + `<meta http-equiv="refresh" content="0; url=${to}"><title>Moved</title></head>`
    + `<body><p><a href="${to}">${to}</a></p></body></html>`;
}

/**
 * The path a stored entry redirects to, or null for a page.
 *
 * Only a same-site path: a single leading slash, never `//host`, which a
 * browser reads as another site. `update-page` only ever writes such a path;
 * this checks again because it is the line that turns stored bytes into a
 * Location header.
 */
export function redirectTarget(stored: string | null): string | null {
  if (!stored || !stored.startsWith(REDIRECT_MARK)) return null;
  const to = /^<!-- ews-redirect (\/[^\s>]*) -->/.exec(stored)?.[1];
  return to && !to.startsWith('//') && !to.includes('\\') ? to : null;
}

/**
 * The addresses WordPress and its SEO plugins publish sitemaps at, other than
 * `/sitemap.xml`: Yoast's index and its per-type children (`post-sitemap.xml`,
 * `page-sitemap2.xml`), core's `wp-sitemap.xml` and its children. Search
 * engines remember the address they were given, and after the move each of
 * them answered 404 (measured on both live sites, 2026-09-26): the origin
 * guard sends them to the edge, which had nothing there.
 */
const SITEMAP_ALIASES = /^\/(?:sitemap_index\.xml|wp-sitemap(?:-[a-z0-9_-]+)?\.xml|[a-z0-9_]+(?:-[a-z0-9_]+)*-sitemap\d*\.xml)$/i;

/** Extensions that are always served from the static build, never from KV. */
const ASSET_EXTENSIONS =
  /\.(css|js|jpg|jpeg|png|gif|webp|avif|svg|ico|woff|woff2|ttf|eot|pdf|xml|json|txt|map)$/i;

/** Map a request path to its KV key, mirroring the static build's layout. */
export function normalizePath(pathname: string): string {
  /*
   * One path must produce one key. Percent-escapes are case-insensitive per
   * RFC 3986 §6.2.2.1, so `%c3%a0` and `%C3%A0` are the same path — and would
   * otherwise be two different KV keys, which is how a page written by the
   * plugin fails to be the page a visitor's browser asks for. Uppercasing here
   * covers both callers, because both go through this function.
   */
  let normalized = pathname
    .replace(/%[0-9a-fA-F]{2}/g, (escape) => escape.toUpperCase())
    .replace(/^\//, '');
  if (!normalized || normalized.endsWith('/')) {
    normalized += 'index.html';
  } else if (!normalized.includes('.')) {
    normalized += '/index.html';
  }
  return normalized;
}

/**
 * Which missing uploads may be fetched from the origin (security review,
 * 2026-10-27).
 *
 * The fallback used to forward any `/wp-content/uploads/…` path ending in an
 * asset extension, and `uploads/` is where WordPress plugins also keep what
 * was never meant to be public: a WP All Import copy of a whole site export
 * (`.xml`, private and draft posts, commenters' emails and IPs) and a
 * visitor's Ninja Forms attachment were both downloadable through a live
 * site, signed by the edge past the origin guard. Now only media are forwarded,
 * and never from a folder a plugin uses for private data. Media still covers
 * CSS and JS, which page builders generate into `uploads/` outside the
 * `YYYY/MM/` folders.
 */
const PROXYABLE_UPLOAD =
  /\.(?:jpe?g|png|gif|webp|avif|svg|ico|bmp|mp4|webm|ogv|mov|mp3|ogg|wav|m4a|woff2?|ttf|otf|eot|css|js|pdf)$/i;
const PRIVATE_UPLOAD_DIRS =
  /^\/wp-content\/uploads\/(?:ninja-forms|gravity_forms|wpforms|formidable|wpcf7_uploads|wpallimport|wpallexport|wp-migrate-db|mainwp|updraft|backwpup[^/]*|backups?[^/]*|ai1wm-backups|pb_backupbuddy|wp-staging[^/]*|woocommerce_uploads|wc-logs|edd|sucuri|wflogs)(?:\/|$)/i;

/** May this missing upload be fetched from the origin at all? */
export function proxyableUpload(pathname: string): boolean {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return false;
  }
  // Judged on the decoded path, so an escaped `%2e%2e` or `%2f` cannot walk out
  // of uploads/ or around the folder list.
  if (decoded.includes('..') || decoded.includes('\\') || decoded !== decoded.replace(/\/{2,}/g, '/')) return false;
  return decoded.startsWith('/wp-content/uploads/')
    && PROXYABLE_UPLOAD.test(decoded)
    && !PRIVATE_UPLOAD_DIRS.test(decoded);
}

/**
 * Headers a file fetched from the origin is served with. The response is
 * built here, so `_headers` never decorates it: an uploaded SVG opened on its
 * own could otherwise run script on the site's origin.
 */
const PROXIED_UPLOAD_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
};

/**
 * The security headers `_headers` declares, copied from the build's response
 * for the same path onto a response this middleware builds (security review,
 * 2026-10-27). Cloudflare applies `_headers` only to what the static build
 * serves, so every page answered from PAGES_CACHE — every page WordPress has
 * pushed — went out with no CSP, HSTS, X-Frame-Options or nosniff. Copying
 * keeps `_headers` the one place they are written, for every site.
 */
const SECURITY_HEADERS = [
  'Content-Security-Policy',
  'Content-Security-Policy-Report-Only',
  'Strict-Transport-Security',
  'X-Frame-Options',
  'X-Content-Type-Options',
  'Referrer-Policy',
  'Permissions-Policy',
  'Cross-Origin-Opener-Policy',
  'Cross-Origin-Embedder-Policy',
  'Cross-Origin-Resource-Policy',
];

export function withSecurityHeaders(response: Response, from: Response): Response {
  for (const name of SECURITY_HEADERS) {
    const value = from.headers.get(name);
    if (value !== null && !response.headers.has(name)) response.headers.set(name, value);
  }
  return response;
}

/** The build's response for this request, read only for its headers. */
async function buildHeadersFor(context: Parameters<PagesFunction<MiddlewareEnv>>[0]): Promise<Response | null> {
  try {
    const built = await context.next();
    await built.body?.cancel().catch(() => {});
    return built;
  } catch {
    return null;
  }
}

/** How long an upload the origin does not have is remembered as missing. */
const MISSING_UPLOAD_TTL_SECONDS = 300;

/**
 * The Cache API's default cache, where the runtime has one.
 *
 * Workers and Pages do; Node, where the tests run, does not — and a cache that
 * is absent must mean "ask the origin", never an exception.
 */
function edgeCache(): Cache | null {
  const storage = (globalThis as { caches?: { default?: Cache } }).caches;
  return storage?.default ?? null;
}

/**
 * The cache key for an upload, found or missing: the site's own URL for the
 * path, with no query string. The origin is asked for the path alone, so keying by the full
 * request URL would let `?1`, `?2`, … each cost a fresh origin request — which
 * is the traffic this cache exists to stop.
 */
function uploadKey(requestUrl: string, pathname: string): Request {
  return new Request(new URL(pathname, requestUrl).toString(), { method: 'GET' });
}

/**
 * Fetch a missing upload from the WordPress origin.
 *
 * WordPress upload paths are date-based and effectively immutable, so the
 * response is cached hard — by the browser, and since 2026-10-28 at the edge.
 * Any failure returns 404 rather than surfacing an origin error to the visitor.
 *
 * Exported (2026-10-28) for a site whose own middleware serves uploads — so it
 * takes this one rather than a copy that misses what is added here, as one
 * site's copy missed both edge caches.
 *
 * **A 404 from the origin is remembered for five minutes** (review of
 * 2026-09-28). Before, every anonymous request for an upload the build lacks
 * sent a signed request to the guarded origin, so anyone could have WordPress
 * render its full 404 page as fast as they could ask. Only a 404: a 5xx, a
 * refusal or a timeout may be over by the next request, and is not cached.
 */
export async function proxyUploadFromWP(
  pathname: string,
  env: WpFetchEnv,
  requestUrl: string,
  waitUntil?: (promise: Promise<unknown>) => void
): Promise<Response> {
  if (!env.WP_SOURCE || !proxyableUpload(pathname)) return new Response('Not Found', { status: 404 });

  const cache = edgeCache();
  const key = uploadKey(requestUrl, pathname);
  if (cache) {
    try {
      const remembered = await cache.match(key);
      if (remembered) return remembered;
    } catch {
      // The cache is an optimisation; without it the origin is asked, as before.
    }
  }

  try {
    // Same policy as update-page: a redirect here means the request was not
    // authenticated, and following it would cache production's 404 page as an
    // image. fetchFromWordPress throws instead.
    const upstream = await fetchFromWordPress(`${env.WP_SOURCE}${pathname}`, env);
    if (upstream.status === 404 && cache) {
      // WordPress's 404 page is not what a visitor gets; release it unread.
      await upstream.body?.cancel().catch(() => {});
      const missing = new Response('Not Found', {
        status: 404,
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': `public, max-age=${MISSING_UPLOAD_TTL_SECONDS}`,
          'X-Cache-Status': 'wp-proxy-miss',
        },
      });
      try {
        await cache.put(key, missing.clone());
      } catch {
        /* not remembered; the next request asks the origin again */
      }
      return missing;
    }
    if (!upstream.ok) return new Response('Not Found', { status: 404 });

    const found = new Response(upstream.body, {
      headers: {
        'Content-Type': upstream.headers.get('Content-Type') || 'application/octet-stream',
        'Cache-Control': 'public, max-age=31536000, immutable',
        'X-Cache-Status': 'wp-proxy',
        ...PROXIED_UPLOAD_HEADERS,
      },
    });
    /*
     * Kept at the edge too (2026-10-28). Cloudflare's CDN does not cache what a
     * Function returns, so `immutable` reached only the browser that asked:
     * every new visitor's request for an image published since the last build
     * went to the origin again, signed, from every location. Upload paths do
     * not change in place; private directories never get here.
     * After the answer where the runtime allows it, so the visitor's image is
     * not held while the copy is written.
     */
    if (cache) {
      const storing = cache.put(key, found.clone()).catch(() => {});
      if (waitUntil) waitUntil(storing);
      else await storing;
    }
    return found;
  } catch {
    return new Response('Not Found', { status: 404 });
  }
}

export const onRequest: PagesFunction<MiddlewareEnv> = async (context) =>
  withRobotsTag(await serve(context), context.env);

async function serve(context: Parameters<PagesFunction<MiddlewareEnv>>[0]): Promise<Response> {
  const { pathname } = new URL(context.request.url);

  // API routes belong to their own functions.
  if (pathname.startsWith('/api/')) return context.next();

  // The sitemap is rebuilt by update-index and lands in KV under its own key.
  // Before the asset check, not after it: `.xml` is an asset extension, so
  // this branch sat behind a `return context.next()` and never ran — a rebuilt
  // sitemap was written and never served (found 2026-09-21).
  if (pathname === '/sitemap.xml') {
    try {
      const cached = await context.env.PAGES_CACHE?.get('sitemap.xml', 'text');
      if (cached) {
        return new Response(cached, {
          headers: {
            'Content-Type': 'application/xml; charset=utf-8',
            'X-Cache-Status': 'kv-cache',
            'Cache-Control': 'public, max-age=3600',
          },
        });
      }
    } catch {
      // KV unavailable — the static build is still correct, just staler.
    }
    return context.next();
  }

  // An old sitemap address: the build's own file if it has one, and otherwise
  // a permanent redirect to the one sitemap this site publishes. A missing file
  // may come back as a 404 or, on a site with no 404 page, as HTML — neither is
  // a sitemap.
  if (SITEMAP_ALIASES.test(pathname)) {
    const built = await context.next();
    if (built.ok && !/text\/html/i.test(built.headers.get('Content-Type') || '')) return built;
    return new Response(null, {
      status: 301,
      headers: { Location: '/sitemap.xml', 'Cache-Control': 'public, max-age=86400', 'X-Cache-Status': 'sitemap-alias' },
    });
  }

  if (ASSET_EXTENSIONS.test(pathname)) {
    // Uploads get a WordPress fallback; everything else is static-only.
    if (pathname.startsWith('/wp-content/uploads/')) {
      const staticResponse = await context.next();
      return staticResponse.status === 404
        ? proxyUploadFromWP(pathname, context.env, context.request.url, context.waitUntil?.bind(context))
        : staticResponse;
    }
    return context.next();
  }

  if (context.request.method !== 'GET') return context.next();


  try {
    const cached = await context.env.PAGES_CACHE?.get(normalizePath(pathname), 'text');
    const moved = redirectTarget(cached ?? null);
    if (moved) {
      const { search } = new URL(context.request.url);
      return new Response(null, {
        status: 301,
        headers: { Location: moved + search, 'Cache-Control': 'public, max-age=3600', 'X-Cache-Status': 'kv-redirect' },
      });
    }
    if (cached) {
      // The build's answer for the same path carries what _headers declares;
      // a page only in KV still gets the site-wide rules from its 404. Asked
      // beside the prices rather than after them (2026-10-28): neither needs
      // the other, and a page-cache hit paid both waits in a row.
      const [html, built] = await Promise.all([withCommerce(cached, context.env, context.waitUntil?.bind(context)), buildHeadersFor(context)]);
      const page = new Response(html, {
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'X-Cache-Status': 'kv-cache',
          'Cache-Control': 'public, max-age=60',
        },
      });
      return built ? withSecurityHeaders(page, built) : page;
    }
  } catch {
    // KV unavailable — fall through to the static build.
  }

  return staticWithCommerce(await context.next(), context.env, context.waitUntil?.bind(context));
}
