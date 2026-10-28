/**
 * POST /api/products — the catalogue mirror: a WordPress product in, the Stripe
 * Product and its default Price made to match it.
 *
 * docs/STRIPE-COMMERCE.md §4. WordPress is the catalogue and the authority for
 * what is sold and at what price; Stripe is the authority for what is charged.
 * This is the one place the first becomes the second, and it runs one way:
 * nothing here ever reads a Stripe edit back into WordPress. A price changed
 * in Stripe's dashboard is overwritten by the next mirror of that product.
 *
 * Signed like every plugin → edge request (X-EWS), because the plugin holds no
 * Stripe key: the site's restricted key is a Worker secret in the owner's own
 * account, and this endpoint is the only thing that uses it to write.
 *
 * ## Three properties, each for a reason
 *
 * - **One Stripe product per WordPress product, found again without memory.**
 *   The Product's id is derived from the site and the post id
 *   (`ews_<site>_<post>`), so a retry, a second site on the same Stripe
 *   account, or a plugin that lost the id it stored all land on the right
 *   product rather than making another. Creates also carry an Idempotency-Key.
 * - **Ordered.** The Product carries the WordPress `modified_gmt` it was last
 *   mirrored from (`wp_version`); an older one is refused, as update-page
 *   refuses an older page — a slow retry must not undo a newer edit.
 * - **Prices are replaced, never edited.** Stripe does not let a Price's amount
 *   change. A different amount, currency or interval is a new Price, made the
 *   product's default, and the old one archived — in that order, because
 *   Stripe refuses to archive a product's default price.
 *
 * ## `inspect`, for reconcile
 *
 * `action: "inspect"` writes nothing: it lists this site's Stripe products and
 * their default prices, so `edgewpsync reconcile` can compare the catalogue
 * with WordPress's. The edge answers because only the edge holds the key; the
 * operator never does (docs/STRIPE-COMMERCE.md §8).
 */

import { authenticateSync, nonceChecker, refusal } from '../lib/auth.js';
import { stripe, StripeError, siteHosts, belongsToSite, toView, storePrice, type StripeEnv, type StripePrice } from '../lib/stripe.js';

export interface ProductsEnv extends StripeEnv {
  SYNC_SECRET: string;
  ALLOWED_ORIGIN: string;
  DB: D1Database;
  /** '2' refuses a request signed v1 only; unset or anything else accepts it, logged (2026-09-29). */
  SIGNATURE_MIN_VERSION?: string;
}

/** A product as WordPress sends it. Amounts in the currency's minor unit. */
export interface WordPressProduct {
  wp_post_id: number;
  /** The post's modified_gmt, ISO 8601 — the ordering key. */
  version: string;
  name: string;
  description?: string;
  active: boolean;
  amount: number;
  currency: string;
  /** '' for a one-off payment, or a Stripe interval. */
  interval: string;
  tax_code?: string;
  /** The product's page on the public site. */
  url?: string;
  /** The main image, on the public site — Stripe fetches it. */
  image?: string;
}

interface StripeProduct {
  id: string;
  active: boolean;
  name?: string;
  metadata?: Record<string, string>;
  default_price?: string | StripePrice | null;
}

const INTERVALS = new Set(['', 'day', 'week', 'month', 'year']);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** `ews_<site>_<post>`: stable, and only characters any id accepts. */
export function productIdFor(env: ProductsEnv, postId: number): string {
  const site = (siteHosts(env)[0] || 'site').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  return `ews_${site}_${postId}`;
}

/** Why a payload cannot be mirrored, or null. */
export function invalid(product: Partial<WordPressProduct> | undefined): string | null {
  if (!product) return 'product required';
  if (!Number.isInteger(product.wp_post_id) || (product.wp_post_id as number) <= 0) return 'wp_post_id must be a positive integer';
  if (!product.version || !Number.isFinite(Date.parse(product.version))) return 'version must be an ISO 8601 date';
  if (typeof product.name !== 'string' || !product.name.trim()) return 'name required';
  if (!Number.isInteger(product.amount) || (product.amount as number) < 0 || (product.amount as number) > 99999999) return 'amount must be a whole number of minor units';
  if (typeof product.currency !== 'string' || !/^[a-z]{3}$/.test(product.currency)) return 'currency must be a lowercase ISO 4217 code';
  if (typeof product.interval !== 'string' || !INTERVALS.has(product.interval)) return 'interval must be empty or a Stripe interval';
  return null;
}

/** A Stripe product as reconcile compares it: the fields the mirror writes. */
export interface InspectedProduct {
  id: string;
  active: boolean;
  name: string;
  wp_post_id: string;
  wp_version: string;
  price: { id: string; active: boolean; amount: number | null; currency: string; interval: string } | null;
}

/** 100 per page, 20 pages: a catalogue past 2,000 products is reported as truncated, not guessed at. */
const INSPECT_PAGE_SIZE = 100;
const INSPECT_MAX_PAGES = 20;

/** Is `incoming` older than what Stripe holds? Compared as instants. */
function isOlder(incoming: string, stored: string | undefined): boolean {
  if (!stored) return false;
  const a = Date.parse(incoming);
  const b = Date.parse(stored);
  return Number.isFinite(a) && Number.isFinite(b) && a < b;
}

async function findProduct(env: ProductsEnv, id: string): Promise<StripeProduct | null> {
  try {
    return await stripe<StripeProduct>(env, 'GET', `/products/${encodeURIComponent(id)}`, { expand: ['default_price'] });
  } catch (error) {
    if (error instanceof StripeError && error.status === 404) return null;
    throw error;
  }
}

/** Does the default price already say what WordPress says? */
function priceMatches(price: StripePrice | null, product: WordPressProduct): boolean {
  if (!price || !price.active) return false;
  const interval = price.recurring?.interval ?? '';
  return price.unit_amount === product.amount && price.currency === product.currency && interval === product.interval;
}

async function upsert(env: ProductsEnv, product: WordPressProduct, storedId: string | undefined) {
  const id = productIdFor(env, product.wp_post_id);
  const metadata = {
    ews_site: siteHosts(env)[0] || '',
    wp_post_id: String(product.wp_post_id),
    wp_version: product.version,
  };
  const fields = {
    name: product.name.slice(0, 250),
    active: product.active,
    // '' clears a field in Stripe's form encoding; it is how a removed image
    // or an emptied excerpt reaches Stripe too.
    description: (product.description || '').slice(0, 500),
    url: product.url || '',
    images: product.image ? { 0: product.image } : '',
    ...(product.tax_code ? { tax_code: product.tax_code } : {}),
    metadata,
  };

  // The id WordPress stored wins if it is ours; otherwise the derived one.
  let existing = storedId && storedId !== id ? await findProduct(env, storedId) : null;
  if (existing && !belongsToSite(existing.metadata, env)) existing = null;
  if (!existing) existing = await findProduct(env, id);
  if (existing && existing.metadata?.wp_post_id && existing.metadata.wp_post_id !== String(product.wp_post_id)) {
    return json({ error: 'That Stripe product belongs to another WordPress product.' }, 409);
  }

  if (existing && isOlder(product.version, existing.metadata?.wp_version)) {
    const price = typeof existing.default_price === 'object' ? existing.default_price : null;
    return json({ success: true, action: 'upsert', skipped: 'stale', product_id: existing.id, price_id: price?.id ?? null });
  }

  let current: StripeProduct;
  const productChanged = true;
  if (existing) {
    current = await stripe<StripeProduct>(env, 'POST', `/products/${encodeURIComponent(existing.id)}`, fields);
    current.default_price = existing.default_price;
  } else {
    // A create sends only what has a value: '' clears a field on an update,
    // and there is nothing to clear on a product that does not exist yet.
    const initial = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== ''));
    current = await stripe<StripeProduct>(env, 'POST', '/products', { id, ...initial }, {
      idempotencyKey: `ews-product-${id}-${product.version}`,
    });
  }

  // The price. None is made for an amount of zero: Checkout will not sell it,
  // and the product page shows it as unavailable until the owner sets one.
  const previous = typeof current.default_price === 'object' ? current.default_price : null;
  let priceId = previous?.id ?? (typeof current.default_price === 'string' ? current.default_price : null);
  let priceChanged = false;

  if (product.amount > 0 && !priceMatches(previous, product)) {
    const created = await stripe<StripePrice>(env, 'POST', '/prices', {
      product: current.id,
      unit_amount: product.amount,
      currency: product.currency,
      ...(product.interval ? { recurring: { interval: product.interval } } : {}),
      metadata,
    }, {
      // The default price being replaced is part of the key. A retry of this
      // request still sees it, so makes nothing twice; a repair after the price
      // was edited in Stripe — same version, same amount as the create that
      // made it — does not, so gets a price. Without it Stripe replayed the
      // first create's answer for 24 h: the very price that had been edited,
      // and a repair that changed nothing and said it had (2026-10-28).
      idempotencyKey: `ews-price-${current.id}-${previous?.id ?? 'none'}-${product.amount}-${product.currency}-${product.interval || 'once'}-${product.version}`,
    });
    // What Stripe answered, checked rather than trusted: a replayed or
    // otherwise wrong price must fail the mirror, which the plugin and
    // reconcile both report, and never be set as the default and called done.
    if (created.id === previous?.id || !priceMatches(created, product)) {
      throw new StripeError(`Stripe answered with ${created.id}, which is not the price WordPress asked for`, 409, 'price_not_created');
    }
    await stripe(env, 'POST', `/products/${encodeURIComponent(current.id)}`, { default_price: created.id });
    if (previous?.id && previous.id !== created.id && previous.active) {
      await stripe(env, 'POST', `/prices/${encodeURIComponent(previous.id)}`, { active: false });
    }
    priceId = created.id;
    priceChanged = true;

    // The page shows the new price from the next view, without waiting for
    // Stripe's webhook to say what this request already knows.
    await storePrice(env.DB, toView({ ...created, product: { id: current.id, active: product.active, name: product.name, metadata } }, env)).catch(() => {});
  }

  return json({
    success: true,
    action: 'upsert',
    product_id: current.id,
    price_id: priceId,
    changed: { product: productChanged, price: priceChanged },
    ...(product.amount > 0 ? {} : { note: 'no price: the amount is zero' }),
  });
}

async function archive(env: ProductsEnv, postId: number, version: string, storedId: string | undefined) {
  const id = storedId || productIdFor(env, postId);
  const existing = await findProduct(env, id);
  if (!existing || !belongsToSite(existing.metadata, env)) {
    return json({ success: true, action: 'archive', skipped: 'absent' });
  }
  if (isOlder(version, existing.metadata?.wp_version)) {
    return json({ success: true, action: 'archive', skipped: 'stale', product_id: existing.id });
  }
  // Inactive, never deleted: Stripe keeps a product's payments and history,
  // and so should we.
  await stripe(env, 'POST', `/products/${encodeURIComponent(existing.id)}`, {
    active: false,
    metadata: { wp_version: version },
  });
  return json({ success: true, action: 'archive', product_id: existing.id });
}

/**
 * This site's products, as Stripe holds them now.
 *
 * A list filtered by `ews_site` rather than a lookup by derived id: an orphan —
 * a Stripe product whose WordPress post is gone — is exactly the one nobody
 * would know to look up. Inactive products are listed too, so reconcile can
 * tell "archived in Stripe while WordPress sells it" from "never mirrored".
 */
async function inspect(env: ProductsEnv) {
  const products: InspectedProduct[] = [];
  let startingAfter: string | undefined;
  let truncated = false;

  for (let page = 0; ; page++) {
    const list = await stripe<{ data: StripeProduct[]; has_more: boolean }>(env, 'GET', '/products', {
      limit: INSPECT_PAGE_SIZE,
      expand: ['data.default_price'],
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    for (const product of list.data) {
      if (!belongsToSite(product.metadata, env)) continue;
      const price = product.default_price && typeof product.default_price === 'object' ? product.default_price : null;
      products.push({
        id: product.id,
        active: product.active,
        name: product.name ?? '',
        wp_post_id: product.metadata?.wp_post_id ?? '',
        wp_version: product.metadata?.wp_version ?? '',
        price: price
          ? { id: price.id, active: price.active, amount: price.unit_amount, currency: price.currency, interval: price.recurring?.interval ?? '' }
          : null,
      });
    }
    if (!list.has_more || !list.data.length) break;
    if (page + 1 >= INSPECT_MAX_PAGES) {
      truncated = true;
      break;
    }
    startingAfter = list.data[list.data.length - 1].id;
  }

  return json({ success: true, action: 'inspect', products, truncated });
}

export function createProductsHandler(): PagesFunction<ProductsEnv> {
  return async (context) => {
    const { env, request } = context;
    const rawBody = await request.text();

    // Signed only: no plugin that predates signing ever wrote a catalogue, so
    // a bearer token here is refused (review of 2026-09-28). The auth layer
    // logs the refusal, with the caller's address.
    const auth = await authenticateSync(request, rawBody, env.SYNC_SECRET, nonceChecker(env.DB), {
      endpoint: 'products', minVersion: env.SIGNATURE_MIN_VERSION,
    });
    if (!auth.ok) {
      const { body, status } = refusal(auth);
      return json(body, status);
    }
    if (!env.STRIPE_SECRET_KEY) {
      // Said plainly, so the plugin can tell "not set up" from "failed".
      return json({ error: 'This site has no Stripe key configured.', code: 'stripe-not-configured' }, 503);
    }

    let body: { action?: string; product?: WordPressProduct; stripe_product_id?: string; wp_post_id?: number; version?: string };
    try {
      body = JSON.parse(rawBody);
    } catch {
      return json({ error: 'Invalid JSON' }, 400);
    }

    try {
      if (body.action === 'upsert') {
        const problem = invalid(body.product);
        if (problem) return json({ error: problem }, 400);
        return await upsert(env, body.product as WordPressProduct, body.stripe_product_id);
      }
      if (body.action === 'archive') {
        if (!Number.isInteger(body.wp_post_id) || !body.version || !Number.isFinite(Date.parse(body.version))) {
          return json({ error: 'wp_post_id and version required' }, 400);
        }
        return await archive(env, body.wp_post_id as number, body.version, body.stripe_product_id);
      }
      if (body.action === 'inspect') return await inspect(env);
      return json({ error: 'action must be "upsert", "archive" or "inspect"' }, 400);
    } catch (error) {
      // Stripe's own message: the plugin shows it on the product screen, and
      // this endpoint is authenticated, so it reaches only the site's owner.
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error('[products] failed:', message);
      return json({ error: message, code: error instanceof StripeError ? error.code ?? 'stripe' : 'internal' },
        error instanceof StripeError && error.status < 500 ? 422 : 502);
    }
  };
}
