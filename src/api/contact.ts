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

import { isAllowedOrigin, getResponseOrigin, corsHeaders } from '../lib/cors.js';
import { validateTurnstile } from '../lib/turnstile.js';
import { sanitize, isValidEmail } from '../lib/escape.js';
import { resolveMessages, type MessageSource } from '../lib/messages.js';

export interface ContactEnv {
  DB: D1Database;
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
  /** Called after a successful insert, for email or other side effects. */
  onStored?: (
    record: { name: string; email: string; message: string },
    context: EventContext<ContactEnv, string, Record<string, unknown>>
  ) => void | Promise<void>;
}

const DEFAULTS = {
  rateLimit: 3, maxName: 100, maxEmail: 254, maxMessage: 5000,
  dedupeWindowMs: 120_000,
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
      const body = (await context.request.json()) as ContactBody;
      // Re-resolve now the body is available: a multilingual site picks its
      // language from a field in it.
      t = resolveMessages(options.messages, context.request, body);

      // Honeypot: report success so the bot does not learn it was caught,
      // but store nothing.
      if (body._hp) return json({ success: true, message: t('success') });

      // Turnstile, when configured. An unset secret disables it rather than
      // failing every submission — a site may not use Turnstile at all.
      if (context.env.TURNSTILE_SECRET_KEY) {
        const token = body['cf-turnstile-response'] || '';
        const ok = await validateTurnstile(
          token,
          context.env.TURNSTILE_SECRET_KEY,
          context.request.headers.get('CF-Connecting-IP') || undefined
        );
        if (!ok) return json({ error: t('antispamFailed') }, 400);
      }

      if (!body.name?.trim() || !body.email?.trim() || !body.message?.trim()) {
        return json({ error: t('fieldsRequired'), required: ['name', 'email', 'message'] }, 400);
      }
      if (!isValidEmail(body.email.trim())) {
        return json({ error: t('invalidEmail') }, 400);
      }

      const name = sanitize(body.name, maxName);
      const email = body.email.trim().slice(0, maxEmail);
      const message = sanitize(body.message, maxMessage);
      const ip = context.request.headers.get('CF-Connecting-IP') || 'unknown';
      const userAgent = context.request.headers.get('User-Agent') || 'unknown';

      const oneHourAgo = new Date(Date.now() - 3_600_000).toISOString();
      const recent = await context.env.DB
        .prepare('SELECT COUNT(*) as count FROM contact_submissions WHERE ip = ? AND submitted_at > ?')
        .bind(ip, oneHourAgo)
        .first<{ count: number }>();

      if (recent && recent.count >= limit) {
        return json({ error: t('rateLimited') }, 429);
      }

      /*
       * Double-submit: report success without storing a second copy.
       *
       * Telling the visitor it failed would make them send it a third time,
       * and storing it would put duplicate enquiries in front of whoever
       * reads them. Same rule and same window as comment.ts — this is the
       * idempotency guarantee for a request nobody can retry deliberately.
       */
      const windowStart = new Date(Date.now() - dedupeWindow).toISOString();
      const duplicate = await context.env.DB
        .prepare(
          'SELECT COUNT(*) as count FROM contact_submissions ' +
          'WHERE email = ? AND message = ? AND submitted_at > ?'
        )
        .bind(email, message, windowStart)
        .first<{ count: number }>();
      if (duplicate && duplicate.count > 0) {
        return json({ success: true, message: t('success') });
      }

      // Column names are contractual with schema.sql: submitted_at, not
      // timestamp. A test in src/tests/workers-endpoints.test.mjs pins this.
      await context.env.DB
        .prepare(
          'INSERT INTO contact_submissions (name, email, message, submitted_at, ip, user_agent) ' +
          'VALUES (?, ?, ?, ?, ?, ?)'
        )
        .bind(name, email, message, new Date().toISOString(), ip, userAgent)
        .run();

      if (options.onStored) {
        // Side effects must not delay the response, and must not fail it.
        // The callback is invoked *inside* the async wrapper on purpose: a
        // synchronous throw would otherwise escape before Promise.resolve
        // could catch it, and 500 a submission that was already stored.
        const stored = { name, email, message };
        context.waitUntil(
          (async () => options.onStored!(stored, context))().catch((err) =>
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
