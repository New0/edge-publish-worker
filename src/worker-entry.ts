/**
 * The same endpoints, as a Worker rather than as Pages Functions.
 *
 * Everything else here is written for Cloudflare Pages: a file per route under
 * `functions/api/`, and `_middleware.ts` deciding what a visitor gets. That is
 * how both production sites are deployed and none of it changes.
 *
 * This exists for one reason: **the Deploy to Cloudflare button does not
 * support Pages applications.** A stranger installing the plugin needs an edge
 * they can create without us, the button is the only mechanism that provisions
 * KV, D1 and secrets from a repository in one click, and it deploys Workers. So
 * the same handlers are given a Workers-shaped front door.
 *
 * ## It wraps rather than reimplements
 *
 * Every route below calls the same exported factory a Pages site calls. Pages
 * hands a handler an `EventContext`; this builds one and passes `next` as
 * "serve from the static assets", which is exactly what Pages' `next()` does at
 * the end of the middleware chain. `_middleware.ts` therefore runs unchanged —
 * KV-first page serving, the uploads proxy, the sitemap — and there is one
 * implementation of that logic rather than two that drift.
 *
 * The cost is one cast, at `asContext`, and it is worth naming: `EventContext`
 * carries fields (`functionPath`, `params`, `data`) that only Pages populates.
 * They are supplied as empty rather than faked, because no handler here reads
 * them, and a handler that started to would be relying on something a Worker
 * cannot honestly provide.
 */

import { onRequest as middleware, type MiddlewareEnv } from './_middleware.js';
import { createContactHandler, createContactOptionsHandler, type ContactEnv, type ContactOptions } from './api/contact.js';
import {
  createCommentGetHandler,
  createCommentOptionsHandler,
  createCommentPostHandler,
  type CommentEnv,
  type CommentOptions,
} from './api/comment.js';
import { onRequestGet as searchGet, onRequestOptions as searchOptions, type SearchEnv } from './api/search.js';
import {
  createSyncGetHandler,
  createSyncOptionsHandler,
  createSyncPostHandler,
  type SyncEnv,
  type SyncOptions,
} from './api/sync.js';
import {
  createUpdatePageHandler,
  createUpdatePageOptionsHandler,
  type UpdatePageEnv,
  type UpdatePageOptions,
} from './api/update-page.js';
import {
  createUpdateIndexHandler,
  createUpdateIndexOptionsHandler,
  type UpdateIndexEnv,
} from './api/update-index.js';
import { createDefaultTransform } from './lib/default-transform.js';

/** Everything the endpoints need, plus the static assets a Worker serves itself. */
export interface WorkerEnv
  extends MiddlewareEnv,
    ContactEnv,
    CommentEnv,
    SearchEnv,
    SyncEnv,
    UpdatePageEnv,
    UpdateIndexEnv {
  /** The static site, bound by `assets` in the Wrangler configuration. */
  ASSETS: Fetcher;
}

/**
 * What one site decides.
 *
 * Everything absent has a working default, because the point of this file is a
 * deployment that answers correctly before anyone has edited anything.
 */
export interface SiteConfig {
  contact?: ContactOptions;
  comment?: CommentOptions;
  /**
   * Which record types the WordPress plugin may drain, and from which table.
   *
   * Defaults to the two the shared schema creates. A site that adds a table
   * adds it here, and `sync.ts` refuses a name that is not a plain identifier.
   */
  sync?: SyncOptions;
  updatePage?: Omit<UpdatePageOptions, 'transform'> & Partial<Pick<UpdatePageOptions, 'transform'>>;
}

const DEFAULT_SYNC: SyncOptions = {
  types: {
    contact: { table: 'contact_submissions', timestampColumn: 'submitted_at' },
    comment: { table: 'comments', timestampColumn: 'submitted_at' },
  },
};

type AnyHandler = (context: EventContext<never, string, Record<string, unknown>>) => Response | Promise<Response>;

/**
 * Build the `EventContext` a Pages handler expects.
 *
 * `next` is the honest part: in Pages it means "continue down the chain and
 * end at the static asset"; here it is the asset fetcher directly, which is the
 * same thing with fewer steps.
 */
function asContext(request: Request, env: WorkerEnv, ctx: ExecutionContext, next: () => Promise<Response>) {
  return {
    request,
    env,
    params: {},
    data: {},
    next,
    waitUntil: ctx.waitUntil.bind(ctx),
    passThroughOnException: ctx.passThroughOnException.bind(ctx),
    functionPath: new URL(request.url).pathname,
  } as unknown as EventContext<never, string, Record<string, unknown>>;
}

/**
 * The Worker.
 *
 * Routes are exact paths rather than patterns: these six are the whole API
 * surface, and a prefix match would let `/api/contactenator` reach the contact
 * endpoint.
 */
export function createWorker(config: SiteConfig = {}): ExportedHandler<WorkerEnv> {
  const routes: Record<string, Partial<Record<string, AnyHandler>>> = {
    '/api/contact': {
      POST: createContactHandler(config.contact) as AnyHandler,
      OPTIONS: createContactOptionsHandler() as AnyHandler,
    },
    '/api/comment': {
      GET: createCommentGetHandler(config.comment) as AnyHandler,
      POST: createCommentPostHandler(config.comment) as AnyHandler,
      OPTIONS: createCommentOptionsHandler() as AnyHandler,
    },
    '/api/search': {
      GET: searchGet as AnyHandler,
      OPTIONS: searchOptions as AnyHandler,
    },
    '/api/sync': {
      GET: createSyncGetHandler(config.sync ?? DEFAULT_SYNC) as AnyHandler,
      POST: createSyncPostHandler(config.sync ?? DEFAULT_SYNC) as AnyHandler,
      OPTIONS: createSyncOptionsHandler() as AnyHandler,
    },
    '/api/update-index': {
      POST: createUpdateIndexHandler() as AnyHandler,
      OPTIONS: createUpdateIndexOptionsHandler() as AnyHandler,
    },
  };

  return {
    async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
      const url = new URL(request.url);
      const serveAsset = () => env.ASSETS.fetch(request);

      if (url.pathname === '/api/update-page') {
        /*
         * Built per request rather than once, because the transform needs the
         * site's own address and the origin it syncs from, and both are
         * bindings. A Worker built at module scope would capture whatever the
         * first isolate happened to see.
         */
        const handler =
          request.method === 'OPTIONS'
            ? createUpdatePageOptionsHandler()
            : createUpdatePageHandler({
                ...config.updatePage,
                transform:
                  config.updatePage?.transform ??
                  createDefaultTransform({
                    siteUrl: env.ALLOWED_ORIGIN || url.origin,
                    wpOrigin: env.WP_SOURCE || '',
                  }),
              });

        return (handler as AnyHandler)(asContext(request, env, ctx, serveAsset));
      }

      const route = routes[url.pathname];
      if (route) {
        const handler = route[request.method];
        if (!handler) {
          return new Response('Method Not Allowed', {
            status: 405,
            headers: { Allow: Object.keys(route).join(', ') },
          });
        }
        return handler(asContext(request, env, ctx, serveAsset));
      }

      // Anything that is not an API route goes through the same middleware a
      // Pages deployment uses, ending at the static asset.
      if (url.pathname.startsWith('/api/')) {
        return new Response('Not Found', { status: 404 });
      }

      return (middleware as AnyHandler)(asContext(request, env, ctx, serveAsset));
    },
  };
}
