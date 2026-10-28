/**
 * Sending mail from the edge — docs/EDGE-ACCOUNTS.md §5.
 *
 * The sign-in link used to go out only through WordPress (`wp_mail`, asked by
 * a signed request), which meant signing in needed the origin to be up. A site
 * that binds a mail provider now sends it from here, and WordPress becomes the
 * fallback rather than the only way.
 *
 * ## Two transports, both optional
 *
 * - **Brevo**, with the site owner's own API key (`BREVO_API_KEY`) — a secret
 *   in *their* Cloudflare account, exactly like the Stripe key. We never hold
 *   it (docs/OPTION-A.md §1).
 * - **A relay Worker** (`MAIL_RELAY_URL`, `MAIL_RELAY_SECRET`) that takes
 *   `{to, subject, html, text, from}` with a bearer token and sends it on, to
 *   Brevo or another provider. For a site whose owner already runs such a
 *   Worker, so the provider key stays in one place.
 *
 * Either needs `MAIL_FROM` (`Site name <address@domain>`): a mail with no
 * sender the site chose would go out as whatever the provider or relay
 * defaults to, which for a shared relay is somebody else's address. Without it
 * no transport is used, and the caller asks WordPress, as before.
 *
 * ## Never throws
 *
 * A provider that is down, slow or refusing answers `{sent: false}` with the
 * reason, and the caller decides. Nothing here logs an address: the caller
 * already knows it, and a log pairing addresses with sign-ins is worth not
 * keeping.
 */

import { primaryOrigin } from './cors.js';

export interface MailEnv {
  /** The site owner's Brevo API key: send through Brevo's transactional API. */
  BREVO_API_KEY?: string;
  /** A relay Worker that takes `{to, subject, html, text, from}` and a bearer token. HTTPS only. */
  MAIL_RELAY_URL?: string;
  MAIL_RELAY_SECRET?: string;
  /** The sender: `Site name <address@domain>`, or a bare address. */
  MAIL_FROM?: string;
}

export interface OutgoingMail {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export type MailTransport = 'brevo' | 'relay';

export type SendOutcome =
  | { sent: true; via: MailTransport }
  | { sent: false; via: MailTransport | null; reason: 'not-configured' | 'refused' | 'unreachable'; status?: number };

const BREVO_URL = 'https://api.brevo.com/v3/smtp/email';

/** How long a provider gets before the visitor's request stops waiting for it. */
const TIMEOUT_MS = 10_000;

const ADDRESS = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

/** `Name <a@b.c>` or `a@b.c` → its parts, or null when it is neither. */
export function parseSender(value: unknown): { name: string; email: string } | null {
  const raw = String(value ?? '').trim();
  const named = /^(.*?)\s*<([^<>]+)>$/.exec(raw);
  const name = named ? named[1].trim().replace(/^"|"$/g, '') : '';
  const email = (named ? named[2] : raw).trim();
  return ADDRESS.test(email) ? { name, email } : null;
}

/** Which transport this site has, if any. Brevo wins when both are bound. */
export function mailTransport(env: MailEnv): MailTransport | null {
  if (!parseSender(env.MAIL_FROM)) return null;
  if (env.BREVO_API_KEY) return 'brevo';
  if (env.MAIL_RELAY_URL && env.MAIL_RELAY_SECRET && /^https:\/\//.test(env.MAIL_RELAY_URL)) return 'relay';
  return null;
}

/** Send one mail through the site's transport. Never throws. */
export async function sendMail(env: MailEnv, mail: OutgoingMail, fetchImpl: typeof fetch = fetch): Promise<SendOutcome> {
  const via = mailTransport(env);
  const sender = parseSender(env.MAIL_FROM);
  if (!via || !sender) return { sent: false, via: null, reason: 'not-configured' };

  const request: RequestInit =
    via === 'brevo'
      ? {
          method: 'POST',
          headers: { 'api-key': String(env.BREVO_API_KEY), 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({
            sender: sender.name ? sender : { email: sender.email },
            to: [{ email: mail.to }],
            subject: mail.subject,
            htmlContent: mail.html,
            textContent: mail.text,
          }),
        }
      : {
          method: 'POST',
          headers: { Authorization: `Bearer ${env.MAIL_RELAY_SECRET}`, 'Content-Type': 'application/json' },
          // `text` too: an HTML-only mail scores worse with spam filters.
          // A relay that does not read it ignores it.
          body: JSON.stringify({ to: mail.to, subject: mail.subject, html: mail.html, text: mail.text, from: env.MAIL_FROM }),
        };

  try {
    const response = await fetchImpl(via === 'brevo' ? BREVO_URL : String(env.MAIL_RELAY_URL), {
      ...request,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (response.ok) return { sent: true, via };
    return { sent: false, via, reason: 'refused', status: response.status };
  } catch {
    return { sent: false, via, reason: 'unreachable' };
  }
}

// ── The sign-in mail ─────────────────────────────────────────────────────

const SIGN_IN = {
  en: {
    subject: (site: string) => `Sign in to ${site}`,
    intro: (site: string) => `Here is your sign-in link for ${site}.`,
    button: 'Sign in',
    copy: 'Or copy this address into your browser:',
    expiry: (minutes: number) => `It works once, and for ${minutes} minutes. If you did not ask to sign in, you can ignore this message — nothing has changed.`,
  },
  fr: {
    subject: (site: string) => `Connexion à ${site}`,
    intro: (site: string) => `Voici votre lien de connexion à ${site}.`,
    button: 'Se connecter',
    copy: 'Ou copiez cette adresse dans votre navigateur :',
    expiry: (minutes: number) => `Il fonctionne une fois, pendant ${minutes} minutes. Si vous n’avez pas demandé à vous connecter, vous pouvez ignorer ce message : rien n’a changé.`,
  },
  es: {
    subject: (site: string) => `Inicia sesión en ${site}`,
    intro: (site: string) => `Este es tu enlace para iniciar sesión en ${site}.`,
    button: 'Iniciar sesión',
    copy: 'O copia esta dirección en tu navegador:',
    expiry: (minutes: number) => `Funciona una vez, durante ${minutes} minutos. Si no has pedido iniciar sesión, puedes ignorar este mensaje: no ha cambiado nada.`,
  },
};

type Lang = keyof typeof SIGN_IN;

/** The page's language, as far as these three go; English otherwise. */
export function mailLang(value: unknown): Lang {
  const base = String(value ?? '').toLowerCase().split(/[-_]/)[0];
  return (base in SIGN_IN ? base : 'en') as Lang;
}

const escape = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * The sign-in mail, in the page's language: the same words WordPress's version
 * uses, as HTML with a plain-text twin. The link appears twice in the HTML — a
 * button, and as text to copy — because some mail clients strip links.
 */
export function signInMail({ link, minutes, site, lang }: { link: string; minutes: number; site: string; lang?: unknown }): Omit<OutgoingMail, 'to'> {
  const code = mailLang(lang);
  const s = SIGN_IN[code];
  const subject = s.subject(site);
  const text = `${s.intro(site)}\n\n${link}\n\n${s.expiry(minutes)}\n`;
  const html =
    `<!DOCTYPE html><html lang="${code}"><head><meta charset="utf-8"><title>${escape(subject)}</title></head>` +
    `<body style="font-family:system-ui,sans-serif;line-height:1.5">` +
    `<p>${escape(s.intro(site))}</p>` +
    `<p><a href="${escape(link)}" style="display:inline-block;padding:0.6em 1.2em;background:#111;color:#fff;text-decoration:none;border-radius:4px">${escape(s.button)}</a></p>` +
    `<p>${escape(s.copy)}<br>${escape(link)}</p>` +
    `<p>${escape(s.expiry(minutes))}</p>` +
    `</body></html>`;
  return { subject, html, text };
}

/**
 * What the mail calls the site: the sender's display name, or the host of the
 * first origin ALLOWED_ORIGIN lists — read by lib/cors.ts, as every endpoint
 * reads it, so the list means the same thing here as at the door.
 */
export function siteName(env: MailEnv & { ALLOWED_ORIGIN?: string }): string {
  const named = parseSender(env.MAIL_FROM)?.name;
  if (named) return named;
  const primary = primaryOrigin(env.ALLOWED_ORIGIN);
  return primary ? new URL(primary).host : 'this site';
}
