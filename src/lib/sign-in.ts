/**
 * Signing in without passwords — docs/EDGE-ACCOUNTS.md §5.
 *
 * A visitor gives an address; a one-time link arrives; following it makes a
 * session. There is no password to store, to leak or to reset, and the only
 * secret in play lives in the visitor's inbox for fifteen minutes.
 *
 * ## Nothing here can hand out a working link
 *
 * The token and the session id are 32 random bytes, and the database holds
 * only their SHA-256. A dump of `ews_login_tokens` or `ews_sessions` is a list
 * of hashes, like a password file that nobody can reverse — and, unlike a
 * password file, the plaintext was never ours to begin with.
 *
 * ## An account is made when the link is followed, not when it is asked for
 *
 * Asking creates only a token row keyed by the address. If asking created the
 * account, anyone could fill this site's D1 — and, through the drain, its
 * WordPress users — with addresses that never consented. The account exists
 * once someone has proved they read that inbox.
 *
 * ## The same answer, whatever happened
 *
 * `requestSignIn` answers the same way for an address that has an account, one
 * that does not, and one that is blocked. Anything else turns this endpoint
 * into a way of asking "is this person a customer here?".
 */

import { ensureAccount, findByEmail, normalizeEmail, recordSignIn, type Account, type AccountsEnv } from './accounts.js';

/** A sign-in link is good for fifteen minutes, and once. */
export const LOGIN_TOKEN_TTL_SECONDS = 15 * 60;

/** A session lasts a month from sign-in. Using it does not extend it. */
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

export const SESSION_COOKIE = 'ews_account';

/** How often one address may ask, and how many links may be alive at once. */
export const REQUESTS_PER_EMAIL = 3;
export const REQUEST_WINDOW_SECONDS = 15 * 60;

/** SHA-256, hex. For tokens at rest; there are no passwords here to hash. */
export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 32 random bytes, base64url: long enough that guessing is not a strategy. */
export function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The cookie that carries a session. Lax, so following the link from the email works. */
export function sessionCookie(token: string, maxAge = SESSION_TTL_SECONDS): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

/** The cookie that ends one. */
export function clearedCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

/** One cookie out of a Cookie header, by name, and only that one. */
function readCookie(request: Request, wanted: string): string | null {
  for (const pair of (request.headers.get('Cookie') || '').split(';')) {
    const [name, ...rest] = pair.trim().split('=');
    if (name === wanted) return rest.join('=') || null;
  }
  return null;
}

/** Read our cookie out of a Cookie header, and only ours. */
export function sessionToken(request: Request): string | null {
  return readCookie(request, SESSION_COOKIE);
}

// ── Which browser asked ──────────────────────────────────────────────────
//
// A mailed link is the account page with the token after '#', and only a POST
// spends it — so a mail scanner that opens links to check them cannot use one
// up. That cost a press of a button on every sign-in, and people took opening
// the link for signing in (2026-09-23: the site's own owner did, and bought as
// a guest). The link now signs in at once **in the browser that asked for
// it**, and asks for the press everywhere else: another device, a mail app's
// own browser, a scanner.
//
// Asking leaves a marker in that browser: a hash of the token, never the token.
// A browser holding a token could sign in as whoever's address it asked for,
// without reading their mail; a browser holding the marker can only skip the
// button for a link it also has. The marker is derived from the token alone,
// so whoever holds the link could compute it — which gains them nothing, since
// the link already lets them press the button. It decides whether to ask for
// a press, never whether to allow a sign-in.

/** The cookie that remembers which links this browser asked for, for as long as they last. */
export const PENDING_COOKIE = 'ews_signin';

/** Markers kept per browser: asking twice and following the first mail still works. */
const PENDING_KEEP = 3;

const MARKER = /^[0-9a-f]{32}$/;

/** What a browser keeps for a link it asked for. */
export async function browserMarker(token: string): Promise<string> {
  return (await hashToken(`ews-signin-browser:${token}`)).slice(0, 32);
}

/** The markers this request carries, newest first. */
export function pendingMarkers(request: Request): string[] {
  return (readCookie(request, PENDING_COOKIE) || '').split('.').filter((marker) => MARKER.test(marker));
}

/**
 * The cookie that keeps them: HttpOnly, and sent only to the account API — the
 * page's script never reads it and no other route receives it.
 */
export function pendingCookie(markers: string[]): string {
  const kept = [...new Set(markers.filter((marker) => MARKER.test(marker)))].slice(0, PENDING_KEEP);
  return `${PENDING_COOKIE}=${kept.join('.')}; Path=/api/account/; HttpOnly; Secure; SameSite=Lax; Max-Age=${LOGIN_TOKEN_TTL_SECONDS}`;
}

/** Did the browser making this request ask for this link? */
export async function askedHere(request: Request, token: string): Promise<boolean> {
  return pendingMarkers(request).includes(await browserMarker(token));
}

export interface SignInEnv extends AccountsEnv {}

/** Where the account page lives when the site names no other path. */
export const DEFAULT_ACCOUNT_PATH = '/account/';

/**
 * The site's account path — where a sign-in link lands, and where Stripe's
 * portal sends a customer back to. One leading slash, no scheme, no host, no
 * `..`. Validated rather than trusted, because it becomes a `Location` header
 * and a `return_url`: a binding that could start with `//` would send the
 * visitor to another site.
 *
 * `/account/` unless the site says otherwise — a French site sells from
 * `/compte/`, and nothing in this runtime should assume English. The engine's
 * `accountPath` (src/transforms/account-page.mjs) applies the same rule to
 * where the page is built.
 */
export function accountPath(env: { ACCOUNT_PATH?: string }): string {
  const value = String(env.ACCOUNT_PATH || '').trim();
  if (!/^\/(?!\/)[A-Za-z0-9\-._~/%]*$/.test(value) || value.includes('..')) return DEFAULT_ACCOUNT_PATH;
  return value.endsWith('/') ? value : `${value}/`;
}

/**
 * Make a link for this address, unless it has asked too often.
 *
 * Returns the token for the caller to send — this module never sends anything:
 * the caller does, through the site's own mail transport or WordPress
 * (functions/lib/mail.ts, and `sendLink` in functions/api/account.ts).
 */
export async function requestSignIn(
  env: SignInEnv,
  emailInput: string,
  now = Math.floor(Date.now() / 1000)
): Promise<{ ok: true; token: string; expiresAt: number } | { ok: false; reason: 'invalid-email' | 'too-many' }> {
  const email = normalizeEmail(emailInput);
  if (!email) return { ok: false, reason: 'invalid-email' };

  // The allowance is a condition of the insert, not a read before it: a count
  // and a separate insert let fifty concurrent requests all read "none yet"
  // and each mail a link — one address flooded from the site's own sender
  // (review, 2026-10-28). The same shape form, contact and comment use.
  const token = newToken();
  const inserted = await env.DB
    .prepare(
      'INSERT INTO ews_login_tokens (token_hash, email, created_at, expires_at) ' +
      'SELECT ?1, ?2, ?3, ?4 ' +
      'WHERE (SELECT COUNT(*) FROM ews_login_tokens WHERE email = ?2 AND created_at > ?5) < ?6'
    )
    .bind(await hashToken(token), email, now, now + LOGIN_TOKEN_TTL_SECONDS, now - REQUEST_WINDOW_SECONDS, REQUESTS_PER_EMAIL)
    .run();
  if (!inserted.meta?.changes) return { ok: false, reason: 'too-many' };

  return { ok: true, token, expiresAt: now + LOGIN_TOKEN_TTL_SECONDS };
}

/**
 * What following this link would do now, without following it: for a page
 * that must ask for a press, so an expired or spent link says so at once
 * rather than after the press. Blocked accounts are found by the press, as
 * before — this reads the link, not the account.
 */
export async function signInLinkState(
  env: SignInEnv,
  token: string,
  now = Math.floor(Date.now() / 1000)
): Promise<'ok' | 'unknown' | 'expired' | 'used'> {
  // The same read completeSignIn makes, so the two cannot disagree about a link.
  const row = await env.DB
    .prepare('SELECT email, expires_at, used_at FROM ews_login_tokens WHERE token_hash = ?1')
    .bind(await hashToken(String(token ?? '')))
    .first<{ email: string; expires_at: number; used_at: number | null }>();
  if (!row) return 'unknown';
  if (row.used_at) return 'used';
  if (row.expires_at <= now) return 'expired';
  return 'ok';
}

/**
 * Follow a link: the account (made now if this address has none), a session,
 * and the token spent.
 *
 * Spending the token **before** anything else is deliberate: two clicks, or a
 * mail client prefetching the link and a person clicking it, must not make two
 * sessions. The update is conditional on it still being unused, so the second
 * one changes no rows and is refused.
 */
export async function completeSignIn(
  env: SignInEnv,
  token: string,
  now = Math.floor(Date.now() / 1000)
): Promise<{ ok: true; account: Account; session: string } | { ok: false; reason: 'unknown' | 'expired' | 'used' | 'blocked' }> {
  const hash = await hashToken(String(token ?? ''));
  const row = await env.DB
    .prepare('SELECT email, expires_at, used_at FROM ews_login_tokens WHERE token_hash = ?1')
    .bind(hash)
    .first<{ email: string; expires_at: number; used_at: number | null }>();

  if (!row) return { ok: false, reason: 'unknown' };
  if (row.used_at) return { ok: false, reason: 'used' };
  if (row.expires_at <= now) return { ok: false, reason: 'expired' };

  const spent = await env.DB
    .prepare('UPDATE ews_login_tokens SET used_at = ?2 WHERE token_hash = ?1 AND used_at IS NULL')
    .bind(hash, now)
    .run();
  if ((spent.meta?.changes ?? 0) === 0) return { ok: false, reason: 'used' };

  const { account } = await ensureAccount(env, row.email, '', now);
  if (account.status === 'blocked') return { ok: false, reason: 'blocked' };

  const session = newToken();
  await env.DB
    .prepare('INSERT INTO ews_sessions (token_hash, account_id, created_at, expires_at, last_seen_at) VALUES (?1, ?2, ?3, ?4, ?3)')
    .bind(await hashToken(session), account.id, now, now + SESSION_TTL_SECONDS)
    .run();

  await recordSignIn(env, account, now);
  return { ok: true, account, session };
}

/**
 * Who is this request?
 *
 * Null for no cookie, an unknown or expired session, an account that no longer
 * exists, or one that is blocked — a block takes effect on the next request,
 * as well as ending the session rows it can see.
 */
export async function accountFromRequest(
  env: SignInEnv,
  request: Request,
  now = Math.floor(Date.now() / 1000)
): Promise<Account | null> {
  const token = sessionToken(request);
  if (!token) return null;

  const hash = await hashToken(token);
  const row = await env.DB
    .prepare('SELECT account_id, expires_at FROM ews_sessions WHERE token_hash = ?1')
    .bind(hash)
    .first<{ account_id: string; expires_at: number }>();
  if (!row || row.expires_at <= now) return null;

  const account = await env.DB
    .prepare('SELECT * FROM ews_accounts WHERE id = ?1')
    .bind(row.account_id)
    .first<{ id: string; email: string; name: string; status: string; stripe_customer_id: string; wp_user_id: number | null; created_at: number; last_seen_at: number | null }>();
  if (!account || account.status === 'blocked') return null;

  return {
    id: account.id, email: account.email, name: account.name, status: 'active',
    stripeCustomerId: account.stripe_customer_id ?? '', wpUserId: account.wp_user_id ?? null,
    createdAt: account.created_at, lastSeenAt: account.last_seen_at ?? null,
  };
}

/** End this request's session, and only it: signing out here is not signing out everywhere. */
export async function endSession(env: SignInEnv, request: Request): Promise<void> {
  const token = sessionToken(request);
  if (!token) return;
  await env.DB.prepare('DELETE FROM ews_sessions WHERE token_hash = ?1').bind(await hashToken(token)).run();
}

/**
 * Forget expired tokens and sessions.
 *
 * Sampled by the caller, like the other sweeps in this runtime — and, as
 * CLAUDE.md requires, a test pins `Math.random` and takes this path rather than
 * leaving it to run first in production.
 */
export async function sweepExpired(env: SignInEnv, now = Math.floor(Date.now() / 1000)): Promise<void> {
  await env.DB.prepare('DELETE FROM ews_login_tokens WHERE expires_at <= ?1').bind(now).run();
  await env.DB.prepare('DELETE FROM ews_sessions WHERE expires_at <= ?1').bind(now).run();
}

/** Is this address one an account exists for? Only the endpoints that may know ask. */
export async function accountExists(env: SignInEnv, email: string): Promise<boolean> {
  return Boolean(await findByEmail(env, email));
}
