/**
 * Authentication for the sync endpoints: a signed request, and nothing else.
 *
 * A **signed request** proves possession of the shared secret without putting
 * it on the wire, and a timestamp and nonce make a captured request useless
 * within five minutes. A **bearer token** sends the secret itself, in every
 * request, where anything that logs a header keeps it forever — a proxy, an
 * error reporter, a browser extension.
 *
 * Until 2026-10-29 `sync`, `update-page` and `update-index` still accepted
 * one (`allowBearer`), for the per-site plugins that predated signing. Those
 * plugins are gone from every origin, nothing in this repository or either
 * site sends one, and the fallback was removed. A request that offers one is
 * refused and logged as `bearer-not-accepted`, so a forgotten sender says so.
 */

import { verifySignature, seenNonceInD1, NO_NONCE_STORE, SIGNATURE_V2_HEADER, type SignatureResult } from './signature.js';

/**
 * Constant-time string comparison via HMAC, so the comparison cost does not
 * leak how many leading characters matched.
 *
 * The HMAC key is a fixed label, not a secret: its only job is to map both
 * inputs to fixed-width digests before the XOR compare. It must be identical
 * on both sides of the comparison, which is why it is a constant here rather
 * than per-site configuration.
 */
export async function secureCompare(a: string, b: string): Promise<boolean> {
  // No early return on length: the digests are fixed-width, so the compare
  // below is already length-blind, and returning first told a caller timing
  // its guesses how long the secret is (review, 2026-10-28).
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode('edgewpsync-auth-compare'),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const [sigA, sigB] = await Promise.all([
    crypto.subtle.sign('HMAC', key, encoder.encode(a)),
    crypto.subtle.sign('HMAC', key, encoder.encode(b)),
  ]);

  const arrA = new Uint8Array(sigA);
  const arrB = new Uint8Array(sigB);
  let result = 0;
  for (let i = 0; i < arrA.length; i++) result |= arrA[i] ^ arrB[i];
  return result === 0;
}

/** How a request proved itself. */
export type AuthMethod = 'signature' | null;

/**
 * Why a request was refused. For a log, never a response body.
 *
 * `bearer-not-accepted`      an `Authorization` header and no signature. No
 *                            endpoint takes a bearer token since 2026-10-29.
 * `nonce-store-unavailable`  the nonce store is bound and failed — a missing
 *                            `ews_nonces` table, a D1 outage. Answered 503.
 */
export type AuthRefusal =
  | NonNullable<SignatureResult['reason']>
  | 'bearer-not-accepted'
  | 'nonce-store-unavailable';

export interface AuthResult {
  ok: boolean;
  method: AuthMethod;
  /** For an accepted signature: 2, or 1 from a signer that predates v2 (and was logged). */
  version?: 1 | 2;
  /**
   * Present when the request offered something and was refused. For a log,
   * never a response. Absent for a request with no credential at all.
   */
  reason?: AuthRefusal;
  /**
   * The status a refusal answers with: 401, or 503 when the nonce store is
   * bound and failed — the site's fault, not the caller's, and worth a retry.
   */
  status?: 401 | 503;
}

export interface AuthOptions {
  /** The tag on this endpoint's log lines, e.g. `update-page`. Defaults to the path. */
  endpoint?: string;
  /**
   * The lowest signature version accepted — pass `env.SIGNATURE_MIN_VERSION`.
   * `'2'` refuses a request signed v1 only; anything else accepts it and logs
   * it. An endpoint that does not pass this stays at 1 whatever the
   * environment says, which `src/tests/signature-callers.test.mjs` catches.
   */
  minVersion?: unknown;
}

/** Thrown out of the nonce callback, so a store failure is told apart from anything else. */
class NonceStoreError extends Error {}

/**
 * Who asked, for a log line: method, path and the caller's address.
 *
 * Never the signature, the token or the body. A refusal named neither the
 * endpoint nor the caller until 2026-09-28, so a burst of them could not be
 * told apart from one misconfigured plugin.
 */
function caller(request: Request): string {
  let path = '(unknown path)';
  try { path = new URL(request.url).pathname; } catch { /* a Request always has a URL */ }
  return `${request.method} ${path} from ${request.headers.get('CF-Connecting-IP') || 'unknown address'}`;
}

function tagOf(request: Request, options: AuthOptions): string {
  if (options.endpoint) return options.endpoint;
  try { return new URL(request.url).pathname; } catch { return 'auth'; }
}

/** One line per refusal of a request that offered a credential. */
function logRefusal(request: Request, options: AuthOptions, reason: AuthRefusal): void {
  const hint =
    reason === 'no-nonce-store'
      ? ' — this deployment has no D1 binding named DB, where signature nonces are recorded, so every signed request is refused. Bind the site\'s D1 as DB.'
      : reason === 'bearer-not-accepted'
        ? ' — the sync endpoints take only signed requests since 2026-10-29; a sender still using a bearer token predates signing and must be updated.'
        : reason === 'v1-refused'
          ? ' — signed with the secret, but v1 only, and SIGNATURE_MIN_VERSION is 2. The sender predates v2 and must be updated.'
          : '';
  console.warn(`[${tagOf(request, options)}] refused ${caller(request)}: ${reason}${hint}`);
}

/**
 * Authenticate a sync request by its signature.
 *
 * The raw body is passed in rather than read here, because a `Request` body can
 * only be read once and the handler needs it too — and reading it twice is the
 * bug that presents as a wrong secret.
 *
 *
 * Refusals are logged here, with the endpoint and the caller's address, so
 * every endpoint says the same thing the same way. A nonce store that throws
 * is caught here too: until 2026-09-28 a missing `ews_nonces` table threw out
 * of every handler as an untagged 500.
 */
export async function authenticateSync(
  request: Request,
  rawBody: string,
  secret: string,
  seenNonce: (nonce: string) => Promise<boolean | typeof NO_NONCE_STORE>,
  options: AuthOptions = {}
): Promise<AuthResult> {
  const refuse = (reason: AuthRefusal): AuthResult => {
    logRefusal(request, options, reason);
    return { ok: false, method: null, reason, status: 401 };
  };

  // Either header makes it a signed request. Since 2026-09-29 signers send a
  // v2 beside v1; one day they may send v2 alone.
  if (request.headers.get('X-EWS-Signature') || request.headers.get(SIGNATURE_V2_HEADER) !== null) {
    const guarded = async (nonce: string) => {
      try {
        return await seenNonce(nonce);
      } catch (error) {
        throw new NonceStoreError(error instanceof Error ? error.message : String(error));
      }
    };
    let result: SignatureResult;
    try {
      result = await verifySignature(request, rawBody, secret, guarded, { minVersion: options.minVersion });
    } catch (error) {
      if (!(error instanceof NonceStoreError)) throw error;
      console.error(`[${tagOf(request, options)}] nonce store unavailable: ${error.message} (${caller(request)})`);
      return { ok: false, method: null, reason: 'nonce-store-unavailable', status: 503 };
    }
    if (!result.ok) return refuse(result.reason ?? 'bad-signature');
    if (result.version === 1) {
      // Said every time, so the owner can see
      // when the last v1-only signer has moved and SIGNATURE_MIN_VERSION can
      // be set to 2. The endpoint and the caller, never the signature.
      console.warn(
        `[${tagOf(request, options)}] accepted a v1 signature, which binds no method or path: ${caller(request)}. ` +
          'Signers send v2 since 2026-09-29; when these lines stop, set SIGNATURE_MIN_VERSION=2.'
      );
    }
    return { ok: true, method: 'signature', version: result.version };
  }

  // Nothing offered: anyone at all, and not worth a log line each.
  if (!request.headers.get('Authorization')) return { ok: false, method: null, status: 401 };
  // A bearer token, or anything else in Authorization: refused, and said, so
  // a sender left over from before signing is visible rather than silent.
  return refuse('bearer-not-accepted');
}

/**
 * The `seenNonce` callback `authenticateSync` needs, bound to a site's D1.
 *
 * `signature.ts` deliberately provides no default for this parameter, because a
 * function that always answers "new" silently disables replay protection. So
 * when a deployment has no `DB` binding this **fails closed**: it answers
 * `NO_NONCE_STORE`, and a signed request is refused rather than accepted
 * without the protection the scheme promises — under that name, not as a
 * `replay`, which is what it logged until 2026-09-28 and which reads as an
 * attack. That matches how an unset `SYNC_SECRET` is treated one function up —
 * an unconfigured deployment authenticates nobody.
 *
 * A site whose edge genuinely has no D1 therefore cannot authenticate sync
 * requests at all: the nonce store *is* half of what a signature buys over a
 * bearer token, and since 2026-10-29 there is no bearer path to fall back on.
 */
export function nonceChecker(db: D1Database | undefined): (nonce: string) => Promise<boolean | typeof NO_NONCE_STORE> {
  if (!db) return async () => NO_NONCE_STORE;
  return (nonce: string) => seenNonceInD1(db, nonce);
}

/**
 * The body and status for a refused request: `Unauthorized`, or — when the
 * nonce store failed — a 503 that says to try again, since the caller did
 * nothing wrong.
 */
export function refusal(auth: AuthResult): { body: { error: string }; status: 401 | 503 } {
  return auth.status === 503
    ? { body: { error: 'Temporarily unavailable' }, status: 503 }
    : { body: { error: 'Unauthorized' }, status: 401 };
}
