/**
 * POST /api/stripe-webhook — Stripe's events in.
 *
 * docs/STRIPE-COMMERCE.md §4. Four jobs:
 *
 *  - **keep the price cache true**: a price or product changed in Stripe is
 *    re-read and re-stored, so the next page view shows it (the middleware
 *    renders prices from that cache). Both caches: prices by price id, and
 *    products by product id with their *default* price — so a product whose
 *    default price was replaced (`product.updated`) shows the new one;
 *  - **record paid orders**: `checkout.session.completed`, with the session id,
 *    amount, currency and status — **no name, email or address**. Those stay in
 *    Stripe, the processor; this database holds nothing about a person. Every
 *    order also **lands on the account for its buyer's address**, whether that
 *    account exists yet or not (docs/EDGE-ACCOUNTS.md §7, `linkBuyer`): the
 *    customer Stripe made is given the address lowercased and this site's tag,
 *    and an account without a primary customer is linked to it;
 *  - **tell the owner**: the first time a checkout is paid, WordPress is asked
 *    — signed — to mail the site's administrator (the plugin's `order-mail`
 *    route). Guests may buy, so this is how an owner hears of an order
 *    without reading Stripe. The buyer's name and address travel to WordPress
 *    for that mail and are stored by neither side;
 *  - **do each event once.** Stripe retries until it gets a 2xx, and may
 *    deliver an event twice. Every write here is an upsert, so doing one twice
 *    is harmless, and the event id is recorded after the work so a retry of a
 *    finished event is answered without repeating it.
 *
 * The signature is checked over the raw body before anything is parsed — the
 * same rule as the X-EWS scheme, and for the same reason.
 */

import {
  decimalAmount, fetchPrice, fetchProduct, storePrice, storeProduct, stripe, verifyStripeSignature, belongsToSite, StripeError,
  type StripeEnv, type StripePrice,
} from '../lib/stripe.js';
import { claimCustomer, findByEmail, findById, linkStripeCustomer, normalizeEmail } from '../lib/accounts.js';
import { fetchFromWordPress, type WpOriginEnv } from '../lib/wp-fetch.js';

export interface StripeWebhookEnv extends StripeEnv, WpOriginEnv {
  ALLOWED_ORIGIN?: string;
  DB: D1Database;
  /** Signs the order mail's request to WordPress. Without it and WP_SOURCE, no mail is asked for. */
  SYNC_SECRET?: string;
}

interface StripeEvent {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** Has this event already been handled? */
async function alreadyHandled(db: D1Database, id: string): Promise<boolean> {
  const row = await db.prepare('SELECT id FROM ews_stripe_events WHERE id = ?1').bind(id).first<{ id: string }>();
  return row !== null;
}

async function markHandled(db: D1Database, event: StripeEvent): Promise<void> {
  await db
    .prepare('INSERT INTO ews_stripe_events (id, type, received_at) VALUES (?1, ?2, ?3) ON CONFLICT (id) DO NOTHING')
    .bind(event.id, event.type, Math.floor(Date.now() / 1000))
    .run();
}

/**
 * Re-read a price from Stripe rather than trusting the event's copy: the event
 * carries the product as an id, and whether it is sellable depends on the
 * product's state and metadata too.
 */
async function refreshPrice(env: StripeWebhookEnv, priceId: string): Promise<void> {
  try {
    await storePrice(env.DB, await fetchPrice(env, priceId));
  } catch (error) {
    // Gone from Stripe: forget it, so pages show it as unavailable. Anything
    // else is transient and rethrown, so Stripe retries the event.
    if (error instanceof StripeError && error.status === 404) {
      await env.DB.prepare('DELETE FROM ews_stripe_prices WHERE id = ?1').bind(priceId).run();
      return;
    }
    throw error;
  }
}

/**
 * Re-read a product's default price, **if a page has asked for it** — the
 * cache holds what pages show, and one Stripe account may carry other sites'
 * products this site must not fill its table with.
 */
async function refreshCachedProduct(env: StripeWebhookEnv, productId: string): Promise<void> {
  const cached = await env.DB
    .prepare('SELECT product_id FROM ews_stripe_products WHERE product_id = ?1')
    .bind(productId)
    .first<{ product_id: string }>();
  if (!cached) return;
  try {
    await storeProduct(env.DB, await fetchProduct(env, productId));
  } catch (error) {
    if (error instanceof StripeError && error.status === 404) {
      await env.DB.prepare('DELETE FROM ews_stripe_products WHERE product_id = ?1').bind(productId).run();
      return;
    }
    throw error;
  }
}

/** A product changed: every cached price of it, and its default price, are re-read. */
async function refreshProduct(env: StripeWebhookEnv, productId: string): Promise<void> {
  const { results } = await env.DB
    .prepare('SELECT id FROM ews_stripe_prices WHERE product_id = ?1')
    .bind(productId)
    .all<{ id: string }>();
  for (const row of results ?? []) await refreshPrice(env, row.id);
  await refreshCachedProduct(env, productId);
}

/** A checkout status that means the money arrived, or that none was owed. */
const SETTLED = new Set(['paid', 'no_payment_required']);

/**
 * Record a checkout's outcome. Answers whether the session was this site's at
 * all, and whether **this** event is the one that settled it — so the owner
 * hears of an order once: not again for a second delivery, and not a second
 * time when `async_payment_succeeded` follows a session that completed
 * unpaid. Two deliveries of one event racing each other could both see it
 * unsettled and mail twice; Stripe sends them serially, so that is rare, and
 * two mails is the harmless side to err on.
 *
 * **A settled order stays settled.** Stripe does not promise to deliver events
 * in order, and a session never goes from paid back to unpaid (a refund is a
 * charge event; the session keeps `paid`). So a `completed` that arrives
 * unpaid after `async_payment_succeeded`, or a stale retry of it, is old news,
 * and the upsert ignores it in the statement itself — the check above is a
 * read, and two events can pass it together. Until 2026-10-28 it wrote any
 * status over any other.
 */
async function recordOrder(env: StripeWebhookEnv, session: Record<string, unknown>): Promise<{ ours: boolean; settledNow: boolean }> {
  const metadata = (session.metadata ?? {}) as Record<string, string>;
  // A session another site created on the same Stripe account is not ours.
  if (!belongsToSite(metadata, env)) return { ours: false, settledNow: false };
  const before = await env.DB
    .prepare('SELECT payment_status FROM ews_stripe_orders WHERE session_id = ?1')
    .bind(String(session.id))
    .first<{ payment_status: string }>();
  await env.DB
    .prepare(
      `INSERT INTO ews_stripe_orders (session_id, mode, amount_total, currency, payment_status, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT (session_id) DO UPDATE SET payment_status = ?5
       WHERE ews_stripe_orders.payment_status NOT IN ('paid', 'no_payment_required')`
    )
    .bind(
      String(session.id),
      String(session.mode ?? ''),
      Number(session.amount_total ?? 0),
      String(session.currency ?? ''),
      String(session.payment_status ?? ''),
      Number(session.created ?? Math.floor(Date.now() / 1000))
    )
    .run();
  return { ours: true, settledNow: SETTLED.has(String(session.payment_status ?? '')) && !SETTLED.has(before?.payment_status ?? '') };
}

/**
 * Ask WordPress to mail the administrator about a paid order. Never throws and
 * never fails the event: the order is recorded, and it is in Stripe either
 * way. What went wrong is logged, with the session id and no address.
 */
async function sendOrderMail(env: StripeWebhookEnv, session: Record<string, unknown>): Promise<void> {
  const id = String(session.id);
  const currency = String(session.currency ?? '').toUpperCase();
  try {
    // A completed session does not carry its line items; one read fetches
    // them. Without them the mail still goes, and says the order is in Stripe.
    let items: Array<{ name: string; quantity: number; total: string }> = [];
    try {
      const lines = await stripe<{ data?: Array<{ description?: unknown; quantity?: unknown; amount_total?: unknown; currency?: unknown }> }>(
        env, 'GET', `/checkout/sessions/${encodeURIComponent(id)}/line_items`, { limit: 100 }
      );
      items = (lines.data ?? []).map((line) => ({
        name: String(line.description ?? ''),
        quantity: Number(line.quantity ?? 1),
        total: decimalAmount(line.amount_total, String(line.currency ?? currency)),
      }));
    } catch (error) {
      console.warn(`[stripe-webhook] ${id}: the order's items could not be read for the owner's mail:`, error instanceof Error ? error.message : error);
    }

    const details = (session.customer_details ?? {}) as { email?: unknown; name?: unknown };
    const intent = typeof session.payment_intent === 'string' ? session.payment_intent : '';
    const test = session.livemode !== true;
    const body = JSON.stringify({
      action: 'order-mail',
      v: 1,
      order: {
        session: id,
        status: String(session.payment_status ?? ''),
        mode: String(session.mode ?? ''),
        created: Number(session.created ?? Math.floor(Date.now() / 1000)),
        test,
        total: decimalAmount(session.amount_total, currency),
        currency,
        items,
        buyer: {
          email: typeof details.email === 'string' ? details.email : '',
          name: typeof details.name === 'string' ? details.name : '',
        },
        // Checkout names the account of a signed-in buyer; a guest has none.
        signed_in: typeof session.client_reference_id === 'string' && session.client_reference_id !== '',
        stripe_url: /^pi_[A-Za-z0-9]+$/.test(intent) ? `https://dashboard.stripe.com/${test ? 'test/' : ''}payments/${intent}` : '',
      },
    });
    const response = await fetchFromWordPress(`${String(env.WP_SOURCE).replace(/\/$/, '')}/wp-json/edge-publish/v1/order-mail`, env, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    if (!response.ok) console.warn(`[stripe-webhook] ${id}: WordPress did not send the owner's order mail: HTTP ${response.status}`);
  } catch (error) {
    console.warn(`[stripe-webhook] ${id}: WordPress could not be asked to mail the owner:`, error instanceof Error ? error.message : error);
  }
}

/**
 * Tell the owner, after Stripe has its answer where the runtime allows it
 * (`waitUntil`): WordPress being slow must not hold a webhook Stripe will
 * time out and retry. Where there is no `waitUntil`, it is awaited.
 */
async function tellOwner(context: { waitUntil?: (promise: Promise<unknown>) => void }, env: StripeWebhookEnv, session: Record<string, unknown>): Promise<void> {
  if (!env.WP_SOURCE || !env.SYNC_SECRET) return;
  const sending = sendOrderMail(env, session);
  if (typeof context.waitUntil === 'function') context.waitUntil(sending);
  else await sending;
}

/**
 * A checkout of this site completed: put the order where its buyer's account
 * will find it, now or whenever that account is made (lib/accounts.ts, "…and
 * so does every purchase made with it").
 *
 *  1. **The customer carries the address, lowercased, and this site's tag**
 *     (`claimCustomer`) — a guest's as much as a signed-in buyer's. That alone
 *     puts the order on the account for that address, including one made
 *     years from now: `accountCustomers` finds it by the address.
 *  2. **An account without a primary customer gets this one**: the account
 *     checkout named (`client_reference_id`), or — for a guest — the account
 *     that already exists for the address the buyer gave. Its next checkout
 *     then passes this customer, and `/api/portal` opens it.
 *
 * Two outcomes need a person rather than a retry, so they are logged and the
 * event still succeeds: the account checkout named was erased before its
 * checkout completed (the customer stays in Stripe), or it already has another
 * primary customer and this one carries a different address — the buyer
 * changed it at checkout — so the order is on neither the account's primary
 * nor its address.
 */
async function linkBuyer(env: StripeWebhookEnv, session: Record<string, unknown>): Promise<void> {
  const customer = session.customer;
  if (typeof customer !== 'string' || !/^cus_[A-Za-z0-9]+$/.test(customer)) return;
  const details = (session.customer_details ?? {}) as { email?: unknown };
  const email = normalizeEmail(details.email ?? session.customer_email);
  if (email) await claimCustomer(env, customer, email);

  const reference = session.client_reference_id;
  const named = typeof reference === 'string' && /^[0-9a-f]{32}$/.test(reference) ? reference : '';
  const account = named ? await findById(env, named) : email ? await findByEmail(env, email) : null;
  if (!account) {
    if (named) console.warn(`[stripe-webhook] ${String(session.id)}: account ${named} no longer exists; Stripe customer ${customer} was not linked and remains in Stripe.`);
    // A guest with no account yet: their first sign-in finds this customer by its address.
    return;
  }

  const outcome = await linkStripeCustomer(env, account.id, customer);
  if (outcome === 'other' && email !== account.email) {
    console.warn(`[stripe-webhook] ${String(session.id)}: account ${account.id} buys as another Stripe customer, and this order's customer ${customer} carries a different address; the order is not on the account.`);
  }
}

export function createStripeWebhookHandler(): PagesFunction<StripeWebhookEnv> {
  return async (context) => {
    const { env, request } = context;
    const rawBody = await request.text();

    const verdict = await verifyStripeSignature(rawBody, request.headers.get('Stripe-Signature'), env.STRIPE_WEBHOOK_SECRET);
    if (!verdict.ok) {
      console.warn(`[stripe-webhook] refused: ${verdict.reason}`);
      return json({ error: 'Invalid signature' }, 400);
    }

    let event: StripeEvent;
    try {
      event = JSON.parse(rawBody) as StripeEvent;
    } catch {
      return json({ error: 'Invalid payload' }, 400);
    }

    if (await alreadyHandled(env.DB, event.id)) return json({ received: true, duplicate: true });

    const object = event.data?.object ?? {};
    try {
      switch (event.type) {
        case 'price.created':
        case 'price.updated':
        case 'price.deleted': {
          await refreshPrice(env, String((object as Partial<StripePrice>).id));
          // The price may be its product's default: an amount edited in the
          // Stripe dashboard changes what a product-keyed button shows.
          const product = (object as Partial<StripePrice>).product;
          const productId = typeof product === 'string' ? product : product?.id;
          if (productId) await refreshCachedProduct(env, productId);
          break;
        }
        case 'product.updated':
        case 'product.deleted':
          await refreshProduct(env, String(object.id));
          break;
        case 'checkout.session.completed': {
          const order = await recordOrder(env, object);
          // Before linking: a failure there is retried, and the retry finds
          // the order settled and does not mail a second time — nor, had the
          // mail waited for the link, a first.
          if (order.settledNow) await tellOwner(context, env, object);
          if (order.ours) await linkBuyer(env, object);
          break;
        }
        case 'checkout.session.async_payment_succeeded':
        case 'checkout.session.async_payment_failed':
          if ((await recordOrder(env, object)).settledNow) await tellOwner(context, env, object);
          break;
        default:
          // Acknowledged and ignored: an event we did not subscribe to, or one
          // this version does not act on (checkout.session.expired, until stock).
          break;
      }
    } catch (error) {
      // A 5xx makes Stripe retry, which is what a transient D1 or Stripe
      // failure wants. The event is not marked, so the retry does the work.
      console.error(`[stripe-webhook] ${event.type} ${event.id} failed:`, error instanceof Error ? error.message : error);
      return json({ error: 'Processing failed' }, 500);
    }

    await markHandled(env.DB, event);
    return json({ received: true });
  };
}
