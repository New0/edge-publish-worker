/**
 * Authentication helpers for admin and sync endpoints.
 *
 * Note on direction: bearer tokens are replayable. The sync endpoints should
 * move to HMAC-signed requests with a timestamp and nonce — see the
 * `ews-sync-protocol` skill. `authenticate()` remains for the endpoints that
 * have not migrated yet.
 */

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
  if (a.length !== b.length) return false;

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

/** Authenticate a request via `Authorization: Bearer <secret>`. */
export async function authenticate(request: Request, secret: string): Promise<boolean> {
  if (!secret) return false; // an unset binding must never authenticate
  const authHeader = request.headers.get('Authorization');
  if (!authHeader) return false;
  const [scheme, token] = authHeader.split(' ');
  if (scheme !== 'Bearer' || !token) return false;
  return secureCompare(token, secret);
}
