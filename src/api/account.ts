/**
 * The four sign-in endpoints — docs/EDGE-ACCOUNTS.md §5.
 *
 *   POST /api/account/request   { email }            → a link is sent, or not, and the answer is the same
 *   POST /api/account/verify    { token, auto? }     → the link spent, and a session cookie
 *   GET  /api/account/verify?token=…                 → to the account page, the link left unspent
 *   POST /api/account/signout                        → this session ends
 *   GET  /api/account/me                             → who this request is, for the account page
 *   GET  /api/account/orders                         → their orders, read live from Stripe
 *
 * ## Who sends the mail
 *
 * A site that binds a mail transport (lib/mail.ts: the owner's Brevo key, or a
 * relay Worker, plus `MAIL_FROM`) sends the link from the edge, so signing in
 * does not need the origin to be up. Otherwise — and whenever that transport
 * fails — the edge asks the plugin to deliver it, signed with the X-EWS
 * scheme, and WordPress sends it with its own mail set-up. Either way no mail
 * key is held by us: a provider key is the site owner's secret, in their
 * Cloudflare account.
 *
 * ## The answer never says who has an account
 *
 * `request` answers the same for an address with an account, one without, one
 * blocked, and one that asked too often. Any difference turns this into a way
 * of asking "does this person buy here?". The only distinguishable answer is
 * for an address that is not an address at all.
 *
 * ## Following a link spends nothing; pressing the button does
 *
 * The mailed link is the account page with the token after `#`
 * (`/account/#signin=…`). Mail scanners — Outlook's among them — open links to
 * check them, and a link that signed in on a GET was spent by the scanner
 * before the person clicked, who then read "already used". A fragment never
 * reaches a server, so a scanner fetches a static page and nothing more, and
 * only a POST spends the link. The token stays out of server logs for the same
 * reason.
 *
 * **In the browser that asked, opening the link is enough** (since 2026-09-23).
 * Asking leaves a marker cookie there (lib/sign-in.ts, "Which browser asked"),
 * and the page POSTs `{token, auto: true}` as it opens; with the marker that
 * signs in. Without it — another device, a mail app's own browser, a scanner
 * that runs the page — nothing is spent and the page shows a button, whose
 * POST (no `auto`) spends the link as before.
 *
 * The POST checks Origin, like every state-changing endpoint here: without it
 * another site could sign a visitor in to an account of the other site's
 * choosing. A GET of the old `?token=` form, from a mail sent before this, is
 * answered with a redirect to the page — still unspent.
 */

import { corsHeaders, getResponseOrigin, isAllowedOrigin } from '../lib/cors.js';
import { createLimiter } from '../lib/rate-limit.js';
import { readJsonObject } from '../lib/body.js';
import { validateTurnstile } from '../lib/turnstile.js';
import { accountCustomers, adoptCustomer, saveProfile, type Account, type AccountsEnv } from '../lib/accounts.js';
import { belongsToSite, stripe, type StripeEnv } from '../lib/stripe.js';
import { mailTransport, sendMail, signInMail, siteName, type MailEnv } from '../lib/mail.js';
import { fetchFromWordPress } from '../lib/wp-fetch.js';
import {
  LOGIN_TOKEN_TTL_SECONDS, accountFromRequest, accountPath, askedHere, browserMarker, clearedCookie, completeSignIn,
  endSession, hashToken, newToken, pendingCookie, pendingMarkers, requestSignIn, sessionCookie, signInLinkState,
  sweepExpired, type SignInEnv,
} from '../lib/sign-in.js';

export interface AccountApiEnv extends AccountsEnv, SignInEnv, StripeEnv, MailEnv {
  ALLOWED_ORIGIN: string;
  PAGES_PROJECT?: string;
  /** The WordPress that sends the mail, and the secret that proves us to it. */
  WP_SOURCE?: string;
  SYNC_SECRET?: string;
  /**
   * Where a visitor lands after following the link, and where the page lives.
   * `/account/` unless the site says otherwise — a French site sells from
   * `/compte/`, and nothing in this runtime should assume English.
   */
  ACCOUNT_PATH?: string;
  /**
   * Turnstile, as the contact and form endpoints take it. Optional, and worth
   * setting on a site that sells: without it, a script can ask for links to a
   * thousand addresses an hour and each one leaves **the site's own mail
   * server**, which is the site's reputation rather than ours.
   */
  TURNSTILE_SECRET_KEY?: string;
}

/** One in twenty requests also clears out what has expired. */
const SWEEP_CHANCE = 0.05;

/**
 * How long a sign-in request waits for WordPress to take the mail. The visitor
 * is waiting on this answer; WordPress's wp_mail() is the slow part.
 */
const WORDPRESS_MAIL_TIMEOUT_MS = 10_000;

/**
 * The largest body these endpoints read: an address, a token or a name, and a
 * Turnstile token (about 2 KB). They read `request.json()` with no limit, and
 * a body of `null` threw a TypeError — a 500 — until 2026-10-28; every other
 * visitor endpoint already read through readJsonObject.
 */
const MAX_BODY_BYTES = 8 * 1024;

const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra },
  });

/**
 * Send the link: through the site's own mail transport when it has one, and
 * through WordPress otherwise or when that transport fails.
 *
 * Returns false when it could not be sent, which the caller does **not** pass
 * on to the visitor as a distinct answer: the log says what happened, and the
 * visitor is told a link is on its way either way. An address that never
 * receives one tries again; an attacker learns nothing.
 */
async function sendLink(env: AccountApiEnv, email: string, link: string, expiresAt: number, lang: unknown): Promise<boolean> {
  const via = mailTransport(env);
  if (via) {
    const minutes = Math.round(LOGIN_TOKEN_TTL_SECONDS / 60);
    const outcome = await sendMail(env, { to: email, ...signInMail({ link, minutes, site: siteName(env), lang }) });
    if (outcome.sent) return true;
    const fallback = env.WP_SOURCE && env.SYNC_SECRET ? '; asking WordPress to send it instead' : '';
    console.warn(`[account] the sign-in mail was not sent through ${via}: ${outcome.reason}${'status' in outcome && outcome.status ? ` (HTTP ${outcome.status})` : ''}${fallback}.`);
  }
  return sendThroughWordPress(env, email, link, expiresAt);
}

/** Ask WordPress to send the link, with `wp_mail()` and the site's own mail set-up. */
async function sendThroughWordPress(env: AccountApiEnv, email: string, link: string, expiresAt: number): Promise<boolean> {
  if (!env.WP_SOURCE || !env.SYNC_SECRET) {
    console.warn('[account] no WP_SOURCE or SYNC_SECRET: the sign-in link cannot be sent.');
    return false;
  }
  const body = JSON.stringify({
    action: 'account-mail',
    kind: 'sign-in',
    email,
    link,
    expires_at: expiresAt,
    expires_minutes: Math.round(LOGIN_TOKEN_TTL_SECONDS / 60),
  });

  try {
    // Through wp-fetch, like every other request to the origin: signed v2 for
    // this method and URL (it was v1 only, so it would have been refused the
    // day WordPress required v2, while the visitor was told a link was on its
    // way), Basic Auth where the origin is sealed at Apache, the origin
    // asserted, and a deadline a visitor is waiting on. Until 2026-10-28 it was
    // the one raw fetch to WordPress left in this runtime.
    const response = await fetchFromWordPress(`${env.WP_SOURCE.replace(/\/$/, '')}/wp-json/edge-publish/v1/account-mail`, env, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    }, { timeoutMs: WORDPRESS_MAIL_TIMEOUT_MS });
    if (!response.ok) {
      console.warn(`[account] WordPress did not send the sign-in mail: HTTP ${response.status}`);
      return false;
    }
    return true;
  } catch (error) {
    console.warn('[account] WordPress could not be reached to send the sign-in mail:', error instanceof Error ? error.message : error);
    return false;
  }
}

export function createAccountRequestHandler(): PagesFunction<AccountApiEnv> {
  const allow = createLimiter(10, 60_000);

  return async (context) => {
    const { env, request } = context;
    const configuredOrigin = String(env.ALLOWED_ORIGIN || '');
    const requestOrigin = request.headers.get('Origin');
    const origin = getResponseOrigin(request, configuredOrigin, env.PAGES_PROJECT);
    const headers = corsHeaders(origin, 'POST, OPTIONS');

    if (!requestOrigin || !isAllowedOrigin(requestOrigin, configuredOrigin, env.PAGES_PROJECT)) {
      return json({ error: 'Unauthorized origin' }, 403, headers);
    }
    if (!allow(request.headers.get('CF-Connecting-IP') || 'unknown')) {
      return json({ error: 'Too many attempts. Please wait a minute.' }, 429, headers);
    }

    const read = await readJsonObject(request, MAX_BODY_BYTES);
    if (!read.ok) return json({ error: read.reason === 'too_large' ? 'Request too large' : 'Invalid request' }, read.reason === 'too_large' ? 413 : 400, headers);
    const body = read.body as { email?: unknown; lang?: unknown; 'cf-turnstile-response'?: string };

    if (env.TURNSTILE_SECRET_KEY) {
      const human = await validateTurnstile(
        body['cf-turnstile-response'] || '',
        env.TURNSTILE_SECRET_KEY,
        request.headers.get('CF-Connecting-IP') || undefined
      );
      if (!human) return json({ error: 'Please confirm you are not a robot.' }, 403, headers);
    }

    if (Math.random() < SWEEP_CHANCE) await sweepExpired(env).catch(() => {});

    const outcome = await requestSignIn(env, String(body.email ?? ''));
    if (!outcome.ok && outcome.reason === 'invalid-email') {
      return json({ error: 'That does not look like an email address.' }, 400, headers);
    }

    // Everything below answers the same, whatever happened — the cookie too:
    // this browser gets a marker for the link it asked for, or one that
    // matches nothing when no link was made, so the answer never differs by
    // whether it did (lib/sign-in.ts, "Which browser asked").
    const sent = { sent: true, message: 'If that address has an account here, a sign-in link is on its way.' };
    const marker = outcome.ok ? await browserMarker(outcome.token) : (await hashToken(newToken())).slice(0, 32);
    const answer = { ...headers, 'Set-Cookie': pendingCookie([marker, ...pendingMarkers(request)]) };
    if (!outcome.ok) return json(sent, 200, answer);

    // The host the visitor asked from, already checked against the list: the
    // link must sign them in where they are. Until 2026-10-28 every check here
    // read only ALLOWED_ORIGIN's first entry, so a buyer on a second listed
    // host (www.) was refused at the door — and a link to the first host
    // would have set its cookie where they were not.
    const site = requestOrigin;
    // The account page, with the token after `#`: never sent to a server, so a
    // scanner that opens the link cannot spend it (see the header).
    const link = `${site.replace(/\/$/, '')}${accountPath(env)}#signin=${encodeURIComponent(outcome.token)}`;
    // `lang`: the account page's own language, so the mail matches the site.
    await sendLink(env, String(body.email).trim().toLowerCase(), link, outcome.expiresAt, body.lang);
    return json(sent, 200, answer);
  };
}

/** Why a link did not sign anyone in, in words; the account page says it in the site's language. */
const LINK_REFUSED = {
  unknown: 'This sign-in link is not one we made.',
  expired: 'This sign-in link has expired. Ask for another and it will arrive in a moment.',
  used: 'This sign-in link has already been used. Ask for another one.',
  blocked: 'This account cannot sign in. Please get in touch if you think that is a mistake.',
} as const;

/** The shape a token takes (sign-in.ts `newToken`); anything else is not looked up. */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{20,200}$/;

export function createAccountVerifyHandler(): PagesFunction<AccountApiEnv> {
  return async (context) => {
    const { env, request } = context;
    const path = accountPath(env);

    if (request.method !== 'POST') {
      // A link of the old form, or anything opening this URL: to the page,
      // with the token moved after `#`. Nothing is spent here.
      const token = new URL(request.url).searchParams.get('token') || '';
      const location = TOKEN_SHAPE.test(token) ? `${path}#signin=${token}` : path;
      return new Response(null, { status: 303, headers: { Location: location, 'Cache-Control': 'no-store' } });
    }

    const configuredOrigin = String(env.ALLOWED_ORIGIN || '');
    const origin = getResponseOrigin(request, configuredOrigin, env.PAGES_PROJECT);
    const headers = corsHeaders(origin, 'GET, POST, OPTIONS');
    if (!isAllowedOrigin(request.headers.get('Origin') || '', configuredOrigin, env.PAGES_PROJECT)) {
      return json({ error: 'Unauthorized origin' }, 403, headers);
    }

    const read = await readJsonObject(request, MAX_BODY_BYTES);
    if (!read.ok) return json({ error: read.reason === 'too_large' ? 'Request too large' : 'Invalid request' }, read.reason === 'too_large' ? 413 : 400, headers);
    const body = read.body as { token?: unknown; auto?: unknown };
    const token = typeof body.token === 'string' && TOKEN_SHAPE.test(body.token) ? body.token : '';

    // `auto`: the page asking, on opening the link, before anyone pressed
    // anything. Honoured only in the browser that asked for this link; anywhere
    // else — another device, a mail app's browser, a scanner running the page —
    // nothing is spent and the page shows its button. An expired or spent link
    // says so now rather than after the press.
    if (body.auto === true && !(await askedHere(request, token))) {
      const state = await signInLinkState(env, token);
      if (state !== 'ok') return json({ error: LINK_REFUSED[state], reason: state }, 400, headers);
      return json({ signedIn: false, confirm: true }, 200, headers);
    }

    const outcome = await completeSignIn(env, token);

    if (!outcome.ok) {
      return json({ error: LINK_REFUSED[outcome.reason], reason: outcome.reason }, outcome.reason === 'blocked' ? 403 : 400, headers);
    }
    return json({ signedIn: true }, 200, { ...headers, 'Set-Cookie': sessionCookie(outcome.session) });
  };
}

export function createAccountSignOutHandler(): PagesFunction<AccountApiEnv> {
  return async (context) => {
    const { env, request } = context;
    const configuredOrigin = String(env.ALLOWED_ORIGIN || '');
    const origin = getResponseOrigin(request, configuredOrigin, env.PAGES_PROJECT);
    const headers = corsHeaders(origin, 'POST, OPTIONS');
    if (!isAllowedOrigin(request.headers.get('Origin') || '', configuredOrigin, env.PAGES_PROJECT)) {
      return json({ error: 'Unauthorized origin' }, 403, headers);
    }
    await endSession(env, request);
    return json({ signedOut: true }, 200, { ...headers, 'Set-Cookie': clearedCookie() });
  };
}

/**
 * What the account page is told about an account. `billing` says whether the
 * account has bought here — whether its orders and "Manage billing" apply —
 * without handing the browser the Stripe customer id, which it has no use for.
 */
const accountView = (account: Account) => ({
  email: account.email,
  name: account.name,
  billing: Boolean(account.stripeCustomerId),
});

/**
 * An account that has not bought signed in may still have bought: as a guest,
 * before the account existed, with the same address. The account page asks
 * this endpoint first, so this is where those purchases are found — and the
 * newest customer made the account's primary one (`adoptCustomer`), which is
 * what shows its orders and **Manage billing** from the first sign-in.
 *
 * One Stripe read per page view, only for an account with no primary
 * customer. Never a failure of the page: Stripe unreachable means the account
 * shows as it did, and the next view looks again.
 */
async function withPurchases(env: AccountApiEnv, account: Account): Promise<Account> {
  if (account.stripeCustomerId || !env.STRIPE_SECRET_KEY) return account;
  try {
    return await adoptCustomer(env, account);
  } catch (error) {
    console.warn('[account] earlier purchases could not be looked up in Stripe:', error instanceof Error ? error.message : error);
    return account;
  }
}

/**
 * Who this request is, and — with a POST — the profile fields the customer
 * owns. Never status: that is the owner's, and arrives from WordPress.
 */
export function createAccountMeHandler(): PagesFunction<AccountApiEnv> {
  return async (context) => {
    const { env, request } = context;
    const configuredOrigin = String(env.ALLOWED_ORIGIN || '');
    const origin = getResponseOrigin(request, configuredOrigin, env.PAGES_PROJECT);
    const headers = corsHeaders(origin, 'GET, POST, OPTIONS');

    const found = await accountFromRequest(env, request);
    if (!found) return json({ signedIn: false }, 200, headers);
    const account = request.method === 'POST' ? found : await withPurchases(env, found);

    if (request.method === 'POST') {
      if (!isAllowedOrigin(request.headers.get('Origin') || '', configuredOrigin, env.PAGES_PROJECT)) {
        return json({ error: 'Unauthorized origin' }, 403, headers);
      }
      const read = await readJsonObject(request, MAX_BODY_BYTES);
      if (!read.ok) return json({ error: read.reason === 'too_large' ? 'Request too large' : 'Invalid request' }, read.reason === 'too_large' ? 413 : 400, headers);
      const body = read.body as { name?: unknown };
      const saved = await saveProfile(env, account, { name: body.name });
      return json({ signedIn: true, account: accountView(saved) }, 200, headers);
    }

    return json({ signedIn: true, account: accountView(account) }, 200, headers);
  };
}

/** How many of a customer's most recent orders the account page lists. */
const ORDERS_SHOWN = 20;

/** The fields of a Checkout Session, `line_items` expanded, that an order line needs. */
interface StripeSession {
  id: string;
  created: number;
  amount_total: number | null;
  currency: string | null;
  payment_status: string;
  mode: string;
  metadata?: Record<string, string>;
  line_items?: { data?: Array<{ description?: string | null; quantity?: number | null }> };
}

/**
 * The signed-in customer's orders, newest first — read live from Stripe on
 * every request and never copied, because Stripe is the one writer of orders
 * (docs/EDGE-ACCOUNTS.md §2). The edge's own `ews_stripe_orders` holds amounts
 * and statuses with no person attached, and is not what this reads.
 *
 * Only completed checkouts, only this site's (one Stripe account may sell for
 * several), and only the account's own customers: its primary one and every
 * customer of this site carrying its address (`accountCustomers`) — so an
 * order placed as a guest, before or after the account was made, is listed
 * with the rest. The request says nothing about whose orders these are beyond
 * its session cookie; the address comes from the account row.
 */
export function createAccountOrdersHandler(): PagesFunction<AccountApiEnv> {
  return async (context) => {
    const { env, request } = context;
    const configuredOrigin = String(env.ALLOWED_ORIGIN || '');
    const origin = getResponseOrigin(request, configuredOrigin, env.PAGES_PROJECT);
    const headers = corsHeaders(origin, 'GET, OPTIONS');

    const account = await accountFromRequest(env, request);
    if (!account) return json({ error: 'Please sign in first.' }, 401, headers);
    if (!env.STRIPE_SECRET_KEY) return json({ orders: [] }, 200, headers);

    try {
      let customers: string[];
      try {
        customers = await accountCustomers(env, account);
      } catch (error) {
        // The address could not be looked up — Stripe busy, or a key without
        // Customers read. The primary customer's orders are still known, and
        // showing those beats showing none.
        console.warn('[account] purchases made with the address could not be looked up; listing the account’s own customer only:', error instanceof Error ? error.message : error);
        customers = account.stripeCustomerId ? [account.stripeCustomerId] : [];
      }
      // One list per customer, each already newest first and capped; merged,
      // they are sorted again and capped again.
      const lists = await Promise.all(customers.map((customer) =>
        stripe<{ data?: StripeSession[] }>(env, 'GET', '/checkout/sessions', {
          customer,
          status: 'complete',
          limit: ORDERS_SHOWN,
          // `line_items` is left out of a session unless asked for, and `data.`
          // asks for it on every session in the list (Stripe, "Expanding
          // responses").
          expand: ['data.line_items'],
        })
      ));
      const orders = lists
        .flatMap((list) => list.data ?? [])
        .filter((session) => belongsToSite(session.metadata, env))
        .sort((a, b) => b.created - a.created)
        .slice(0, ORDERS_SHOWN)
        .map((session) => ({
          created: session.created,
          total: session.amount_total,
          currency: session.currency ?? '',
          status: session.payment_status,
          mode: session.mode,
          items: (session.line_items?.data ?? []).map((line) => ({
            name: String(line.description ?? ''),
            quantity: Number(line.quantity ?? 1),
          })),
        }));
      return json({ orders }, 200, headers);
    } catch (error) {
      console.error('[account] orders could not be read from Stripe:', error instanceof Error ? error.message : error);
      return json({ error: 'Your orders could not be loaded just now.' }, 502, headers);
    }
  };
}

export function createAccountOptionsHandler(): PagesFunction<AccountApiEnv> {
  return async (context) => {
    const configuredOrigin = String(context.env.ALLOWED_ORIGIN || '');
    const origin = getResponseOrigin(context.request, configuredOrigin, context.env.PAGES_PROJECT);
    return new Response(null, { status: 204, headers: corsHeaders(origin, 'GET, POST, OPTIONS') });
  };
}
