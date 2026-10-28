/**
 * POST /api/accounts — what the owner decided in WordPress, arriving at the edge.
 *
 * docs/EDGE-ACCOUNTS.md §4. The mirror image of the drain: accounts are made
 * at the edge and drained into WordPress, but **status and erasure belong to
 * the owner**, who decides them in WordPress. Those come back here, signed
 * with the X-EWS scheme like every plugin → edge request, and are the only
 * fields this endpoint writes.
 *
 *   { "action": "status", "email": "a@example.com", "status": "blocked" }
 *   { "action": "erase",  "email": "a@example.com" }
 *   { "action": "link",   "email": "a@example.com", "wp_user_id": 42 }
 *   { "action": "inspect" }
 *
 * `inspect` is reconcile's read (src/reconcile/accounts.mjs): every account as
 * the edge holds it — id, status, the WordPress user it is linked to, when it
 * was made — and **nothing about the person**. No address, no name: whoever
 * runs reconcile learns which accounts disagree, not who they belong to.
 *
 * An account is named by email — the one identifier both sides have before
 * anything is linked — or by `account_id` when the plugin stored one.
 *
 * ## Why an unknown account is a success
 *
 * The plugin retries a push that failed, and a customer erased on a previous
 * attempt is gone from here. Answering 404 would make the plugin retry for
 * ever something that is already true. `absent` says what happened without
 * making it a failure, the same shape `/api/products` uses for an archive.
 *
 * ## Erasure deletes the Stripe customers too
 *
 * All of them: the primary one, and every customer of this site carrying the
 * account's address — the guest checkouts are the same person's, and the
 * account page lists them as theirs. Only the edge holds the Stripe key, so
 * only the edge can. A Stripe failure
 * does not stop the local erasure: the person asked to be forgotten, and a
 * partial erasure that is reported beats none. The answer names what was left,
 * and the plugin logs it for the owner.
 */

import { authenticateSync, nonceChecker, refusal } from '../lib/auth.js';
import { accountCustomers, eraseAccount, findByEmail, findById, normalizeEmail, setStatus, setWpUser, type Account, type AccountsEnv } from '../lib/accounts.js';
import { stripe, StripeError, type StripeEnv } from '../lib/stripe.js';

export interface AccountsApiEnv extends AccountsEnv, StripeEnv {
  SYNC_SECRET: string;
  /** The site's origin: erasure deletes only this site's Stripe customers, on a Stripe account that may sell for several. */
  ALLOWED_ORIGIN: string;
  /** '2' refuses a request signed v1 only; unset or anything else accepts it, logged (2026-09-29). */
  SIGNATURE_MIN_VERSION?: string;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** The most accounts one `inspect` answers. Beyond it the answer says `truncated`. */
export const INSPECT_LIMIT = 5000;

/** Every account, as reconcile compares it: ids and state, no personal data. */
async function inspect(env: AccountsApiEnv) {
  const { results } = await env.DB
    .prepare('SELECT id, status, wp_user_id, created_at FROM ews_accounts ORDER BY created_at, id LIMIT ?1')
    .bind(INSPECT_LIMIT + 1)
    .all<{ id: string; status: string; wp_user_id: number | null; created_at: number }>();
  const rows = results ?? [];
  return {
    success: true,
    action: 'inspect',
    v: 1,
    accounts: rows.slice(0, INSPECT_LIMIT).map((row) => ({
      account_id: row.id,
      status: row.status === 'blocked' ? 'blocked' : 'active',
      wp_user_id: row.wp_user_id ?? null,
      created_at: row.created_at,
    })),
    truncated: rows.length > INSPECT_LIMIT,
  };
}

interface AccountsBody {
  action?: string;
  email?: unknown;
  account_id?: unknown;
  status?: unknown;
  wp_user_id?: unknown;
}

/** The account this request names, or null. */
async function resolve(env: AccountsApiEnv, body: AccountsBody): Promise<Account | null> {
  if (typeof body.account_id === 'string' && /^[0-9a-f]{32}$/.test(body.account_id)) {
    const byId = await findById(env, body.account_id);
    if (byId) return byId;
  }
  const email = normalizeEmail(body.email);
  return email ? findByEmail(env, email) : null;
}

/**
 * Delete the account's Stripe customers — every one, not only the primary:
 * the guest checkouts made with the address are the same person's, and on the
 * account page as theirs (lib/accounts.ts `accountCustomers`). Says what could
 * not be done, and goes on with the rest.
 */
async function deleteStripeCustomers(env: AccountsApiEnv, account: Account): Promise<string | null> {
  if (!env.STRIPE_SECRET_KEY) return null;
  const problems: string[] = [];
  let customers: string[];
  try {
    customers = await accountCustomers(env, account);
  } catch (error) {
    // The address could not be looked up; the primary is still known, and
    // deleting it beats deleting nothing.
    customers = account.stripeCustomerId ? [account.stripeCustomerId] : [];
    problems.push(`the customers carrying this address could not be listed: ${error instanceof Error ? error.message : 'Stripe could not be read'}`);
  }
  problems.push(...(await deleteEach(env, customers)));
  return problems.length ? problems.join('; ') : null;
}

/** One DELETE per customer; what failed, as sentences naming the customer. */
async function deleteEach(env: AccountsApiEnv, customers: string[]): Promise<string[]> {
  const failed: string[] = [];
  for (const id of customers) {
    try {
      await stripe(env, 'DELETE', `/customers/${encodeURIComponent(id)}`);
    } catch (error) {
      // Already gone is done, not a failure.
      if (error instanceof StripeError && error.status === 404) continue;
      failed.push(`${id}: ${error instanceof Error ? error.message : 'Stripe refused the deletion'}`);
    }
  }
  return failed;
}

export function createAccountsHandler(): PagesFunction<AccountsApiEnv> {
  return async (context) => {
    const { env, request } = context;
    const rawBody = await request.text();

    // With the site's minimum version, like every other signed endpoint: this
    // one erases people and their Stripe customers, and until 2026-10-28 it
    // would have kept accepting v1 — which binds no method or path — after the
    // minimum went to 2. And through refusal(), so a nonce store that is down
    // answers 503 (retry) rather than 401 (wrong secret).
    const auth = await authenticateSync(request, rawBody, env.SYNC_SECRET, nonceChecker(env.DB), {
      endpoint: 'accounts', minVersion: env.SIGNATURE_MIN_VERSION,
    });
    if (!auth.ok) {
      const { body, status } = refusal(auth);
      return json(body, status);
    }

    let body: AccountsBody;
    try {
      body = JSON.parse(rawBody) as AccountsBody;
    } catch {
      return json({ error: 'Invalid JSON' }, 400);
    }

    const action = String(body.action ?? '');
    if (!['status', 'erase', 'link', 'inspect'].includes(action)) {
      return json({ error: 'action must be "status", "erase", "link" or "inspect"' }, 400);
    }

    try {
      if (action === 'inspect') return json(await inspect(env));

      const account = await resolve(env, body);
      if (!account) return json({ success: true, action, skipped: 'absent' });

      if (action === 'status') {
        const status = body.status === 'blocked' ? 'blocked' : 'active';
        await setStatus(env, account, status);
        return json({ success: true, action, account_id: account.id, status });
      }

      if (action === 'link') {
        const wpUserId = Number(body.wp_user_id);
        if (!Number.isInteger(wpUserId) || wpUserId <= 0) return json({ error: 'wp_user_id must be a positive integer' }, 400);
        await setWpUser(env, account, wpUserId);
        return json({ success: true, action, account_id: account.id, wp_user_id: wpUserId });
      }

      const stripeError = await deleteStripeCustomers(env, account);
      await eraseAccount(env, account);
      return json({ success: true, action, account_id: account.id, ...(stripeError ? { stripe: stripeError } : {}) });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error(`[accounts] ${action} failed:`, message);
      return json({ error: message }, 502);
    }
  };
}
