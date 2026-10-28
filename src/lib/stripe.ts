/**
 * Stripe, from a Worker, with no SDK — the half of docs/STRIPE-COMMERCE.md that
 * every endpoint shares.
 *
 * Plain `fetch` against api.stripe.com rather than the `stripe` package, for the
 * reason the rest of this runtime has no dependencies: a site repo consumes
 * these files through the `./functions/*` export and Cloudflare's build
 * transpiles them, so a dependency here becomes a dependency of every site.
 * Stripe's REST API takes form-encoded bodies and answers JSON; that is all
 * this needs.
 *
 * Three things live here because more than one endpoint depends on them being
 * identical:
 *
 *  - **the webhook signature** (`verifyStripeSignature`) — same shape as our own
 *    X-EWS scheme: HMAC-SHA256 over `timestamp.rawBody`, compared in constant
 *    time, a tolerance window against replay;
 *  - **site scoping** (`belongsToSite`) — one Stripe account may sell for
 *    several sites, and a page must not be able to sell another site's product;
 *  - **the price cache** (`resolvePrices`, `resolveProducts`) — what the
 *    middleware renders into a page, kept in the site's D1 and refreshed by
 *    webhook and by age.
 *
 * ## Two keys: a price, or a product
 *
 * A Buy button names either a Stripe **price** (`price_…`, the `[edge_buy]`
 * shortcode) or a Stripe **product** (`prod_…`, or the `ews_<site>_<post>` id
 * the catalogue mirror derives — the Buy block). A product resolves to its
 * *default price* at the moment of reading, so a price changed in WordPress —
 * which the mirror turns into a new default price and an archived old one —
 * reaches the page and the checkout without the page being republished. A
 * price-keyed button goes unavailable the moment its price is archived; that
 * is the whole reason the block keys by product (docs/STRIPE-COMMERCE.md §10).
 */

export interface StripeEnv {
  /**
   * A restricted key. Products and Prices write (the catalogue mirror),
   * Checkout Sessions write (checkout, and a customer's order list), Customer
   * portal write (`/api/portal`), and Customers write: the webhook writes the
   * buyer's address back onto each customer, lowercased and tagged with the
   * site, so an account finds every purchase made with its address
   * (lib/accounts.ts); the account page lists customers by that address; and
   * erasure deletes them when the owner deletes the person in WordPress
   * (docs/STRIPE-COMMERCE.md §8).
   */
  STRIPE_SECRET_KEY?: string;
  /** The webhook endpoint's signing secret (`whsec_…`). */
  STRIPE_WEBHOOK_SECRET?: string;
  /** "on" to ask Stripe Tax to compute tax at checkout. Off until the account has it set up. */
  STRIPE_AUTOMATIC_TAX?: string;
  /**
   * The customer portal configuration (`bpc_…`) this site opens. Empty means
   * the Stripe account's default one — enough for an account that sells for
   * one site; one selling for several gives each its own, since the portal
   * shows a business name and a return link.
   */
  STRIPE_PORTAL_CONFIGURATION?: string;
}

/**
 * What these functions read beyond the Stripe keys. A separate type rather
 * than fields on StripeEnv, for the reason WpFetchEnv is one: other envs
 * declare ALLOWED_ORIGIN and DB *required*, and TypeScript cannot merge an
 * optional and a required property of one name into WorkerEnv.
 */
export type StripeSiteEnv = StripeEnv & {
  /** Comma-separated site origins; a product must name one of their hosts. */
  ALLOWED_ORIGIN?: string;
  DB?: D1Database;
};

const API = 'https://api.stripe.com/v1';

/** The fields of a Stripe Price (with its product expanded) that this runtime reads. */
export interface StripePrice {
  id: string;
  active: boolean;
  currency: string;
  unit_amount: number | null;
  recurring: { interval: string; interval_count: number } | null;
  product: string | { id: string; active: boolean; name: string; metadata?: Record<string, string> };
}

/** What the page needs to show a price, and whether it may be sold. */
export interface PriceView {
  id: string;
  productId: string;
  productName: string;
  unitAmount: number | null;
  currency: string;
  interval: string | null;
  /** Active price, active product, and the product names this site. */
  sellable: boolean;
}

/** A Stripe Product with its default price expanded — GET /v1/products/:id?expand[]=default_price. */
export interface StripeProduct {
  id: string;
  active: boolean;
  name: string;
  metadata?: Record<string, string>;
  /** Expanded, the price carries its product as an id: the product is this object. */
  default_price?: string | Omit<StripePrice, 'product'> | null;
}

/**
 * How long any Stripe call may take. Until 2026-10-28 there was no limit at
 * all, so a slow Stripe held a webhook, a checkout or a page for as long as
 * the runtime let it.
 */
export const STRIPE_TIMEOUT_MS = 20_000;

/**
 * How long a page view waits for Stripe, per price — and in total, since the
 * missing ones are asked for together. A visitor is waiting on this; past it
 * the button shows as unavailable, which is what Stripe being down already
 * looked like.
 */
export const RENDER_TIMEOUT_MS = 2_500;

/** Stripe's form encoding: nested keys as `a[b][0][c]`. */
export function formEncode(params: Record<string, unknown>, prefix = ''): string[] {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    const name = prefix ? `${prefix}[${key}]` : key;
    if (typeof value === 'object') {
      parts.push(...formEncode(value as Record<string, unknown>, name));
    } else {
      parts.push(`${encodeURIComponent(name)}=${encodeURIComponent(String(value))}`);
    }
  }
  return parts;
}

export class StripeError extends Error {
  /**
   * `param` is the request parameter Stripe blames, when it names one: a
   * `resource_missing` on `customer` is a deleted customer, the same code on a
   * price is an unknown price, and only the pair tells them apart.
   */
  constructor(message: string, readonly status: number, readonly code?: string, readonly param?: string) {
    super(message);
    this.name = 'StripeError';
  }
}

/**
 * One call to the Stripe API. Throws StripeError with Stripe's own message on
 * a non-2xx.
 *
 * DELETE is here because Stripe really uses it — deleting a customer is
 * `DELETE /v1/customers/:id`, and there is no `POST …/delete`. Sending the
 * POST spelling answers 404, which reads exactly like "already deleted"; an
 * erasure would then report success and leave the customer in Stripe. Found in
 * review, 2026-09-22.
 */
export async function stripe<T>(
  env: StripeSiteEnv,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  params: Record<string, unknown> = {},
  options: { idempotencyKey?: string; timeoutMs?: number } = {}
): Promise<T> {
  if (!env.STRIPE_SECRET_KEY) throw new StripeError('STRIPE_SECRET_KEY is not configured', 500);
  const query = formEncode(params).join('&');
  const url = method !== 'POST' && query ? `${API}${path}?${query}` : `${API}${path}`;
  const timeoutMs = options.timeoutMs ?? STRIPE_TIMEOUT_MS;
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
        ...(method === 'POST' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
        // Stripe answers a repeated request carrying the same key with the first
        // request's result, for 24 hours: a retried create makes nothing twice.
        ...(options.idempotencyKey ? { 'Idempotency-Key': options.idempotencyKey } : {}),
      },
      ...(method === 'POST' ? { body: query } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    // A 504, so every caller's existing rule for a 5xx applies: the mirror
    // backs off and retries, the webhook answers 5xx and Stripe redelivers,
    // checkout says to try again shortly. A POST that timed out may still have
    // happened at Stripe; the creates that matter carry an Idempotency-Key.
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      throw new StripeError(`Stripe did not answer within ${timeoutMs} ms`, 504);
    }
    throw error;
  }
  const body = (await response.json().catch(() => ({}))) as { error?: { message?: string; code?: string; param?: string } };
  if (!response.ok) {
    throw new StripeError(body.error?.message || `Stripe answered HTTP ${response.status}`, response.status, body.error?.code, body.error?.param);
  }
  return body as T;
}

/** The hosts this site answers as, from ALLOWED_ORIGIN. */
export function siteHosts(env: StripeSiteEnv): string[] {
  return String(env.ALLOWED_ORIGIN || '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value && value !== '*')
    .map((value) => { try { return new URL(value).host; } catch { return ''; } })
    .filter(Boolean);
}

/**
 * Does this product belong to this site?
 *
 * The product carries `ews_site` in its Stripe metadata — one host, or several
 * comma-separated. Without the check, one Stripe account selling for two sites
 * would let either site's page sell the other's products at checkout.
 */
export function belongsToSite(metadata: Record<string, string> | undefined, env: StripeSiteEnv): boolean {
  const declared = String(metadata?.ews_site || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
  const hosts = siteHosts(env).map((h) => h.toLowerCase());
  return declared.some((host) => hosts.includes(host));
}

/** A Stripe Price, product expanded, as the page and the checkout see it. */
export function toView(price: StripePrice, env: StripeSiteEnv): PriceView {
  const product = typeof price.product === 'string'
    ? { id: price.product, active: false, name: '', metadata: {} }
    : price.product;
  return {
    id: price.id,
    productId: product.id,
    productName: product.name,
    unitAmount: price.unit_amount,
    currency: price.currency,
    interval: price.recurring?.interval ?? null,
    sellable: price.active && product.active && belongsToSite(product.metadata, env) && price.unit_amount !== null,
  };
}

/** Fetch one price, live, with its product. */
export async function fetchPrice(env: StripeSiteEnv, id: string, options: { timeoutMs?: number } = {}): Promise<PriceView> {
  return toView(await stripe<StripePrice>(env, 'GET', `/prices/${encodeURIComponent(id)}`, { expand: ['product'] }, options), env);
}

/** Only ids shaped like Stripe price ids go anywhere near a query or a URL. */
export const isPriceId = (value: unknown): value is string => typeof value === 'string' && /^price_[A-Za-z0-9]{8,64}$/.test(value);

/**
 * Only ids shaped like a product id go anywhere near a query or a URL: Stripe's
 * own (`prod_…`), or the mirror's derived `ews_<site>_<post>`
 * (functions/api/products.ts, productIdFor). The same pattern is written in
 * the plugin's BuyBlock::is_product_id — change both.
 */
export const isProductId = (value: unknown): value is string =>
  typeof value === 'string' && /^(?:prod_[A-Za-z0-9]{8,64}|ews_[a-z0-9_]{1,120})$/.test(value);

/**
 * A product, as the page and the checkout see it: its **default price**, with
 * the product's own state deciding whether it may be sold. `id` is that price's
 * id — what a Checkout Session is created with — and empty when the product has
 * no default price, which is never sellable.
 */
export function productView(product: StripeProduct, env: StripeSiteEnv): PriceView {
  const price = product.default_price && typeof product.default_price === 'object' ? product.default_price : null;
  return {
    id: price?.id ?? '',
    productId: product.id,
    productName: product.name,
    unitAmount: price?.unit_amount ?? null,
    currency: price?.currency ?? '',
    interval: price?.recurring?.interval ?? null,
    sellable: Boolean(price && price.active && product.active && belongsToSite(product.metadata, env) && price.unit_amount !== null),
  };
}

/** Fetch one product, live, with its default price. */
export async function fetchProduct(env: StripeSiteEnv, id: string, options: { timeoutMs?: number } = {}): Promise<PriceView> {
  return productView(
    await stripe<StripeProduct>(env, 'GET', `/products/${encodeURIComponent(id)}`, { expand: ['default_price'] }, options),
    env
  );
}

/** How long a cached price is trusted without a webhook having refreshed it. */
export const PRICE_TTL_SECONDS = 3600;

interface PriceRow {
  id: string; product_id: string; product_name: string; unit_amount: number | null;
  currency: string; interval: string | null; sellable: number; fetched_at: number;
}

const fromRow = (row: PriceRow): PriceView => ({
  id: row.id, productId: row.product_id, productName: row.product_name, unitAmount: row.unit_amount,
  currency: row.currency, interval: row.interval, sellable: row.sellable === 1,
});

/** Write one price into the cache — from a webhook or a fresh fetch. */
export async function storePrice(db: D1Database, view: PriceView, now = Math.floor(Date.now() / 1000)): Promise<void> {
  await db
    .prepare(
      `INSERT INTO ews_stripe_prices (id, product_id, product_name, unit_amount, currency, interval, sellable, fetched_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
       ON CONFLICT (id) DO UPDATE SET product_id = ?2, product_name = ?3, unit_amount = ?4,
         currency = ?5, interval = ?6, sellable = ?7, fetched_at = ?8`
    )
    .bind(view.id, view.productId, view.productName, view.unitAmount, view.currency, view.interval, view.sellable ? 1 : 0, now)
    .run();
}

/**
 * A product's default price, cached by **product id** — what a product-keyed
 * button shows. Its own table rather than rows in ews_stripe_prices, because the
 * key differs: a product's default price changes identity when the price does,
 * and the row must follow the product, not the old price.
 */
interface ProductRow {
  product_id: string; price_id: string; product_name: string; unit_amount: number | null;
  currency: string; interval: string | null; sellable: number; fetched_at: number;
}

const fromProductRow = (row: ProductRow): PriceView => ({
  id: row.price_id, productId: row.product_id, productName: row.product_name, unitAmount: row.unit_amount,
  currency: row.currency, interval: row.interval, sellable: row.sellable === 1,
});

/** Write one product's default price into the cache — from a webhook or a fresh fetch. */
export async function storeProduct(db: D1Database, view: PriceView, now = Math.floor(Date.now() / 1000)): Promise<void> {
  await db
    .prepare(
      `INSERT INTO ews_stripe_products (product_id, price_id, product_name, unit_amount, currency, interval, sellable, fetched_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
       ON CONFLICT (product_id) DO UPDATE SET price_id = ?2, product_name = ?3, unit_amount = ?4,
         currency = ?5, interval = ?6, sellable = ?7, fetched_at = ?8`
    )
    .bind(view.productId, view.id, view.productName, view.unitAmount, view.currency, view.interval, view.sellable ? 1 : 0, now)
    .run();
}

/**
 * The one cache walk both keys share: fresh rows from D1, the rest from Stripe
 * and written back.
 *
 * Never throws. An id that cannot be resolved is simply absent from the map,
 * and the page shows the button as unavailable rather than failing to render:
 * Stripe being unreachable must not take the site down with it. Nor may Stripe
 * being slow: the missing ids are asked for together, each within
 * `timeoutMs`, so a page waits that long at most however many it carries
 * (they were asked one after another, unbounded, until 2026-10-28).
 */
async function resolveCached(
  env: StripeSiteEnv,
  ids: string[],
  now: number,
  cache: {
    valid: (id: unknown) => id is string;
    select: string;
    key: (row: any) => string;
    view: (row: any) => PriceView;
    fetch: (env: StripeSiteEnv, id: string, options: { timeoutMs?: number }) => Promise<PriceView>;
    store: (db: D1Database, view: PriceView, now: number) => Promise<void>;
  },
  timeoutMs: number,
  waitUntil?: (promise: Promise<unknown>) => void
): Promise<Map<string, PriceView>> {
  const wanted = [...new Set(ids.filter(cache.valid))].slice(0, 50);
  const found = new Map<string, PriceView>();
  if (!wanted.length || !env.DB) return found;
  // Rows past the TTL, shown now and refreshed after the answer — when the
  // runtime can wait for work past the response. Without waitUntil they are
  // refreshed before it, as they always were.
  const stale = new Map<string, PriceView>();

  try {
    const placeholders = wanted.map((_, i) => `?${i + 1}`).join(', ');
    const { results } = await env.DB
      .prepare(`${cache.select} (${placeholders})`)
      .bind(...wanted)
      .all<{ fetched_at: number }>();
    for (const row of results ?? []) {
      if (now - row.fetched_at < PRICE_TTL_SECONDS) found.set(cache.key(row), cache.view(row));
      else if (waitUntil) stale.set(cache.key(row), cache.view(row));
    }
  } catch {
    // No table yet, or D1 unavailable: fall through to Stripe for every id.
  }

  const db = env.DB;

  /*
   * Stale-while-revalidate (2026-10-28). A Buy page seen less than once an
   * hour almost always found its row past the TTL, so its visitor waited for
   * Stripe — a round trip, then a D1 write — before the first byte. The
   * webhook keeps rows true; the TTL is the net under a missed webhook, and
   * need not sit in the visitor's path. The price shown can be one view
   * staler than before; the price charged cannot, as checkout reads Stripe.
   */
  if (stale.size && waitUntil) {
    for (const [id, view] of stale) found.set(id, view);
    waitUntil(Promise.all([...stale.keys()].map(async (id) => {
      try {
        await cache.store(db, await cache.fetch(env, id, {}), now);
      } catch {
        // Kept as it is; the next view tries again.
      }
    })));
  }

  await Promise.all(wanted.filter((id) => !found.has(id)).map(async (id) => {
    try {
      const view = await cache.fetch(env, id, { timeoutMs });
      found.set(id, view);
      await cache.store(db, view, now).catch(() => {});
    } catch {
      // Unknown to Stripe, unreachable or too slow: absent, so shown as unavailable.
    }
  }));
  return found;
}

/** Prices for a page, by price id: from the cache when fresh, from Stripe when missing or older than the TTL. */
export function resolvePrices(env: StripeSiteEnv, ids: string[], now = Math.floor(Date.now() / 1000), timeoutMs = RENDER_TIMEOUT_MS, waitUntil?: (promise: Promise<unknown>) => void): Promise<Map<string, PriceView>> {
  return resolveCached(env, ids, now, {
    valid: isPriceId,
    select: 'SELECT * FROM ews_stripe_prices WHERE id IN',
    key: (row: PriceRow) => row.id,
    view: fromRow,
    fetch: fetchPrice,
    store: storePrice,
  }, timeoutMs, waitUntil);
}

/** Default prices for a page, by product id — the same cache rules, keyed by product. */
export function resolveProducts(env: StripeSiteEnv, ids: string[], now = Math.floor(Date.now() / 1000), timeoutMs = RENDER_TIMEOUT_MS, waitUntil?: (promise: Promise<unknown>) => void): Promise<Map<string, PriceView>> {
  return resolveCached(env, ids, now, {
    valid: isProductId,
    select: 'SELECT * FROM ews_stripe_products WHERE product_id IN',
    key: (row: ProductRow) => row.product_id,
    view: fromProductRow,
    fetch: fetchProduct,
    store: storeProduct,
  }, timeoutMs, waitUntil);
}

/**
 * How many digits a currency's minor unit has. Stripe amounts are in the
 * minor unit: 4500 EUR is 45.00, but 4500 JPY is 4500 — the zero-decimal
 * currencies (JPY, KRW, …) are the exception, and Intl knows which they are.
 */
export function currencyDigits(currency: string): number {
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency: currency.toUpperCase() }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

/** A Stripe amount as a plain decimal: 4500 EUR → "45.00", 4500 JPY → "4500". */
export function decimalAmount(amount: unknown, currency: string): string {
  const digits = currencyDigits(currency);
  return (Number(amount ?? 0) / 10 ** digits).toFixed(digits);
}

/** "45,00 €" or "€45.00", by the page's own language. */
export function formatPrice(view: PriceView, locale = 'en'): string {
  if (view.unitAmount === null) return '';
  const amount = view.unitAmount / 10 ** currencyDigits(view.currency);
  let text: string;
  try {
    text = new Intl.NumberFormat(locale, { style: 'currency', currency: view.currency.toUpperCase() }).format(amount);
  } catch {
    text = new Intl.NumberFormat('en', { style: 'currency', currency: view.currency.toUpperCase() }).format(amount);
  }
  return view.interval ? `${text} / ${view.interval}` : text;
}

/** Constant-time comparison of two hex strings. */
function sameHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return [...new Uint8Array(signature)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Verify a `Stripe-Signature` header: `t=<unix>,v1=<hex>[,v1=<hex>…]`.
 *
 * The signed string is `${t}.${rawBody}` — the raw bytes, before any parsing,
 * the same rule as our own scheme. Several `v1` entries appear while a secret
 * is being rolled; any one matching is enough. `v0` is Stripe's test-only
 * scheme and is ignored.
 */
export async function verifyStripeSignature(
  rawBody: string,
  header: string | null,
  secret: string | undefined,
  now: number = Math.floor(Date.now() / 1000),
  toleranceSeconds = 300
): Promise<{ ok: boolean; reason?: 'no-secret' | 'no-signature' | 'skew' | 'bad-signature' }> {
  if (!secret) return { ok: false, reason: 'no-secret' };
  if (!header) return { ok: false, reason: 'no-signature' };

  let timestamp = '';
  const signatures: string[] = [];
  for (const part of header.split(',')) {
    const [key, value] = part.split('=', 2).map((s) => s.trim());
    if (key === 't') timestamp = value;
    if (key === 'v1' && value) signatures.push(value);
  }
  if (!timestamp || !signatures.length) return { ok: false, reason: 'no-signature' };
  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds) || Math.abs(now - seconds) > toleranceSeconds) return { ok: false, reason: 'skew' };

  const expected = await hmacHex(secret, `${timestamp}.${rawBody}`);
  return signatures.some((signature) => sameHex(expected, signature)) ? { ok: true } : { ok: false, reason: 'bad-signature' };
}
