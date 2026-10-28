/**
 * Signed requests for the WordPress ↔ edge channel.
 *
 * The scheme the `ews-sync-protocol` skill specifies, and the one
 * `product/src/hmac.ts` already implements for the runner — reused verbatim
 * rather than invented a third time:
 *
 *     X-EWS-Timestamp:    <unix seconds>
 *     X-EWS-Nonce:        <random>
 *     X-EWS-Signature:    sha256=<hex hmac(secret, ts + "." + nonce + "." + rawBody)>
 *     X-EWS-Signature-V2: sha256=<hex hmac(secret, "v2\n" + ts + "\n" + nonce + "\n"
 *                                          + METHOD + "\n" + path?query + "\n" + rawBody)>
 *
 * ## Version 2 (2026-09-29)
 *
 * The v1 string names no method, path or host, so a signed empty-body GET
 * made for WordPress was, for its 300 s, also a valid request to this edge's
 * `GET /api/sync` — the stored form submissions (docs/FOLLOW-UPS.md §13). v2
 * binds the method and the request target, the path and query as sent; the
 * host is left out so workers.dev and a custom domain verify alike.
 *
 * Signers send both. **A request carrying `X-EWS-Signature-V2` is judged on it
 * alone** and never falls back to v1: otherwise corrupting or stripping the
 * header would be a downgrade, and a signature made for one request would
 * again open another. A request with v1 only is accepted while the minimum
 * version is 1 — `SIGNATURE_MIN_VERSION`, default 1 — and logged by the auth
 * layer, so the owner can see when every signer has moved and set it to 2.
 *
 * ## Why this replaces a bearer token
 *
 * `Authorization: Bearer <secret>` puts the secret itself on the wire, in every
 * request, and anything that captures one can replay it forever: a proxy log, a
 * misconfigured error reporter, a browser extension on a shared machine. A
 * signature proves possession of the secret without transmitting it, and a
 * timestamp and nonce make a captured request useless within five minutes.
 *
 * ## Three rules that fail as something else when broken
 *
 * 1. **Sign the raw body bytes, before JSON parsing.** Re-serialising changes
 *    them — key order, whitespace, unicode escapes — and the signature then
 *    fails in a way that reads exactly like a wrong secret.
 * 2. **Reject skew beyond ±300s and reject a replayed nonce.** Without the
 *    second, a captured request is replayable for the whole window.
 * 3. **Compare in constant time**, so the comparison cost does not leak how
 *    many leading characters matched.
 *
 * There are five implementations of these strings: here, the PHP plugin, the
 * engine's `src/core/sign-request.mjs`, the runner's plain ESM, and the
 * product's Worker. They are separate because they are separate deployments
 * in two languages, and `src/tests/workers-signature.test.mjs` makes each sign
 * a request another verifies — which is what stops them drifting apart.
 */

/** Maximum accepted clock skew, in seconds. Also the nonce retention window. */
export const MAX_SKEW_SECONDS = 300;

/** The header that carries the v2 signature, beside the unchanged v1 headers. */
export const SIGNATURE_V2_HEADER = 'X-EWS-Signature-V2';

/** The v1 string. Any change here is a breaking change. */
export function canonicalString(ts: string | number, nonce: string, rawBody: string): string {
  return `${ts}.${nonce}.${rawBody}`;
}

/**
 * The v2 string. Newline-separated because no field before the body can hold
 * one: digits, hex, an HTTP token, and a request target. Any change here is a
 * breaking change.
 */
export function canonicalStringV2(ts: string | number, nonce: string, method: string, target: string, rawBody: string): string {
  return `v2\n${ts}\n${nonce}\n${method.toUpperCase()}\n${target}\n${rawBody}`;
}

/**
 * Path and query of an absolute URL, as `fetch` sends them and as a verifier
 * reads them back from `request.url`: `pathname + search`, percent-encoding
 * kept, fragment dropped. Throws on a URL that does not parse.
 */
export function requestTarget(url: string | URL): string {
  const parsed = typeof url === 'string' ? new URL(url) : url;
  return parsed.pathname + parsed.search;
}

/**
 * The lowest signature version a verifier accepts, from an environment value.
 * `'2'` (or 2) means 2; anything else — unset, empty, a typo — means 1, so a
 * mistyped setting keeps a site working rather than refusing every signer.
 */
export function signatureMinVersion(value: unknown): 1 | 2 {
  return String(value ?? '').trim() === '2' ? 2 : 1;
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return [...new Uint8Array(signature)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Sign a request — the Worker's half of the scheme, until 2026-09-21 missing.
 *
 * This file could verify a signature and not make one. Every other party could:
 * the plugin signs, the runner signs, the engine signs. So a Worker fetching a
 * page back from WordPress — `update-page`, the uploads proxy — had only Basic
 * Auth or a cookie to offer, and on an origin guarded from inside WordPress
 * (the edge-origin-guard mu-plugin), where there is no Basic Auth, it offered
 * nothing the guard accepts. It was redirected to the public site, `wp-fetch`
 * rightly refused to follow, and every incremental publish on the first
 * guarded origin failed 0 of 5.
 *
 * Same canonical string as `verifySignature` above, the same HMAC, the same
 * headers — so this is the fourth implementation gaining a signer, not a fifth
 * spelling of the scheme. `src/tests/workers-signature.test.mjs` holds it to
 * the others by verifying its output with them.
 *
 * **v1 only.** It cannot name the request, so it cannot sign v2. Kept, in this
 * shape, because site repositories import `./functions/*`; inside this
 * repository call `signRequestTo`, which `src/tests/signature-callers.test.mjs`
 * enforces.
 *
 * @deprecated since 2026-09-29 — use `signRequestTo(secret, method, url, body)`.
 * @param rawBody the bytes that will be sent; `''` for a GET
 * @param now unix seconds, for tests
 */
export async function signRequest(
  secret: string,
  rawBody = '',
  now: number = Math.floor(Date.now() / 1000)
): Promise<Record<string, string>> {
  const ts = String(now);
  const nonce = freshNonce();
  const signature = await hmacHex(secret, canonicalString(ts, nonce, rawBody));
  return {
    'X-EWS-Timestamp': ts,
    'X-EWS-Nonce': nonce,
    'X-EWS-Signature': `sha256=${signature}`,
  };
}

/** Sixteen random bytes, hex: a nonce no two requests share. */
function freshNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Sign a request to one method and address: the v1 headers exactly as
 * `signRequest` makes them, and `X-EWS-Signature-V2` beside them over the same
 * timestamp and nonce. A verifier that predates v2 checks the first; one that
 * knows v2 checks only the second.
 *
 * @param method e.g. 'GET'
 * @param url the absolute URL passed to `fetch` — its path and query are signed
 * @param rawBody the bytes that will be sent; `''` for a GET
 * @param now unix seconds, for tests
 */
export async function signRequestTo(
  secret: string,
  method: string,
  url: string | URL,
  rawBody = '',
  now: number = Math.floor(Date.now() / 1000)
): Promise<Record<string, string>> {
  if (typeof method !== 'string' || !/^[A-Za-z]+$/.test(method)) {
    throw new TypeError('signRequestTo needs the request method: a v2 signature names it.');
  }
  let target: string;
  try {
    target = requestTarget(url);
  } catch {
    throw new TypeError('signRequestTo needs the absolute URL the request is sent to: a v2 signature names its path.');
  }
  const ts = String(now);
  const nonce = freshNonce();
  const [v1, v2] = await Promise.all([
    hmacHex(secret, canonicalString(ts, nonce, rawBody)),
    hmacHex(secret, canonicalStringV2(ts, nonce, method, target, rawBody)),
  ]);
  return {
    'X-EWS-Timestamp': ts,
    'X-EWS-Nonce': nonce,
    'X-EWS-Signature': `sha256=${v1}`,
    [SIGNATURE_V2_HEADER]: `sha256=${v2}`,
  };
}

/** Constant-time comparison of two hex digests of equal length. */
function sameDigest(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}

export interface SignatureResult {
  ok: boolean;
  /**
   * Why it failed, for a log. Never for a response body — see below.
   * `v1-refused`: a valid v1 signature with no v2 beside it, at a verifier
   * whose minimum version is 2 — a signer that has not moved yet.
   */
  reason?: 'no-signature' | 'no-secret' | 'bad-timestamp' | 'bad-nonce' | 'skew' | 'replay' | 'bad-signature' | 'no-nonce-store' | 'v1-refused';
  /** Which string an accepted request proved: 2, or 1 from a signer that predates v2. */
  version?: 1 | 2;
}

export interface VerifyOptions {
  /** Unix seconds now, for tests. */
  now?: () => number;
  /** The lowest version accepted: an environment value, read by `signatureMinVersion`. Default 1. */
  minVersion?: unknown;
}

/**
 * What a nonce store answers when there is none: neither "seen" nor "new".
 *
 * A deployment with no `DB` binding used to answer "seen" for every nonce —
 * failing closed, correctly — and so logged `replay` for every signed request,
 * which reads as an attack when it is a missing binding (review of
 * 2026-09-28). The request is still refused; the reason now says why.
 */
export const NO_NONCE_STORE = 'no-nonce-store';

/**
 * Verify a signed request.
 *
 * `seenNonce` records the nonce and answers whether it had been used before. It
 * is a parameter rather than a lookup here because where a nonce is stored is a
 * deployment's business: the product keeps them in D1, and a site's edge does
 * too. Passing a function that always returns false disables replay protection,
 * which is why no default is provided. A store that does not exist answers
 * `NO_NONCE_STORE`, and the request is refused under that name.
 *
 * **Every failure is one answer to the caller.** Naming the failed check tells
 * whoever is guessing how to make progress; the reason comes back here for a
 * log and the endpoint returns the same 401 either way.
 *
 * **Which version decides.** A request carrying `X-EWS-Signature-V2` — even an
 * empty one — is judged on it alone, against this request's own method and
 * path. One without it is judged on v1, and refused as `v1-refused` when the
 * minimum is 2; the v1 check runs first, so that reason means "a holder of the
 * secret whose signer has not moved", never a guess. The nonce is spent only
 * after everything else has passed, in either case.
 *
 * @param options the minimum version, and the clock for tests. A bare function
 *                is read as the clock, the shape this took before v2.
 */
export async function verifySignature(
  request: Request,
  rawBody: string,
  secret: string,
  seenNonce: (nonce: string) => Promise<boolean | typeof NO_NONCE_STORE>,
  options: VerifyOptions | (() => number) = {}
): Promise<SignatureResult> {
  const { now = () => Math.floor(Date.now() / 1000), minVersion } = typeof options === 'function' ? { now: options } : options;

  // An unset binding must never authenticate. Without this an unconfigured
  // deployment accepts every request signed with the empty key.
  if (!secret) return { ok: false, reason: 'no-secret' };

  const timestamp = request.headers.get('X-EWS-Timestamp');
  const nonce = request.headers.get('X-EWS-Nonce');
  const provided = request.headers.get('X-EWS-Signature');
  // null when absent; '' when present and empty, which still decides — as a failure.
  const providedV2 = request.headers.get(SIGNATURE_V2_HEADER);

  if (!timestamp || !nonce || (!provided && providedV2 === null)) return { ok: false, reason: 'no-signature' };

  // The shapes PHP has always required (class-signature.php): every signer
  // sends a 32-hex nonce and a decimal timestamp. Number() alone took
  // '0x671D4A00' and '1.73e9', and a nonce containing '.' made the v1 string
  // `ts.nonce.body` ambiguous; checked here before any HMAC (2026-10-28).
  if (!/^\d{1,12}$/.test(timestamp)) return { ok: false, reason: 'bad-timestamp' };
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(nonce)) return { ok: false, reason: 'bad-nonce' };
  const seconds = Number(timestamp);
  if (Math.abs(now() - seconds) > MAX_SKEW_SECONDS) return { ok: false, reason: 'skew' };

  // The signature is checked before the nonce is spent. Recording a nonce for a
  // request that turns out to be forged would let anyone burn nonces at will.
  let version: 1 | 2;
  if (providedV2 !== null) {
    const url = new URL(request.url);
    const expected = await hmacHex(secret, canonicalStringV2(timestamp, nonce, request.method, requestTarget(url), rawBody));
    if (!sameDigest(expected, providedV2.replace(/^sha256=/, ''))) return { ok: false, reason: 'bad-signature' };
    version = 2;
  } else {
    const expected = await hmacHex(secret, canonicalString(timestamp, nonce, rawBody));
    if (!sameDigest(expected, (provided ?? '').replace(/^sha256=/, ''))) return { ok: false, reason: 'bad-signature' };
    if (signatureMinVersion(minVersion) >= 2) return { ok: false, reason: 'v1-refused' };
    version = 1;
  }

  const seen = await seenNonce(nonce);
  if (seen === NO_NONCE_STORE) return { ok: false, reason: 'no-nonce-store' };
  if (seen) return { ok: false, reason: 'replay' };

  return { ok: true, version };
}

/**
 * Remember a nonce, and say whether it had been seen.
 *
 * On D1 rather than KV, for the reason the product's queue already documents:
 * KV reads carry a 60-second minimum cache TTL, so a read-then-write check
 * cannot see its own writes inside the window it is enforcing — which is
 * exactly the window a replay happens in.
 *
 * The insert is the check. `INSERT … ON CONFLICT DO NOTHING … RETURNING` writes
 * and answers in one statement, so two requests carrying the same nonce in the
 * same instant cannot both pass.
 */
export async function seenNonceInD1(db: D1Database, nonce: string, now = Math.floor(Date.now() / 1000)): Promise<boolean> {
  // Old rows are swept opportunistically rather than on a schedule: a site's
  // edge has no cron, and a table of five-minute-old nonces is small enough
  // that a sampled delete keeps it bounded.
  if (Math.random() < 0.05) {
    // Strictly older: a row expiring this very second still guards the last
    // second of its window (a request stamped +300 s, replayed 600 s later).
    await db.prepare('DELETE FROM ews_nonces WHERE expires_at < ?1').bind(now).run();
  }

  const row = await db
    .prepare(
      `INSERT INTO ews_nonces (nonce, expires_at) VALUES (?1, ?2)
       ON CONFLICT (nonce) DO NOTHING
       RETURNING nonce`
    )
    .bind(nonce, now + MAX_SKEW_SECONDS * 2)
    .first<{ nonce: string }>();

  // A row came back: this nonce is new. Nothing came back: it was already there.
  return row === null;
}
