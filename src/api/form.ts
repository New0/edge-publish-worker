/**
 * Generic form — shared Pages Function.
 *
 * `contact.ts` takes three named fields and answers everything else with a 400,
 * so a Contact Form 7, WPForms, Gravity, Fluent, Formidable, Elementor Pro or
 * Ninja Forms form had nowhere to go. This takes *any* form: the engine sends
 * the fields it found, in form order, and they are stored as one JSON record
 * per submission — the shape a site's own event-registration endpoint proved
 * on a 27-field conditional form (see docs/PLUGIN-WORKERS.md, "Built once";
 * this runtime is vendored into public repositories and names no site). A
 * column per field is what made every new form cost a schema change, an
 * endpoint and an importer; a JSON record costs none of those.
 *
 * Three parties build against the request and the row, and none of them may
 * move alone:
 *   - the engine rewrites a plugin's form to post here (the request below);
 *   - this endpoint validates and stores it (`form_submissions`, in
 *     `src/cloudflare/edge-schema.sql`);
 *   - the companion plugin drains the rows through `/api/sync?type=form`,
 *     reading `fields` as the JSON string it was stored as.
 *
 *   POST /api/form
 *   { "form":   { "plugin": "contact-form-7", "id": "5", "title": "Contact" },
 *     "page":   "/contact/",
 *     "fields": [ { "name": "your-name", "label": "Your name", "type": "text", "value": "Ada" },
 *                 { "name": "topics[]", "label": "Topics", "type": "checkbox", "value": ["a", "b"] } ],
 *     "_hp": "", "cf-turnstile-response": "…" }
 *
 * Factory-shaped like contact and comment: copy, limits and notification
 * belong to the site; validation, rate limiting and storage do not.
 *
 *   import { createFormHandler } from 'edgewpsync/functions/api/form';
 *   export const onRequestPost = createFormHandler({
 *     messages: createMessages({ success: 'Merci !' }),
 *   });
 */

import { canWake, wakeWordPress } from '../lib/wake.js';
import type { WpFetchEnv } from '../lib/wp-fetch.js';
import { isAllowedOrigin, getResponseOrigin, corsHeaders } from '../lib/cors.js';
import { validateTurnstile } from '../lib/turnstile.js';
import { sanitize, isValidEmail } from '../lib/escape.js';
import { isPlainObject, readCapped, withReplayableBody } from '../lib/body.js';
import { resolveMessages, type MessageKey, type MessageSource } from '../lib/messages.js';

export interface FormEnv {
  DB: D1Database;
  /** The site's origin, or several comma-separated (lib/cors.ts). */
  ALLOWED_ORIGIN: string;
  PAGES_PROJECT?: string;
  TURNSTILE_SECRET_KEY?: string;
}

/**
 * Which plugin rendered the form. A closed list, because the drain decides
 * where a submission lands in WordPress by this value — a free-text plugin name
 * would be a row nothing knows how to import. `html` is a plain form no plugin
 * owns.
 */
export const FORM_PLUGINS = [
  'contact-form-7',
  'wpforms',
  'gravityforms',
  'fluentform',
  'formidable',
  'ninja-forms',
  'elementor-pro',
  'html',
] as const;

export type FormPlugin = (typeof FORM_PLUGINS)[number];

/** One field as stored: always all four keys, so the drain reads one shape. */
export interface FormField {
  name: string;
  label: string;
  type: string;
  value: string | string[];
}

export interface FormRecord {
  form: { plugin: FormPlugin; id: string | null; title: string | null };
  page: string;
  fields: FormField[];
}

export interface FormOptions {
  messages?: MessageSource;
  /** Submissions allowed per IP per hour, across every form on the site. */
  rateLimit?: number;
  /**
   * How long an identical submission counts as the same one, in ms. Same rule
   * and same window as contact and comment: a double-click or a browser retry
   * must not become two rows and then two entries in WordPress.
   */
  dedupeWindowMs?: number;
  /** Whole request body, in bytes. */
  maxBodyBytes?: number;
  maxFields?: number;
  maxName?: number;
  maxLabel?: number;
  /** Per value, or per item of an array value, in characters. */
  maxValue?: number;
  /** Called after a successful insert, for email or other side effects. */
  onStored?: (
    record: FormRecord,
    context: EventContext<FormEnv, string, Record<string, unknown>>
  ) => void | Promise<void>;
}

const DEFAULTS = {
  rateLimit: 3,
  dedupeWindowMs: 120_000,
  maxBodyBytes: 64 * 1024,
  maxFields: 100,
  maxName: 200,
  maxLabel: 500,
  maxValue: 10_000,
};

/*
 * Limits the contract does not name, chosen here. The form id and title come
 * from the plugin's markup rather than from the visitor, and a field's type
 * from an `<input type>`, so anything longer than these is not a form the
 * engine produced.
 */
const MAX_FORM_ID = 200;
const MAX_FORM_TITLE = 500;
const MAX_TYPE = 50;
const MAX_PAGE = 2048;

/** Why a request was refused. Stable, for a script to act on; the copy is for people. */
type Refusal =
  | 'invalid_json'
  | 'invalid_form'
  | 'unknown_plugin'
  | 'invalid_page'
  | 'invalid_fields'
  | 'too_many_fields'
  | 'invalid_field'
  | 'name_too_long'
  | 'label_too_long'
  | 'value_too_long'
  | 'empty'
  | 'invalid_email';

/**
 * Is this a path on this site, and nothing else?
 *
 * `page` is stored and later shown to whoever reads submissions in WordPress,
 * so it must not be able to carry somebody else's address. A leading `/` is
 * not enough on its own: `//evil.test/` is protocol-relative and `/\evil.test`
 * is read as a host by browsers, and both start with a slash.
 */
export function isSiteRelativePath(page: unknown): page is string {
  if (typeof page !== 'string' || page.length === 0 || page.length > MAX_PAGE) return false;
  if (!page.startsWith('/')) return false;
  if (page.startsWith('//') || page.startsWith('/\\')) return false;
  // No whitespace, no control characters, no backslashes anywhere: none of
  // them belong in a path a browser reported, and each is a way to smuggle one.
  return !/[\s\\\u0000-\u001f\u007f]/.test(page);
}

/** OPTIONS preflight. Shared by every site. */
export function createFormOptionsHandler(): PagesFunction<FormEnv> {
  return async (context) => {
    const origin = getResponseOrigin(
      context.request, context.env.ALLOWED_ORIGIN, context.env.PAGES_PROJECT
    );
    return new Response(null, { headers: corsHeaders(origin, 'POST, OPTIONS') });
  };
}

export function createFormHandler(options: FormOptions = {}): PagesFunction<FormEnv> {
  const limit = options.rateLimit ?? DEFAULTS.rateLimit;
  const dedupeWindow = options.dedupeWindowMs ?? DEFAULTS.dedupeWindowMs;
  const maxBody = options.maxBodyBytes ?? DEFAULTS.maxBodyBytes;
  const maxFields = options.maxFields ?? DEFAULTS.maxFields;
  const maxName = options.maxName ?? DEFAULTS.maxName;
  const maxLabel = options.maxLabel ?? DEFAULTS.maxLabel;
  const maxValue = options.maxValue ?? DEFAULTS.maxValue;

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

    // Refused before a byte is read when the client says it is too large.
    const declared = Number(context.request.headers.get('Content-Length'));
    if (Number.isFinite(declared) && declared > maxBody) {
      return json({ error: t('tooLarge'), code: 'too_large', maxBytes: maxBody }, 413);
    }

    try {
      const raw = await readCapped(context.request, maxBody);
      if (raw === null) {
        return json({ error: t('tooLarge'), code: 'too_large', maxBytes: maxBody }, 413);
      }

      /*
       * Malformed JSON is the client's fault, so a 400 and not a 500 (which
       * contact and comment answered until 2026-09-28). The engine is the
       * only client that should reach this, and a 500 would send whoever
       * debugs it looking at the Worker instead.
       */
      let body: unknown;
      try {
        body = JSON.parse(raw);
      } catch {
        return json({ error: t('formInvalid'), code: 'invalid_json' }, 400);
      }
      if (!isPlainObject(body)) {
        return json({ error: t('formInvalid'), code: 'invalid_json' }, 400);
      }

      // Re-resolve now the body is available: a multilingual site picks its
      // language from a field in it.
      t = resolveMessages(options.messages, context.request, body);
      const refuse = (code: Refusal, extra: Record<string, unknown> = {}, key: MessageKey = 'formInvalid') =>
        json({ error: t(key, extra.field ? { field: String(extra.field) } : undefined), code, ...extra }, 400);

      // Honeypot: report success so the bot does not learn it was caught,
      // but store nothing. Before every other check, as in contact.ts, so a
      // bot's malformed payload is not answered with a map of what we want.
      if (body._hp) return json({ success: true, message: t('success') });

      // Turnstile, when configured. An unset secret disables it rather than
      // failing every submission — a site may not use Turnstile at all.
      if (context.env.TURNSTILE_SECRET_KEY) {
        const token = typeof body['cf-turnstile-response'] === 'string' ? body['cf-turnstile-response'] : '';
        const ok = await validateTurnstile(
          token,
          context.env.TURNSTILE_SECRET_KEY,
          context.request.headers.get('CF-Connecting-IP') || undefined
        );
        if (!ok) return json({ error: t('antispamFailed'), code: 'antispam' }, 400);
      }

      // ── The form ──────────────────────────────────────────────────────
      const form = body.form;
      if (!isPlainObject(form)) return refuse('invalid_form');
      if (typeof form.plugin !== 'string' || !(FORM_PLUGINS as readonly string[]).includes(form.plugin)) {
        return refuse('unknown_plugin', { allowed: FORM_PLUGINS });
      }
      const plugin = form.plugin as FormPlugin;

      /*
       * The id is the plugin's, and plugins disagree about whether it is a
       * number: CF7 prints `5`, Elementor a hash. Accepted as either and stored
       * as text, which is what the column is.
       */
      let formId: string | null = null;
      if (typeof form.id === 'number' && Number.isFinite(form.id)) formId = String(form.id);
      else if (typeof form.id === 'string' && form.id.length <= MAX_FORM_ID) formId = sanitize(form.id, MAX_FORM_ID) || null;
      else if (form.id !== undefined && form.id !== null) return refuse('invalid_form');

      let formTitle: string | null = null;
      if (typeof form.title === 'string' && form.title.length <= MAX_FORM_TITLE) formTitle = sanitize(form.title, MAX_FORM_TITLE) || null;
      else if (form.title !== undefined && form.title !== null) return refuse('invalid_form');

      // ── Where it came from ────────────────────────────────────────────
      if (!isSiteRelativePath(body.page)) return refuse('invalid_page');
      const page = body.page;

      // ── The fields ────────────────────────────────────────────────────
      if (!Array.isArray(body.fields)) return refuse('invalid_fields');
      if (body.fields.length > maxFields) return refuse('too_many_fields', { max: maxFields });

      /*
       * Lengths are judged on what was sent, and refused rather than
       * truncated. Contact truncates a name or a message and nobody loses
       * much; here a truncated value is a silently altered answer to a
       * question we cannot see, which the owner would then act on.
       *
       * HTML is stripped the way contact strips it, after the length check,
       * so the limit is on the request and not on what survived cleaning.
       * Names are kept exactly: they are the plugin's own keys
       * (`wpforms[fields][1]`, `input_1.3`), and an importer maps them back.
       */
      const fields: FormField[] = [];
      for (const item of body.fields) {
        if (!isPlainObject(item)) return refuse('invalid_field');
        const { name, label, type, value } = item;

        if (typeof name !== 'string' || name.trim() === '') return refuse('invalid_field');
        if (name.length > maxName) return refuse('name_too_long', { field: name.slice(0, 50), max: maxName });
        if (label !== undefined && label !== null && typeof label !== 'string') return refuse('invalid_field', { field: name });
        if (type !== undefined && type !== null && typeof type !== 'string') return refuse('invalid_field', { field: name });
        if (typeof label === 'string' && label.length > maxLabel) return refuse('label_too_long', { field: name, max: maxLabel });
        if (typeof type === 'string' && type.length > MAX_TYPE) return refuse('invalid_field', { field: name });

        let clean: string | string[];
        if (typeof value === 'string') {
          if (value.length > maxValue) return refuse('value_too_long', { field: name, max: maxValue }, 'fieldTooLong');
          clean = sanitize(value, maxValue);
        } else if (Array.isArray(value)) {
          // A checkbox group or a multi-select: several answers to one
          // question, kept as several rather than joined into one string the
          // importer would have to guess how to split.
          const items: string[] = [];
          for (const v of value) {
            if (typeof v !== 'string') return refuse('invalid_field', { field: name });
            if (v.length > maxValue) return refuse('value_too_long', { field: name, max: maxValue }, 'fieldTooLong');
            items.push(sanitize(v, maxValue));
          }
          clean = items;
        } else {
          return refuse('invalid_field', { field: name });
        }

        fields.push({
          name,
          label: typeof label === 'string' ? sanitize(label, maxLabel) : '',
          type: typeof type === 'string' ? sanitize(type, MAX_TYPE).toLowerCase() : '',
          value: clean,
        });
      }

      const filled = (v: string | string[]) =>
        Array.isArray(v) ? v.some((s) => s !== '') : v !== '';

      // An empty submission is somebody pressing send on a blank form, or a
      // conversion that sent nothing it found. Either way there is nothing
      // to import, and saying so is kinder than a row of blanks.
      if (!fields.some((f) => filled(f.value))) {
        return refuse('empty', {}, 'fieldsRequired');
      }

      // Every email field with an answer must look like an address. Only
      // format — whether it is required is the form's business, and the
      // form already enforced it in the browser.
      for (const f of fields) {
        if (f.type !== 'email') continue;
        const answers = Array.isArray(f.value) ? f.value : [f.value];
        if (answers.some((a) => a !== '' && !isValidEmail(a))) {
          return refuse('invalid_email', { field: f.name }, 'invalidEmail');
        }
      }

      const fieldsJson = JSON.stringify(fields);
      const ip = context.request.headers.get('CF-Connecting-IP') || 'unknown';
      const userAgent = context.request.headers.get('User-Agent') || 'unknown';

      const now = Date.now();
      const submittedAt = new Date(now).toISOString();
      const oneHourAgo = new Date(now - 3_600_000).toISOString();
      const windowStart = new Date(now - dedupeWindow).toISOString();

      /*
       * Double-submit: report success without storing a second copy.
       *
       * Matched on the page and the cleaned fields together, as stored. There
       * is no sender to match on — a generic form need not ask for an email —
       * and the whole answer set is the only thing that identifies a repeat
       * rather than a second person saying the same thing.
       *
       * Checked before the hourly limit: a browser retrying the submission
       * that used the last of the allowance was told 429 about an answer we
       * already hold.
       */
      const isDuplicate = async () => {
        const hit = await context.env.DB
          .prepare(
            'SELECT COUNT(*) as count FROM form_submissions ' +
            'WHERE page = ? AND fields = ? AND submitted_at > ?'
          )
          .bind(page, fieldsJson, windowStart)
          .first<{ count: number }>();
        return Boolean(hit && hit.count > 0);
      };
      if (await isDuplicate()) {
        return json({ success: true, message: t('success') });
      }

      /*
       * One budget across every form on the site — a bot that finds three
       * forms should not get three times the allowance — and the duplicate
       * rule, both as conditions of the INSERT, in one statement D1 decides
       * atomically. As a COUNT, a SELECT and an INSERT, fifty concurrent posts
       * from one IP all read a count of zero and all fifty were stored
       * against a limit of three (review of 2026-09-28).
       *
       * Column names are contractual with edge-schema.sql, and with the
       * plugin that drains them. service-provisioner.test.mjs checks this
       * INSERT against the schema.
       */
      const inserted = await context.env.DB
        .prepare(
          'INSERT INTO form_submissions (form_plugin, form_id, form_title, page, fields, submitted_at, ip, user_agent) ' +
          'SELECT ?, ?, ?, ?, ?, ?, ?, ? ' +
          'WHERE (SELECT COUNT(*) FROM form_submissions WHERE ip = ? AND submitted_at > ?) < ? ' +
          'AND NOT EXISTS (SELECT 1 FROM form_submissions WHERE page = ? AND fields = ? AND submitted_at > ?)'
        )
        .bind(
          plugin, formId, formTitle, page, fieldsJson, submittedAt, ip, userAgent,
          ip, oneHourAgo, limit,
          page, fieldsJson, windowStart
        )
        .run();

      if (!inserted.meta?.changes) {
        // Nothing stored: the allowance is spent, or the twin of a
        // double-click landed between the check above and the insert. Only
        // the second is the visitor's success.
        return (await isDuplicate())
          ? json({ success: true, message: t('success') })
          : json({ error: t('rateLimited'), code: 'rate_limited' }, 429);
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
            if (!outcome.woken) console.warn(`[form] WordPress was not woken: ${outcome.reason}`);
          })
        );
      }

      if (options.onStored) {
        // Side effects must not delay the response, and must not fail it.
        // Invoked inside the async wrapper so a synchronous throw is caught
        // too, rather than 500ing a submission that was already stored.
        const stored: FormRecord = { form: { plugin, id: formId, title: formTitle }, page, fields };
        context.waitUntil(
          (async () => options.onStored!(stored, withReplayableBody(context, raw)))().catch((err) =>
            console.error('[form] onStored failed:', err)
          )
        );
      }

      return json({ success: true, message: t('success') });
    } catch (error) {
      console.error('[form] failed:', error);
      return json({ error: t('genericError') }, 500);
    }
  };
}
