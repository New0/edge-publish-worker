/**
 * Contact form — shared Pages Function.
 *
 * Exposed as a factory rather than a bare handler, because the parts that
 * differ between sites are copy, branding and limits — not logic. A site wires
 * it up in three lines and owns nothing but its own words:
 *
 *   import { createContactHandler } from 'edgewpsync/functions/api/contact';
 *   export const onRequestPost = createContactHandler({
 *     messages: createMessages({ success: 'Merci !' }),
 *   });
 */

import { canWake, wakeWordPress } from '../lib/wake.js';
import type { WpFetchEnv } from '../lib/wp-fetch.js';
import { isAllowedOrigin, getResponseOrigin, corsHeaders } from '../lib/cors.js';
import { validateTurnstile } from '../lib/turnstile.js';
import { sanitize, isValidEmail } from '../lib/escape.js';
import { readJsonObject, text, withReplayableBody } from '../lib/body.js';
import { resolveMessages, type MessageSource } from '../lib/messages.js';

export interface ContactEnv {
  DB: D1Database;
  /** The site's origin, or several comma-separated (lib/cors.ts). */
  ALLOWED_ORIGIN: string;
  PAGES_PROJECT?: string;
  TURNSTILE_SECRET_KEY?: string;
}

export interface ContactBody {
  name?: string;
  email?: string;
  message?: string;
  /** Honeypot. Any value means a bot filled a hidden field. */
  _hp?: string;
  'cf-turnstile-response'?: string;
}

export interface ContactOptions {
  messages?: MessageSource;
  /** Submissions allowed per IP per hour. */
  rateLimit?: number;
  /**
   * How long an identical submission counts as the same one, in ms.
   *
   * A visitor who double-clicks, or whose browser retries on a flaky
   * connection, sends the message twice. Without this each copy becomes a row
   * in D1 and then a separate Ninja Forms submission in WordPress, and the
   * person reading enquiries has to work out which duplicates are real.
   * `comment.ts` has had this since it was written; contact did not.
   */
  dedupeWindowMs?: number;
  maxName?: number;
  maxEmail?: number;
  maxMessage?: number;
  /**
   * Whole request body, in bytes. Well above anything the field limits let
   * through, which still truncate rather than refuse: this is the ceiling on
   * what the Worker reads at all, not a limit a visitor can meet by typing.
   */
  maxBodyBytes?: number;
  /** Called after a successful insert, for email or other side effects. */
  onStored?: (
    record: { name: string; email: string; message: string },
    context: EventContext<ContactEnv, string, Record<string, unknown>>
  ) => void | Promise<void>;
}

const DEFAULTS = {
  rateLimit: 3, maxName: 100, maxEmail: 254, maxMessage: 5000,
  dedupeWindowMs: 120_000, maxBodyBytes: 64 * 1024,
};

/** OPTIONS preflight. Shared by every site. */
export function createContactOptionsHandler(): PagesFunction<ContactEnv> {
  return async (context) => {
    const origin = getResponseOrigin(
      context.request, context.env.ALLOWED_ORIGIN, context.env.PAGES_PROJECT
    );
    return new Response(null, { headers: corsHeaders(origin, 'POST, OPTIONS') });
  };
}

export function createContactHandler(options: ContactOptions = {}): PagesFunction<ContactEnv> {
  const limit = options.rateLimit ?? DEFAULTS.rateLimit;
  const dedupeWindow = options.dedupeWindowMs ?? DEFAULTS.dedupeWindowMs;
  const maxName = options.maxName ?? DEFAULTS.maxName;
  const maxEmail = options.maxEmail ?? DEFAULTS.maxEmail;
  const maxMessage = options.maxMessage ?? DEFAULTS.maxMessage;
  const maxBody = options.maxBodyBytes ?? DEFAULTS.maxBodyBytes;

  return async (context) => {
    const configuredOrigin = context.env.ALLOWED_ORIGIN;
    const requestOrigin = context.request.headers.get('Origin');
    const origin = getResponseOrigin(context.request, configuredOrigin, context.env.PAGES_PROJECT);
    const headers = { ...corsHeaders(origin, 'POST, OPTIONS'), 'Content-Type': 'application/json' };
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers });

    // Resolved before the body is read so early failures still get copy.
    let t = resolveMessages(options.messages, context.request, undefined);

    // CSRF: a cross-site form post carries no allowed Origin.
    if (!requestOrigin || !isAllowedOrigin(requestOrigin, configuredOrigin, context.env.PAGES_PROJECT)) {
      return json({ error: 'Unauthorized origin' }, 403);
    }

    try {
      /*
       * Read with a ceiling, and refuse what is not a JSON object with a 400.
       * Until 2026-09-28 this was `request.json()`, unbounded, and `null` or
       * `{"name": 1}` threw a TypeError further down: a 500 and an error log
       * for every bot that sent one, burying the errors that are ours.
       */
      const read = await readJsonObject(context.request, maxBody);
      if (!read.ok) {
        return read.reason === 'too_large'
          ? json({ error: t('tooLarge') }, 413)
          : json({ error: t('genericError') }, 400);
      }
      const body = read.body;
      // Re-resolve now the body is available: a multilingual site picks its
      // language from a field in it.
      t = resolveMessages(options.messages, context.request, body);

      // Honeypot: report success so the bot does not learn it was caught,
      // but store nothing.
      if (body._hp) return json({ success: true, message: t('success') });

      // Turnstile, when configured. An unset secret disables it rather than
      // failing every submission — a site may not use Turnstile at all.
      if (context.env.TURNSTILE_SECRET_KEY) {
        const token = text(body['cf-turnstile-response']);
        const ok = await validateTurnstile(
          token,
          context.env.TURNSTILE_SECRET_KEY,
          context.request.headers.get('CF-Connecting-IP') || undefined
        );
        if (!ok) return json({ error: t('antispamFailed') }, 400);
      }

      // A field that is not text is a field not filled in.
      const rawName = text(body.name);
      const rawEmail = text(body.email).trim();
      const rawMessage = text(body.message);
      if (!rawName.trim() || !rawEmail || !rawMessage.trim()) {
        return json({ error: t('fieldsRequired'), required: ['name', 'email', 'message'] }, 400);
      }
      if (!isValidEmail(rawEmail)) {
        return json({ error: t('invalidEmail') }, 400);
      }

      const name = sanitize(rawName, maxName);
      const email = rawEmail.slice(0, maxEmail);
      const message = sanitize(rawMessage, maxMessage);
      const ip = context.request.headers.get('CF-Connecting-IP') || 'unknown';
      const userAgent = context.request.headers.get('User-Agent') || 'unknown';

      const now = Date.now();
      const submittedAt = new Date(now).toISOString();
      const oneHourAgo = new Date(now - 3_600_000).toISOString();
      const windowStart = new Date(now - dedupeWindow).toISOString();

      /*
       * Double-submit: report success without storing a second copy.
       *
       * Telling the visitor it failed would make them send it a third time,
       * and storing it would put duplicate enquiries in front of whoever
       * reads them. Same rule and same window as comment.ts — this is the
       * idempotency guarantee for a request nobody can retry deliberately.
       *
       * Checked before the hourly limit: a browser retrying the message that
       * used the last of the allowance was told 429 about a message we hold.
       */
      const isDuplicate = async () => {
        const hit = await context.env.DB
          .prepare(
            'SELECT COUNT(*) as count FROM contact_submissions ' +
            'WHERE email = ? AND message = ? AND submitted_at > ?'
          )
          .bind(email, message, windowStart)
          .first<{ count: number }>();
        return Boolean(hit && hit.count > 0);
      };
      if (await isDuplicate()) {
        return json({ success: true, message: t('success') });
      }

      /*
       * The limit and the duplicate rule are conditions of the INSERT itself,
       * in one statement, so D1 decides both atomically. As a COUNT, then a
       * SELECT, then an INSERT, every request in a burst read the same count
       * before any of them wrote: fifty concurrent posts from one IP stored
       * fifty rows against a limit of three, each waking WordPress.
       *
       * Column names are contractual with schema.sql: submitted_at, not
       * timestamp. A test in src/tests/workers-contact.test.mjs pins this.
       */
      const inserted = await context.env.DB
        .prepare(
          'INSERT INTO contact_submissions (name, email, message, submitted_at, ip, user_agent) ' +
          'SELECT ?, ?, ?, ?, ?, ? ' +
          'WHERE (SELECT COUNT(*) FROM contact_submissions WHERE ip = ? AND submitted_at > ?) < ? ' +
          'AND NOT EXISTS (SELECT 1 FROM contact_submissions WHERE email = ? AND message = ? AND submitted_at > ?)'
        )
        .bind(
          name, email, message, submittedAt, ip, userAgent,
          ip, oneHourAgo, limit,
          email, message, windowStart
        )
        .run();

      if (!inserted.meta?.changes) {
        // Nothing stored: the hour's allowance is spent, or an identical copy
        // landed between the check above and the insert — a double-click's
        // twin. Only the second is the visitor's success.
        return (await isDuplicate())
          ? json({ success: true, message: t('success') })
          : json({ error: t('rateLimited') }, 429);
      }

      // Into WordPress within the owner's interval: the plugin drains it, and
      // WordPress mails the owner with its own wp_mail() — no mail service
      // needed. After the answer, and never failing it (lib/wake.ts).
      // WP_SOURCE and SYNC_SECRET are bindings every site's edge has (the
      // sync endpoints need them); this handler's own env type does not name
      // them, so they are read through WordPress's fetch type.
      const wpEnv = context.env as unknown as WpFetchEnv;
      if (canWake(wpEnv)) {
        context.waitUntil(
          wakeWordPress(wpEnv).then((outcome) => {
            if (!outcome.woken) console.warn(`[contact] WordPress was not woken: ${outcome.reason}`);
          })
        );
      }

      if (options.onStored) {
        // Side effects must not delay the response, and must not fail it.
        // The callback is invoked *inside* the async wrapper on purpose: a
        // synchronous throw would otherwise escape before Promise.resolve
        // could catch it, and 500 a submission that was already stored.
        const stored = { name, email, message };
        context.waitUntil(
          (async () => options.onStored!(stored, withReplayableBody(context, read.raw)))().catch((err) =>
            console.error('[contact] onStored failed:', err)
          )
        );
      }

      return json({ success: true, message: t('success') });
    } catch (error) {
      console.error('[contact] failed:', error);
      return json({ error: t('genericError') }, 500);
    }
  };
}
