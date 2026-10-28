/**
 * POST /api/checkout — a buy button in, a Stripe Checkout Session out.
 *
 * docs/STRIPE-COMMERCE.md §3. The browser names what it wants to buy by
 * **Stripe price id or product id, and quantity — never by amount**. A product
 * is sold at its *default price* as Stripe holds it now; every price is fetched
 * live and must be active, on an active product, and belong to this site
 * (`ews_site` in the product's metadata). The charge is therefore always
 * Stripe's price, whatever a page or a browser says.
 *
 * Live rather than from the price cache: the cache decides what a page *shows*
 * and may be up to an hour old; what a customer is *charged* is decided here,
 * against Stripe itself, at the moment of sale.
 *
 * Nothing is stored. The session lives in Stripe; the order is recorded when
 * Stripe's webhook says it was paid (api/stripe-webhook.ts).
 *
 * ## A signed-in buyer's order lands on their account
 *
 * docs/EDGE-ACCOUNTS.md §7. When the request carries a session cookie
 * (`/account/`, sign-in.ts), checkout names the account to Stripe: its Stripe
 * customer when it has one, and otherwise its address and its id as
 * `client_reference_id`, which the webhook uses to link the customer Stripe
 * makes. A visitor who is not signed in buys exactly as before, and so does
 * one whose session cannot be read — a sale never depends on the accounts
 * tables.
 */

import { isAllowedOrigin, getResponseOrigin, corsHeaders } from '../lib/cors.js';
import { createLimiter } from '../lib/rate-limit.js';
import { readJsonObject } from '../lib/body.js';
import { fetchPrice, fetchProduct, isPriceId, isProductId, siteHosts, stripe, StripeError, type PriceView, type StripeEnv } from '../lib/stripe.js';
import { accountFromRequest, sessionToken } from '../lib/sign-in.js';
import { setStripeCustomer, type Account } from '../lib/accounts.js';

export interface CheckoutEnv extends StripeEnv {
  /** The site's origin, or several comma-separated (lib/cors.ts). */
  ALLOWED_ORIGIN: string;
  PAGES_PROJECT?: string;
  /** The site's D1. Read only to find a signed-in buyer's account; a site without accounts sells without it. */
  DB?: D1Database;
}

interface CheckoutBody {
  /** Each names one of `price` or `product`. */
  items?: Array<{ price?: unknown; product?: unknown; quantity?: unknown }>;
  /** The page the buyer came from; they return to it. A path, never a URL. */
  return_path?: unknown;
}

/**
 * Bounds a runaway script. Nothing here guards against a determined one, and
 * nothing needs to: see the note on Turnstile in the handler.
 */
const MAX_ITEMS = 10;
const MAX_QUANTITY = 10;
const RATE_LIMIT = { max: 20, windowMs: 60_000 };

/**
 * The account this request is signed in as, or null.
 *
 * Null too for a site with no database bound, and for a lookup that fails —
 * a site deployed before accounts has no `ews_sessions` table. Never an error:
 * a buyer who cannot be matched buys as a guest, which is what every visitor
 * could do before accounts existed.
 */
async function signedInBuyer(env: CheckoutEnv, request: Request): Promise<Account | null> {
  if (!env.DB || !sessionToken(request)) return null;
  try {
    return await accountFromRequest({ DB: env.DB }, request);
  } catch (error) {
    console.warn('[checkout] the buyer’s session could not be read; selling as a guest:', error instanceof Error ? error.message : error);
    return null;
  }
}

/**
 * Who Stripe records the order against — the parameters that decide it.
 *
 *  - **a guest**: nobody yet. Stripe makes a customer at payment (subscription
 *    mode always does; payment mode is asked to), so receipts have somewhere
 *    to live;
 *  - **a signed-in buyer with a Stripe customer**: that customer, so the order
 *    is on their account and in their portal;
 *  - **a signed-in buyer without one**: their address, prefilled, and the
 *    account id; the webhook links the customer Stripe makes to the account.
 *
 * Stripe refuses `customer` beside `customer_email`, and `customer_creation`
 * has nothing to decide once a customer is named, so each case sends only its
 * own parameters.
 */
function buyerParams(account: Account | null, recurring: boolean, automaticTax: boolean): Record<string, unknown> {
  if (account?.stripeCustomerId) {
    return {
      customer: account.stripeCustomerId,
      client_reference_id: account.id,
      // Stripe Tax with a known customer needs somewhere to keep the address
      // Checkout collects, and refuses the session without it.
      ...(automaticTax ? { customer_update: { address: 'auto' } } : {}),
    };
  }
  return {
    ...(recurring ? {} : { customer_creation: 'always' }),
    ...(account ? { customer_email: account.email, client_reference_id: account.id } : {}),
  };
}

/** A same-site path to come back to; anything else becomes the home page. */
function safeReturnPath(value: unknown): string {
  return typeof value === 'string' && /^\/(?!\/)[^\s#]*$/.test(value) && value.length <= 512 ? value : '/';
}

export function createCheckoutHandler(): PagesFunction<CheckoutEnv> {
  // Per isolate, and bounded: lib/rate-limit.ts forgets expired IPs, where
  // the copy this replaced kept every IP it ever saw.
  const allow = createLimiter(RATE_LIMIT.max, RATE_LIMIT.windowMs);

  return async (context) => {
    const { env, request } = context;
    // Every origin ALLOWED_ORIGIN lists, not only the first: a list of the
    // apex and the `www.` host used to leave the `www.` buyer with a 403.
    const configuredOrigin = String(env.ALLOWED_ORIGIN || '');
    const requestOrigin = request.headers.get('Origin');
    const origin = getResponseOrigin(request, configuredOrigin, env.PAGES_PROJECT);
    const headers = { ...corsHeaders(origin, 'POST, OPTIONS'), 'Content-Type': 'application/json' };
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers });

    // A checkout started from another site's page is not ours to start.
    if (!requestOrigin || !isAllowedOrigin(requestOrigin, configuredOrigin, env.PAGES_PROJECT)) {
      return json({ error: 'Unauthorized origin' }, 403);
    }
    if (!env.STRIPE_SECRET_KEY) return json({ error: 'This site does not sell anything yet.' }, 503);
    if (!allow(request.headers.get('CF-Connecting-IP') || 'unknown')) {
      return json({ error: 'Too many attempts. Please wait a minute.' }, 429);
    }

    // Capped like every other visitor body: a cart is a few ids, and
    // `request.json()` read whatever size it was sent.
    const read = await readJsonObject(request, 16 * 1024);
    if (!read.ok) return json({ error: 'Invalid request' }, read.reason === 'too_large' ? 413 : 400);
    const body = read.body as CheckoutBody;

    /*
     * No Turnstile here, even on a site that binds TURNSTILE_SECRET_KEY for
     * its forms and its sign-in. The buy button (BUY_SCRIPT, lib/commerce-
     * html.ts) renders no widget and sends no token, so verifying one turned
     * every Buy button into a 403 on exactly the sites that followed the
     * advice to protect sign-in (review of 2026-09-28). Nor does a checkout
     * need it: it stores nothing of ours — the session lives in Stripe and
     * lapses there unpaid — so a bot gains nothing a person could not, and
     * the per-IP limit above bounds how fast it can ask.
     */

    const items = Array.isArray(body.items) ? body.items : [];
    if (!items.length || items.length > MAX_ITEMS) return json({ error: 'Nothing to buy.' }, 400);

    const lines: Array<{ view: PriceView; quantity: number }> = [];
    for (const item of items) {
      const quantity = Number(item.quantity ?? 1);
      // Exactly one key: an item naming both would leave which one is charged
      // to the order of two lines below.
      const byPrice = isPriceId(item.price) && item.product === undefined;
      const byProduct = isProductId(item.product) && item.price === undefined;
      if ((!byPrice && !byProduct) || !Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY) {
        return json({ error: 'Invalid item.' }, 400);
      }
      let view: PriceView;
      try {
        view = byPrice ? await fetchPrice(env, item.price as string) : await fetchProduct(env, item.product as string);
      } catch (error) {
        // Unknown to Stripe reads the same as not for sale: say nothing more.
        if (error instanceof StripeError && error.status === 404) return json({ error: 'This item is not available.' }, 400);
        console.error('[checkout] price lookup failed:', error instanceof Error ? error.message : error);
        return json({ error: 'Checkout is unavailable. Please try again shortly.' }, 502);
      }
      if (!view.sellable) return json({ error: 'This item is not available.' }, 400);
      lines.push({ view, quantity });
    }

    // One Checkout Session is one currency.
    if (new Set(lines.map((l) => l.view.currency)).size > 1) return json({ error: 'Items must share a currency.' }, 400);

    const recurring = lines.some((l) => l.view.interval);
    const automaticTax = env.STRIPE_AUTOMATIC_TAX === 'on';
    // Back to the host the buyer came from — checked against ALLOWED_ORIGIN
    // above, so never another site's — and not always the first one listed:
    // a buyer signed in on `www.` holds that host's cookie, and returning
    // them to the apex would show them signed out.
    const site = new URL(requestOrigin).origin;
    const back = `${site}${safeReturnPath(body.return_path)}`;
    const join = back.includes('?') ? '&' : '?';
    const account = await signedInBuyer(env, request);

    const createSession = (buyer: Account | null) =>
      stripe<{ id: string; url: string }>(env, 'POST', '/checkout/sessions', {
        mode: recurring ? 'subscription' : 'payment',
        line_items: Object.fromEntries(lines.map((l, i) => [i, { price: l.view.id, quantity: l.quantity }])),
        success_url: `${back}${join}checkout=success`,
        cancel_url: `${back}${join}checkout=cancelled`,
        ...buyerParams(buyer, recurring, automaticTax),
        ...(automaticTax ? { automatic_tax: { enabled: true } } : {}),
        metadata: { ews_site: siteHosts(env)[0] || '' },
      });

    try {
      let session: { id: string; url: string };
      try {
        session = await createSession(account);
      } catch (error) {
        // The account's Stripe customer was deleted in Stripe — by the owner,
        // in the dashboard. Left alone, this buyer could never check out
        // again. Forget the customer and sell as a first purchase: the webhook
        // links the one Stripe makes now.
        const customerGone = error instanceof StripeError && error.code === 'resource_missing' && error.param === 'customer';
        if (!account?.stripeCustomerId || !customerGone || !env.DB) throw error;
        console.warn(`[checkout] account ${account.id}'s Stripe customer no longer exists; this purchase links a new one.`);
        await setStripeCustomer({ DB: env.DB }, account, '');
        session = await createSession({ ...account, stripeCustomerId: '' });
      }
      return json({ url: session.url });
    } catch (error) {
      console.error('[checkout] session creation failed:', error instanceof Error ? error.message : error);
      return json({ error: 'Checkout is unavailable. Please try again shortly.' }, 502);
    }
  };
}

export function createCheckoutOptionsHandler(): PagesFunction<CheckoutEnv> {
  return async (context) => {
    const origin = getResponseOrigin(context.request, String(context.env.ALLOWED_ORIGIN || ''), context.env.PAGES_PROJECT);
    return new Response(null, { status: 204, headers: corsHeaders(origin, 'POST, OPTIONS') });
  };
}
