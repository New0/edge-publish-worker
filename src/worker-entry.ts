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
import { createFormHandler, createFormOptionsHandler, type FormEnv, type FormOptions } from './api/form.js';
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
import { DEFAULT_SYNC_TYPES } from './lib/sync-types.js';
// Commerce and customer accounts (docs/STRIPE-COMMERCE.md, docs/EDGE-ACCOUNTS.md).
// A site that sells nothing binds no Stripe key, and every one of these
// answers "this site does not sell anything yet" instead of failing.
import { createCheckoutHandler, createCheckoutOptionsHandler, type CheckoutEnv } from './api/checkout.js';
import { createStripeWebhookHandler, type StripeWebhookEnv } from './api/stripe-webhook.js';
import { createProductsHandler, type ProductsEnv } from './api/products.js';
import { createPortalHandler, createPortalOptionsHandler, type PortalEnv } from './api/portal.js';
import { createAccountsHandler, type AccountsApiEnv } from './api/accounts.js';
import {
  createAccountRequestHandler,
  createAccountVerifyHandler,
  createAccountSignOutHandler,
  createAccountMeHandler,
  createAccountOrdersHandler,
  createAccountOptionsHandler,
  type AccountApiEnv,
} from './api/account.js';
import { createDefaultTransform } from './lib/default-transform.js';
import { primaryOrigin } from './lib/cors.js';

/** Everything the endpoints need, plus the static assets a Worker serves itself. */
export interface WorkerEnv
  extends MiddlewareEnv,
    ContactEnv,
    FormEnv,
    CommentEnv,
    SearchEnv,
    SyncEnv,
    UpdatePageEnv,
    UpdateIndexEnv,
    Omit<CheckoutEnv, 'DB'>,
    ProductsEnv,
    AccountsApiEnv,
    /*
     * `Omit` for the ones that declare as optional what another endpoint
     * declares as required: TypeScript cannot merge `ALLOWED_ORIGIN?: string`
     * with `ALLOWED_ORIGIN: string`, and the required spelling is the true one
     * here — a Worker with no allowed origin serves nothing anyone can call.
     * Likewise checkout's optional `DB`. The same reason `WpFetchEnv` exists
     * separately (see lib/stripe.ts).
     */
    Omit<StripeWebhookEnv, 'ALLOWED_ORIGIN' | 'SYNC_SECRET'>,
    Omit<AccountApiEnv, 'SYNC_SECRET'>,
    PortalEnv {
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
  /** Any plugin's form, stored as one JSON record per submission. */
  form?: FormOptions;
  comment?: CommentOptions;
  /**
   * Which record types the WordPress plugin may drain, and from which table.
   *
   * Defaults to the three the shared schema creates. A site that adds a table
   * adds it here, and `sync.ts` refuses a name that is not a plain identifier.
   */
  sync?: SyncOptions;
  updatePage?: Omit<UpdatePageOptions, 'transform'> & Partial<Pick<UpdatePageOptions, 'transform'>>;
}

const DEFAULT_SYNC: SyncOptions = { types: DEFAULT_SYNC_TYPES };

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
 * Routes are exact paths rather than patterns: this table is the whole API
 * surface, and a prefix match would let `/api/contactenator` reach the contact
 * endpoint. It must stay in step with what a Pages deployment generates
 * (`src/deploy/pages-functions.mjs`); a test compares the two, because a site
 * behind the Workers front door and a site on Pages are meant to be the same
 * site.
 */
export function createWorker(config: SiteConfig = {}): ExportedHandler<WorkerEnv> {
  const routes: Record<string, Partial<Record<string, AnyHandler>>> = {
    '/api/contact': {
      POST: createContactHandler(config.contact) as AnyHandler,
      OPTIONS: createContactOptionsHandler() as AnyHandler,
    },
    '/api/form': {
      POST: createFormHandler(config.form) as AnyHandler,
      OPTIONS: createFormOptionsHandler() as AnyHandler,
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

    // Commerce. Inert without STRIPE_SECRET_KEY, and the routes say so rather
    // than 404ing, so a site owner can tell "not set up" from "not deployed".
    '/api/checkout': {
      POST: createCheckoutHandler() as AnyHandler,
      OPTIONS: createCheckoutOptionsHandler() as AnyHandler,
    },
    '/api/stripe-webhook': { POST: createStripeWebhookHandler() as AnyHandler },
    '/api/products': { POST: createProductsHandler() as AnyHandler },
    '/api/portal': {
      POST: createPortalHandler() as AnyHandler,
      OPTIONS: createPortalOptionsHandler() as AnyHandler,
    },

    // Customer accounts: the owner's decisions in, and the four a visitor uses.
    '/api/accounts': { POST: createAccountsHandler() as AnyHandler },
    '/api/account/request': {
      POST: createAccountRequestHandler() as AnyHandler,
      OPTIONS: createAccountOptionsHandler() as AnyHandler,
    },
    '/api/account/verify': {
      GET: createAccountVerifyHandler() as AnyHandler,
      POST: createAccountVerifyHandler() as AnyHandler,
      OPTIONS: createAccountOptionsHandler() as AnyHandler,
    },
    '/api/account/signout': {
      POST: createAccountSignOutHandler() as AnyHandler,
      OPTIONS: createAccountOptionsHandler() as AnyHandler,
    },
    '/api/account/me': {
      GET: createAccountMeHandler() as AnyHandler,
      POST: createAccountMeHandler() as AnyHandler,
      OPTIONS: createAccountOptionsHandler() as AnyHandler,
    },
    '/api/account/orders': {
      GET: createAccountOrdersHandler() as AnyHandler,
      OPTIONS: createAccountOptionsHandler() as AnyHandler,
    },
  };

  /*
   * update-page's handler, one per (site address, WordPress origin).
   *
   * The default transform needs both, and both are bindings, which a Worker
   * only sees per request — so the handler cannot be built with the others
   * above. It was built per request instead, and update-page's rate limiter
   * lives in its handler: every request met a fresh, empty limiter, so this
   * front door had none (fifteen pushes from one address, fifteen 200s; the
   * same site on Pages answers the eleventh with 429 — review of
   * 2026-09-28). Kept here, it lasts as long as the isolate, as on Pages.
   *
   * Keyed rather than single, so a binding that changes is never served by a
   * transform built for the old one; bounded, because the key includes the
   * request's own origin when ALLOWED_ORIGIN is unset.
   */
  const updatePageHandlers = new Map<string, AnyHandler>();
  const updatePageHandlerFor = (siteUrl: string, wpOrigin: string): AnyHandler => {
    const key = `${siteUrl}\n${wpOrigin}`;
    let handler = updatePageHandlers.get(key);
    if (!handler) {
      if (updatePageHandlers.size >= 8) updatePageHandlers.delete(updatePageHandlers.keys().next().value as string);
      handler = createUpdatePageHandler({
        ...config.updatePage,
        transform: config.updatePage?.transform ?? createDefaultTransform({ siteUrl, wpOrigin }),
      }) as AnyHandler;
      updatePageHandlers.set(key, handler);
    }
    return handler;
  };
  const updatePageOptions = createUpdatePageOptionsHandler() as AnyHandler;

  return {
    async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
      const url = new URL(request.url);
      const serveAsset = () => env.ASSETS.fetch(request);

      if (url.pathname === '/api/update-page') {
        const handler =
          request.method === 'OPTIONS'
            ? updatePageOptions
            : updatePageHandlerFor(primaryOrigin(env.ALLOWED_ORIGIN) || url.origin, env.WP_SOURCE || '');

        return handler(asContext(request, env, ctx, serveAsset));
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
