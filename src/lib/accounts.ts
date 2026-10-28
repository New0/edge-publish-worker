/**
 * Customer accounts, edge side — docs/EDGE-ACCOUNTS.md §2–4.
 *
 * The store and the rules; the endpoints that use it are `/api/accounts` (what
 * the owner decided in WordPress) and, from step 3, sign-in. Two tables:
 * `ews_accounts`, which is permanent because every sign-in needs it, and
 * `ews_account_events`, a mailbox WordPress drains exactly as it drains form
 * submissions.
 *
 * ## One writer per field
 *
 * The customer writes email, name and preferences here; the owner writes
 * status and erasure in WordPress, and those arrive as a signed push. So
 * nothing merges: `saveProfile` never touches status, and `setStatus` never
 * touches the profile. A change arriving from the side that does not own the
 * field is ignored rather than merged, which is the whole conflict rule.
 *
 * ## An email identifies an account
 *
 * Lowercased and trimmed, and unique in the table. A second sign-up with the
 * same address is the same person coming back, not a second account — and
 * `ews_accounts.email` being UNIQUE means the database says so even if two
 * requests race.
 *
 * ## …and so does every purchase made with it
 *
 * The same address is the key on Stripe's side too (docs/EDGE-ACCOUNTS.md §7).
 * An account owns **every Stripe customer of this site whose email is its
 * address**, however each was made: a guest checkout before the account
 * existed, one made signed out after it did, or a signed-in one. Stripe makes
 * a new customer for each guest checkout and never merges them by address, so
 * the edge does not try to keep one customer per person; it computes the set
 * when it is needed (`accountCustomers`), from what Stripe holds. Nothing is
 * linked in an order that can be missed, so the answer is the same whichever
 * came first — the purchase or the account.
 *
 * `stripe_customer_id` is then only the account's **primary** customer: the
 * one a signed-in checkout passes and the billing portal opens. It is set once
 * and never moved (`linkStripeCustomer`).
 *
 * What makes the address a reliable key in Stripe is the webhook: it writes
 * the address back onto each customer lowercased and tags it with this site
 * (`claimCustomer`), because Stripe keeps an address as the buyer typed it and
 * its customer list filters by email case-sensitively.
 *
 * **An address typed at checkout is not verified, so it can add to an account
 * and never read from one.** A guest who types someone else's address puts
 * that order on that person's account — where Stripe's own receipt, sent to
 * the same address, has already put it — and gets nothing of theirs in return:
 * checkout never picks a customer by an address it was given, only by the
 * account a signed-in session proves. Proving the address is what signing in
 * is, and it is the rule Stripe's own portal log-in applies.
 */

import { belongsToSite, siteHosts, stripe, StripeError, type StripeSiteEnv } from './stripe.js';

export interface AccountsEnv {
  DB: D1Database;
}

/** What the purchase-side functions read: the store, and Stripe for this site. */
export type AccountStripeEnv = AccountsEnv & StripeSiteEnv;

export interface Account {
  id: string;
  email: string;
  name: string;
  status: 'active' | 'blocked';
  stripeCustomerId: string;
  wpUserId: number | null;
  createdAt: number;
  lastSeenAt: number | null;
}

interface AccountRow {
  id: string; email: string; name: string; status: string;
  stripe_customer_id: string; wp_user_id: number | null;
  created_at: number; last_seen_at: number | null;
}

/** What an account event says happened. Each becomes one WordPress import. */
export type AccountEventType = 'created' | 'profile' | 'signed-in';

const fromRow = (row: AccountRow): Account => ({
  id: row.id,
  email: row.email,
  name: row.name,
  status: row.status === 'blocked' ? 'blocked' : 'active',
  stripeCustomerId: row.stripe_customer_id ?? '',
  wpUserId: row.wp_user_id ?? null,
  createdAt: row.created_at,
  lastSeenAt: row.last_seen_at ?? null,
});

/**
 * An address, as this store holds it: trimmed, lowercased, and shaped like an
 * address. Not a validator — delivery is the only real test, and the sign-in
 * link is that test — but enough that a row's key is predictable.
 */
export function normalizeEmail(value: unknown): string {
  const email = String(value ?? '').trim().toLowerCase();
  return /^[^\s@]{1,64}@[^\s@.]+(\.[^\s@.]+)+$/.test(email) && email.length <= 254 ? email : '';
}

/** A display name: one line, bounded, no markup smuggled through. */
export function normalizeName(value: unknown): string {
  return String(value ?? '').replace(/[\r\n\t<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);
}

/** A random account id: 32 hex characters, from the runtime's CSPRNG. */
export function newAccountId(): string {
  return [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function findByEmail(env: AccountsEnv, email: string): Promise<Account | null> {
  const row = await env.DB.prepare('SELECT * FROM ews_accounts WHERE email = ?1').bind(normalizeEmail(email)).first<AccountRow>();
  return row ? fromRow(row) : null;
}

export async function findById(env: AccountsEnv, id: string): Promise<Account | null> {
  const row = await env.DB.prepare('SELECT * FROM ews_accounts WHERE id = ?1').bind(id).first<AccountRow>();
  return row ? fromRow(row) : null;
}

/** Add one event to the mailbox WordPress drains. */
export async function recordEvent(
  env: AccountsEnv,
  account: Account,
  type: AccountEventType,
  data: Record<string, unknown> = {},
  now = Math.floor(Date.now() / 1000)
): Promise<void> {
  await env.DB
    .prepare('INSERT INTO ews_account_events (account_id, type, email, name, data, created_at, synced) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0)')
    .bind(account.id, type, account.email, account.name, JSON.stringify(data), now)
    .run();
}

/**
 * The account for this address, made if there is none.
 *
 * Returns the account and whether it was created, because a caller usually
 * wants to record one event and not two. A blocked account is returned as it
 * is: whether a blocked person may sign in is the caller's rule, not the
 * store's.
 */
export async function ensureAccount(
  env: AccountsEnv,
  emailInput: string,
  nameInput = '',
  now = Math.floor(Date.now() / 1000)
): Promise<{ account: Account; created: boolean }> {
  const email = normalizeEmail(emailInput);
  if (!email) throw new Error('an account needs an email address');

  const existing = await findByEmail(env, email);
  if (existing) return { account: existing, created: false };

  const account: Account = {
    id: newAccountId(), email, name: normalizeName(nameInput), status: 'active',
    stripeCustomerId: '', wpUserId: null, createdAt: now, lastSeenAt: null,
  };
  // Two sign-ups racing on one address: the second insert loses on the UNIQUE
  // index, and the row already there is the account — not an error to show.
  await env.DB
    .prepare(
      `INSERT INTO ews_accounts (id, email, name, status, stripe_customer_id, created_at)
       VALUES (?1, ?2, ?3, 'active', '', ?4) ON CONFLICT (email) DO NOTHING`
    )
    .bind(account.id, account.email, account.name, now)
    .run();

  const stored = await findByEmail(env, email);
  if (!stored) throw new Error('the account could not be stored');
  if (stored.id !== account.id) return { account: stored, created: false };

  await recordEvent(env, stored, 'created', {}, now);
  return { account: stored, created: true };
}

/** The customer's own fields. Never status: that is the owner's. */
export async function saveProfile(
  env: AccountsEnv,
  account: Account,
  fields: { name?: unknown },
  now = Math.floor(Date.now() / 1000)
): Promise<Account> {
  const name = normalizeName(fields.name ?? account.name);
  if (name === account.name) return account;
  await env.DB.prepare('UPDATE ews_accounts SET name = ?2 WHERE id = ?1').bind(account.id, name).run();
  const updated = { ...account, name };
  await recordEvent(env, updated, 'profile', { name }, now);
  return updated;
}

/** A sign-in, for the owner's list. The event carries the time; the row carries the latest. */
export async function recordSignIn(env: AccountsEnv, account: Account, now = Math.floor(Date.now() / 1000)): Promise<void> {
  await env.DB.prepare('UPDATE ews_accounts SET last_seen_at = ?2 WHERE id = ?1').bind(account.id, now).run();
  await recordEvent(env, { ...account, lastSeenAt: now }, 'signed-in', { at: now }, now);
}

/**
 * The Stripe customer this account buys as, set outright. Checkout uses it with
 * `''` to forget a customer Stripe no longer has, so the next purchase links a
 * new one; linking itself goes through `linkStripeCustomer`.
 */
export async function setStripeCustomer(env: AccountsEnv, account: Account, customerId: string): Promise<void> {
  await env.DB.prepare('UPDATE ews_accounts SET stripe_customer_id = ?2 WHERE id = ?1').bind(account.id, customerId).run();
}

/**
 * Make a Stripe customer the account's **primary** one — the customer a
 * signed-in checkout passes and the portal opens — if it has none yet.
 *
 * Only an account with **no customer yet** is linked: the update is
 * conditional, so a retried webhook, or a second checkout the same account
 * finished before the first one's event arrived, cannot move an account from
 * one Stripe customer to another. `other` is not a loss: a customer carrying
 * the account's address is on the account anyway (`accountCustomers`); the
 * caller warns only when it carries another address.
 *
 * Stripe creates the customer rather than this runtime: a person who starts a
 * checkout and abandons it leaves nothing in Stripe.
 */
export async function linkStripeCustomer(
  env: AccountsEnv,
  accountId: string,
  customerId: string
): Promise<'linked' | 'already' | 'other' | 'absent'> {
  const linked = await env.DB
    .prepare("UPDATE ews_accounts SET stripe_customer_id = ?2 WHERE id = ?1 AND stripe_customer_id = ''")
    .bind(accountId, customerId)
    .run();
  if ((linked.meta?.changes ?? 0) > 0) return 'linked';

  const account = await findById(env, accountId);
  if (!account) return 'absent';
  return account.stripeCustomerId === customerId ? 'already' : 'other';
}

/** The fields of a Stripe customer these functions read. */
interface StripeCustomer {
  id: string;
  metadata?: Record<string, string>;
}

/**
 * How many customers one address is looked up across. Each is one more Stripe
 * read for the order list; a person reaches ten only by buying signed out ten
 * times, and the newest are the ones kept.
 */
export const CUSTOMERS_PER_ADDRESS = 10;

/**
 * Write the buyer's address onto the customer their checkout made, lowercased,
 * and tag the customer as this site's — which is what lets `customersByEmail`
 * find it later, whenever the account is made. Setting the same two values
 * again changes nothing, so a retried event is harmless.
 *
 * Returns quietly when the customer is gone (deleted in the dashboard since)
 * or when Stripe refuses for good — a key without Customers write, say — with
 * the reason logged: the customer is still found through its checkout while
 * its address is lowercase (see `customersByEmail`). A 429, a 5xx or no answer
 * is thrown, so Stripe retries the event rather than leave it untagged.
 */
export async function claimCustomer(env: AccountStripeEnv, customerId: string, email: string): Promise<void> {
  const address = normalizeEmail(email);
  const host = siteHosts(env)[0];
  if (!address || !host || !env.STRIPE_SECRET_KEY) return;
  try {
    await stripe(env, 'POST', `/customers/${encodeURIComponent(customerId)}`, { email: address, metadata: { ews_site: host } });
  } catch (error) {
    if (!(error instanceof StripeError) || error.status === 429 || error.status >= 500) throw error;
    if (error.status !== 404) console.warn(`[accounts] Stripe customer ${customerId} could not be tagged for this site: ${error.message}`);
  }
}

/**
 * This site's Stripe customers with this address, newest first.
 *
 * Stripe's list filters by email **case-sensitively**, so this asks for the
 * lowercased address — the form `claimCustomer` writes, and the form a
 * signed-in checkout prefills. A customer is this site's when it is tagged so;
 * one tagged for another site on a shared Stripe account is not; and an
 * untagged one — made before customers were tagged (2026-09-24), or whose
 * tagging was refused — is this site's when it completed a checkout here,
 * which is one more read each and only for those.
 */
export async function customersByEmail(env: StripeSiteEnv, email: string): Promise<string[]> {
  const address = normalizeEmail(email);
  if (!address || !env.STRIPE_SECRET_KEY) return [];
  const list = await stripe<{ data?: StripeCustomer[] }>(env, 'GET', '/customers', { email: address, limit: CUSTOMERS_PER_ADDRESS });
  const ours: string[] = [];
  for (const customer of list.data ?? []) {
    if (belongsToSite(customer.metadata, env)) {
      ours.push(customer.id);
    } else if (!customer.metadata?.ews_site) {
      const sessions = await stripe<{ data?: Array<{ metadata?: Record<string, string> }> }>(
        env, 'GET', '/checkout/sessions', { customer: customer.id, status: 'complete', limit: 100 }
      );
      if ((sessions.data ?? []).some((session) => belongsToSite(session.metadata, env))) ours.push(customer.id);
    }
  }
  return ours;
}

/**
 * Every Stripe customer that is this account's: its primary one, and every
 * customer of this site carrying its address — the guest checkouts made
 * before the account existed and the ones made signed out after. Newest
 * first after the primary; empty on a site that does not sell.
 */
export async function accountCustomers(env: AccountStripeEnv, account: Account): Promise<string[]> {
  if (!env.STRIPE_SECRET_KEY) return [];
  const byEmail = await customersByEmail(env, account.email);
  return [...new Set([account.stripeCustomerId, ...byEmail].filter(Boolean))];
}

/**
 * Give an account without a primary customer the newest one carrying its
 * address — so a buyer whose purchases were all made as a guest sees them,
 * and can open the portal, from the first time they sign in. An account that
 * has one is returned as it is; so is one with nothing bought.
 *
 * The same conditional link the webhook uses, so this and a webhook arriving
 * at the same moment cannot both win: whichever links first is the primary,
 * and the other finds it.
 */
export async function adoptCustomer(env: AccountStripeEnv, account: Account): Promise<Account> {
  if (account.stripeCustomerId || !env.STRIPE_SECRET_KEY) return account;
  const [newest] = await customersByEmail(env, account.email);
  if (!newest) return account;
  const outcome = await linkStripeCustomer(env, account.id, newest);
  if (outcome === 'linked' || outcome === 'already') return { ...account, stripeCustomerId: newest };
  return (await findById(env, account.id)) ?? account;
}

/**
 * The owner's decision, arriving from WordPress. Blocking ends the account's
 * sessions at once: a block that waited for a session to expire would not be a
 * block. (Sessions arrive in step 3; the delete is written now so that the
 * rule lands with the decision rather than after it.)
 */
export async function setStatus(env: AccountsEnv, account: Account, status: 'active' | 'blocked'): Promise<void> {
  await env.DB.prepare('UPDATE ews_accounts SET status = ?2 WHERE id = ?1').bind(account.id, status).run();
  if (status === 'blocked') await endSessions(env, account.id);
}

/** Remember which WordPress user holds this account, so a later push can name it. */
export async function setWpUser(env: AccountsEnv, account: Account, wpUserId: number): Promise<void> {
  await env.DB.prepare('UPDATE ews_accounts SET wp_user_id = ?2 WHERE id = ?1').bind(account.id, wpUserId).run();
}

/**
 * Erase: the account, its events, its sessions, and its sign-in links.
 *
 * Erasure has one entry point — deleting the WordPress user — and this is the
 * edge's half of it. The unsynced events go too: a drain that imported them
 * afterwards would recreate in WordPress the person WordPress just deleted.
 * So do the sign-in links, for the same reason: following one makes the
 * account (`completeSignIn` → `ensureAccount`), so a link mailed before the
 * erasure and clicked after it brought the person back, and the next drain
 * brought them back into WordPress. Until 2026-10-28 they stayed, address
 * and all, until they expired and a sampled sweep happened to run.
 * The Stripe customer is the caller's to delete, because only it has the key.
 */
export async function eraseAccount(env: AccountsEnv, account: Account): Promise<void> {
  await endSessions(env, account.id);
  await forgetSignInLinks(env, account.email);
  await env.DB.prepare('DELETE FROM ews_account_events WHERE account_id = ?1').bind(account.id).run();
  await env.DB.prepare('DELETE FROM ews_accounts WHERE id = ?1').bind(account.id).run();
}

/**
 * Drop every sign-in link mailed to one address, used or not. Like the
 * sessions table, a database that predates sign-in has none, and that must
 * not fail an erase.
 */
async function forgetSignInLinks(env: AccountsEnv, email: string): Promise<void> {
  try {
    await env.DB.prepare('DELETE FROM ews_login_tokens WHERE email = ?1').bind(email).run();
  } catch {
    // No login tokens table yet: nothing was ever mailed.
  }
}

/**
 * Drop every session of one account.
 *
 * `ews_sessions` is part of the schema, but a site whose database predates it
 * has no such table, and a missing one must not fail a block or an erase — the
 * account row is what decides, and it has already been written.
 */
async function endSessions(env: AccountsEnv, accountId: string): Promise<void> {
  try {
    await env.DB.prepare('DELETE FROM ews_sessions WHERE account_id = ?1').bind(accountId).run();
  } catch {
    // No sessions table yet: nothing to end.
  }
}
