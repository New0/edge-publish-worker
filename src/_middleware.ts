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

import { fetchFromWordPress, type WpOriginEnv } from './lib/wp-fetch.js';

export interface MiddlewareEnv extends WpOriginEnv {
  PAGES_CACHE: KVNamespace;
}

/** Extensions that are always served from the static build, never from KV. */
const ASSET_EXTENSIONS =
  /\.(css|js|jpg|jpeg|png|gif|webp|avif|svg|ico|woff|woff2|ttf|eot|pdf|xml|json|txt|map)$/i;

/** Map a request path to its KV key, mirroring the static build's layout. */
export function normalizePath(pathname: string): string {
  let normalized = pathname.replace(/^\//, '');
  if (!normalized || normalized.endsWith('/')) {
    normalized += 'index.html';
  } else if (!normalized.includes('.')) {
    normalized += '/index.html';
  }
  return normalized;
}

/**
 * Fetch a missing upload from the WordPress origin.
 *
 * WordPress upload paths are date-based and effectively immutable, so the
 * response is cached hard. Any failure returns 404 rather than surfacing an
 * origin error to the visitor.
 */
async function proxyUploadFromWP(pathname: string, env: MiddlewareEnv): Promise<Response> {
  if (!env.WP_SOURCE) return new Response('Not Found', { status: 404 });

  try {
    // Same policy as update-page: a redirect here means the request was not
    // authenticated, and following it would cache production's 404 page as an
    // image. fetchFromWordPress throws instead.
    const upstream = await fetchFromWordPress(`${env.WP_SOURCE}${pathname}`, env);
    if (!upstream.ok) return new Response('Not Found', { status: 404 });

    return new Response(upstream.body, {
      headers: {
        'Content-Type': upstream.headers.get('Content-Type') || 'application/octet-stream',
        'Cache-Control': 'public, max-age=31536000, immutable',
        'X-Cache-Status': 'wp-proxy',
      },
    });
  } catch {
    return new Response('Not Found', { status: 404 });
  }
}

export const onRequest: PagesFunction<MiddlewareEnv> = async (context) => {
  const { pathname } = new URL(context.request.url);

  // API routes belong to their own functions.
  if (pathname.startsWith('/api/')) return context.next();

  if (ASSET_EXTENSIONS.test(pathname)) {
    // Uploads get a WordPress fallback; everything else is static-only.
    if (pathname.startsWith('/wp-content/uploads/')) {
      const staticResponse = await context.next();
      return staticResponse.status === 404
        ? proxyUploadFromWP(pathname, context.env)
        : staticResponse;
    }
    return context.next();
  }

  if (context.request.method !== 'GET') return context.next();

  // The sitemap is rebuilt by update-index and lands in KV under its own key.
  if (pathname === '/sitemap.xml' || pathname === '/sitemap_index.xml') {
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

  try {
    const cached = await context.env.PAGES_CACHE?.get(normalizePath(pathname), 'text');
    if (cached) {
      return new Response(cached, {
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'X-Cache-Status': 'kv-cache',
          'Cache-Control': 'public, max-age=60',
        },
      });
    }
  } catch {
    // KV unavailable — fall through to the static build.
  }

  return context.next();
};
