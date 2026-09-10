/**
 * Cloudflare Turnstile server-side validation.
 */

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/**
 * Verify a Turnstile token. Returns false on any failure — network error,
 * non-2xx, or an unsuccessful verdict — so a caller can treat it as a simple
 * gate. Fails closed by design: a Turnstile outage blocks submissions rather
 * than waving them through.
 */
export async function validateTurnstile(
  token: string,
  secretKey: string,
  ip?: string
): Promise<boolean> {
  if (!token || !secretKey) return false;

  const body: Record<string, string> = { secret: secretKey, response: token };
  if (ip) body.remoteip = ip;

  try {
    const res = await fetch(SITEVERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body).toString(),
    });
    if (!res.ok) return false;
    const result = (await res.json()) as { success?: boolean };
    return result.success === true;
  } catch {
    return false;
  }
}
