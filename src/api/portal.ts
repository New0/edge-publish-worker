/**
 * POST /api/portal — a signed-in customer to Stripe's billing portal.
 *
 * docs/STRIPE-COMMERCE.md §4 and docs/EDGE-ACCOUNTS.md §7. The portal is
 * Stripe's own page for receipts, subscriptions and saved cards, so none of
 * that is built or stored here: this endpoint only proves who is asking and
 * hands them a short-lived portal link for **their** Stripe customer.
 *
 *   POST /api/portal   (session cookie)   → { url }
 *
 * ## Who can open it
 *
 * A visitor signed in to an account that has bought here — signed in, or as a
 * guest with the account's address. Not signed in is 401; signed in with
 * nothing bought yet is 409, which the account page never offers, since
 * `/api/account/me` says whether there is billing to manage.
 *
 * The portal is Stripe's page for **one** customer: the account's primary one.
 * A person who bought as a guest more than once has more than one customer in
 * Stripe, which never merges them; their orders all appear on the account
 * page, and a subscription on a customer other than the primary is managed
 * from Stripe's own portal log-in, or by the owner.
 *
 * The customer id comes from the account row, never from the request: a
 * browser naming a customer could open anyone's portal.
 *
 * ## Why a POST that checks Origin
 *
 * The session cookie is `SameSite=Lax`, so another site's page cannot send it
 * with a POST; the Origin check says the same thing a second way, as the other
 * account endpoints do. Opening a portal changes nothing by itself, but its
 * link is a bearer credential for the customer's billing, and it should only
 * ever reach this site's own page.
 */

import { corsHeaders, getResponseOrigin, isAllowedOrigin } from '../lib/cors.js';
import { createLimiter } from '../lib/rate-limit.js';
import { accountFromRequest, accountPath, type SignInEnv } from '../lib/sign-in.js';
import { adoptCustomer, setStripeCustomer } from '../lib/accounts.js';
import { stripe, StripeError, type StripeEnv } from '../lib/stripe.js';

export interface PortalEnv extends SignInEnv, StripeEnv {
  ALLOWED_ORIGIN: string;
  PAGES_PROJECT?: string;
  /** Where Stripe sends the customer back to; `/account/` unless the site says otherwise. */
  ACCOUNT_PATH?: string;
}

const RATE_LIMIT = { max: 10, windowMs: 60_000 };

export function createPortalHandler(): PagesFunction<PortalEnv> {
  const allow = createLimiter(RATE_LIMIT.max, RATE_LIMIT.windowMs);

  return async (context) => {
    const { env, request } = context;
    const configuredOrigin = String(env.ALLOWED_ORIGIN || '');
    const origin = getResponseOrigin(request, configuredOrigin, env.PAGES_PROJECT);
    const headers = { ...corsHeaders(origin, 'POST, OPTIONS'), 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers });

    const requestOrigin = request.headers.get('Origin');
    if (!requestOrigin || !isAllowedOrigin(requestOrigin, configuredOrigin, env.PAGES_PROJECT)) {
      return json({ error: 'Unauthorized origin' }, 403);
    }
    if (!env.STRIPE_SECRET_KEY) return json({ error: 'This site does not sell anything yet.' }, 503);
    if (!allow(request.headers.get('CF-Connecting-IP') || 'unknown')) {
      return json({ error: 'Too many attempts. Please wait a minute.' }, 429);
    }

    const signedIn = await accountFromRequest(env, request);
    if (!signedIn) return json({ error: 'Please sign in first.' }, 401);
    const nothingYet = () => json({ error: 'There is nothing to manage yet: billing opens after your first purchase.' }, 409);
    // Bought only as a guest, with this address: that customer becomes the
    // account's, as `/api/account/me` would have made it (lib/accounts.ts).
    let account = signedIn;
    try {
      account = await adoptCustomer(env, signedIn);
    } catch (error) {
      console.warn('[portal] earlier purchases could not be looked up in Stripe:', error instanceof Error ? error.message : error);
    }
    if (!account.stripeCustomerId) return nothingYet();

    // Back to the host the visitor came from, already checked against the list.
    const site = requestOrigin.replace(/\/$/, '');
    try {
      const session = await stripe<{ url: string }>(env, 'POST', '/billing_portal/sessions', {
        customer: account.stripeCustomerId,
        return_url: `${site}${accountPath(env)}`,
        ...(env.STRIPE_PORTAL_CONFIGURATION ? { configuration: env.STRIPE_PORTAL_CONFIGURATION } : {}),
      });
      return json({ url: session.url });
    } catch (error) {
      if (error instanceof StripeError && error.code === 'resource_missing' && error.param === 'customer') {
        // Deleted in Stripe's dashboard. Forget it, as checkout does: the next
        // purchase links a new one, and until then there is nothing to manage.
        console.warn(`[portal] account ${account.id}'s Stripe customer no longer exists; unlinked.`);
        await setStripeCustomer(env, account, '');
        return nothingYet();
      }
      // Stripe's own message says what to do — typically that the portal's
      // settings were never saved in the dashboard, which a new account (and
      // every account's test mode) starts without. The owner reads the log;
      // the customer is told only that it is unavailable.
      console.error('[portal] Stripe refused a portal session:', error instanceof Error ? error.message : error);
      return json({ error: 'Managing billing is not available right now. Please try again later.' }, 503);
    }
  };
}

export function createPortalOptionsHandler(): PagesFunction<PortalEnv> {
  return async (context) => {
    const configuredOrigin = String(context.env.ALLOWED_ORIGIN || '');
    const origin = getResponseOrigin(context.request, configuredOrigin, context.env.PAGES_PROJECT);
    return new Response(null, { status: 204, headers: corsHeaders(origin, 'POST, OPTIONS') });
  };
}
