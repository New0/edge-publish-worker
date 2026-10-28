/**
 * Blog comments — shared Pages Function.
 *
 * GET  returns approved comments for a post.
 * POST accepts a submission and stores it pending moderation.
 *
 * Factory-shaped for the same reason as contact: copy, limits and notification
 * behaviour belong to the site; validation, rate limiting and storage do not.
 */

import { canWake, wakeWordPress } from '../lib/wake.js';
import type { WpFetchEnv } from '../lib/wp-fetch.js';
import { isAllowedOrigin, getResponseOrigin, corsHeaders } from '../lib/cors.js';
import { validateTurnstile } from '../lib/turnstile.js';
import { sanitize, isValidEmail } from '../lib/escape.js';
import { readJsonObject, text, withReplayableBody } from '../lib/body.js';
import { createMessages, resolveMessages, type MessageSource } from '../lib/messages.js';

export interface CommentEnv {
  DB: D1Database;
  /** The site's origin, or several comma-separated (lib/cors.ts). */
  ALLOWED_ORIGIN: string;
  PAGES_PROJECT?: string;
  TURNSTILE_SECRET_KEY?: string;
}

export interface CommentBody {
  author?: string;
  email?: string;
  comment?: string;
  post_id?: number | string;
  post_slug?: string;
  parent_id?: number | string;
  /**
   * WordPress core's own comment form names these `comment_post_ID` and
   * `comment_parent`, and the engine routes that form here unchanged. Until
   * 2026-09-18 only `post_id`/`parent_id` were read, so every converted core
   * comment form got "could not determine which post" — while a test that
   * copied the contract instead of calling this handler passed.
   */
  comment_post_ID?: number | string;
  comment_parent?: number | string;
  _hp?: string;
  'cf-turnstile-response'?: string;
}

export interface CommentOptions {
  messages?: MessageSource;
  rateLimit?: number;
  maxAuthor?: number;
  maxEmail?: number;
  maxComment?: number;
  /** Window in ms within which an identical comment from the same email is treated as a duplicate. */
  dedupeWindowMs?: number;
  /**
   * Whole request body, in bytes: the ceiling on what the Worker reads at
   * all. Well above what the field limits let through, which truncate.
   */
  maxBodyBytes?: number;
  /** Called after a successful insert — moderation notifications, etc. */
  onStored?: (
    record: { authorName: string; authorEmail: string; content: string; postSlug: string },
    context: EventContext<CommentEnv, string, Record<string, unknown>>
  ) => void | Promise<void>;
}

const DEFAULTS = {
  rateLimit: 5, maxAuthor: 100, maxEmail: 254, maxComment: 3000, dedupeWindowMs: 120_000,
  maxBodyBytes: 64 * 1024,
};

/**
 * Normalize a post slug to the stored form.
 *
 * Exported and used on BOTH the read and write paths on purpose. The site
 * implementation stripped the slug on POST but queried with the raw parameter
 * on GET, so any slug containing a character outside [A-Za-z0-9-] was stored
 * under a different key than it was read back with — comments submitted
 * against such a post were accepted and then never appeared. Normalizing once,
 * in one place, is what makes the two paths agree.
 */
export function normalizeSlug(raw: unknown): string {
  // Anything but text is no slug: `post_slug: 5` in a JSON body was a
  // TypeError on `.trim()`, and a 500.
  return (typeof raw === 'string' ? raw : '').trim().slice(0, 200).replace(/[^a-zA-Z0-9-]/g, '');
}

export function createCommentOptionsHandler(): PagesFunction<CommentEnv> {
  return async (context) => {
    const origin = getResponseOrigin(
      context.request, context.env.ALLOWED_ORIGIN, context.env.PAGES_PROJECT
    );
    return new Response(null, { headers: corsHeaders(origin, 'GET, POST, OPTIONS') });
  };
}

/** GET — approved comments for a post, oldest first. */
export function createCommentGetHandler(options: CommentOptions = {}): PagesFunction<CommentEnv> {
  return async (context) => {
    const t = resolveMessages(options.messages, context.request, undefined);
    const origin = getResponseOrigin(
      context.request, context.env.ALLOWED_ORIGIN, context.env.PAGES_PROJECT
    );
    const headers = {
      ...corsHeaders(origin, 'GET, POST, OPTIONS'), 'Content-Type': 'application/json',
    };

    const postSlug = normalizeSlug(new URL(context.request.url).searchParams.get('post_slug'));
    if (!postSlug) {
      return new Response(JSON.stringify({ error: t('slugRequired') }), { status: 400, headers });
    }

    try {
      const results = await context.env.DB
        .prepare(
          'SELECT id, author_name, content, submitted_at, parent_id FROM comments ' +
          'WHERE post_slug = ? AND status = ? ORDER BY submitted_at ASC'
        )
        .bind(postSlug, 'approved')
        .all();
      return new Response(JSON.stringify({ comments: results.results || [] }), { headers });
    } catch (error) {
      console.error('[comment] read failed:', error);
      return new Response(JSON.stringify({ error: t('genericError') }), { status: 500, headers });
    }
  };
}

/** POST — accept a comment for moderation. */
export function createCommentPostHandler(options: CommentOptions = {}): PagesFunction<CommentEnv> {
  const limit = options.rateLimit ?? DEFAULTS.rateLimit;
  const maxAuthor = options.maxAuthor ?? DEFAULTS.maxAuthor;
  const maxEmail = options.maxEmail ?? DEFAULTS.maxEmail;
  const maxComment = options.maxComment ?? DEFAULTS.maxComment;
  const dedupeWindow = options.dedupeWindowMs ?? DEFAULTS.dedupeWindowMs;
  const maxBody = options.maxBodyBytes ?? DEFAULTS.maxBodyBytes;

  return async (context) => {
    const configuredOrigin = context.env.ALLOWED_ORIGIN;
    const requestOrigin = context.request.headers.get('Origin');
    const origin = getResponseOrigin(context.request, configuredOrigin, context.env.PAGES_PROJECT);
    const headers = {
      ...corsHeaders(origin, 'GET, POST, OPTIONS'), 'Content-Type': 'application/json',
    };
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers });

    let t = resolveMessages(options.messages, context.request, undefined);

    if (!requestOrigin || !isAllowedOrigin(requestOrigin, configuredOrigin, context.env.PAGES_PROJECT)) {
      return json({ error: 'Unauthorized origin' }, 403);
    }

    try {
      // Read with a ceiling; anything but a JSON object is the client's
      // mistake, a 400 — not a TypeError further down and a 500. As contact.ts.
      const read = await readJsonObject(context.request, maxBody);
      if (!read.ok) {
        return read.reason === 'too_large'
          ? json({ error: t('tooLarge') }, 413)
          : json({ error: t('genericError') }, 400);
      }
      const body = read.body;
      t = resolveMessages(options.messages, context.request, body);

      if (body._hp) return json({ success: true, message: t('success') });

      if (context.env.TURNSTILE_SECRET_KEY) {
        const ok = await validateTurnstile(
          text(body['cf-turnstile-response']),
          context.env.TURNSTILE_SECRET_KEY,
          context.request.headers.get('CF-Connecting-IP') || undefined
        );
        if (!ok) return json({ error: t('antispamFailed') }, 400);
      }

      // A field that is not text is a field not filled in.
      const rawAuthor = text(body.author);
      const rawEmail = text(body.email).trim();
      const rawComment = text(body.comment);
      if (!rawAuthor.trim() || !rawEmail || !rawComment.trim()) {
        return json({ error: t('fieldsRequired'), required: ['author', 'email', 'comment'] }, 400);
      }
      if (!isValidEmail(rawEmail)) {
        return json({ error: t('invalidEmail') }, 400);
      }

      const postId = Number(body.post_id ?? body.comment_post_ID) || 0;
      const postSlug = normalizeSlug(body.post_slug);
      const parentId = Number(body.parent_id ?? body.comment_parent) || 0;
      if (!postId && !postSlug) return json({ error: t('postRefMissing') }, 400);

      const authorName = sanitize(rawAuthor, maxAuthor);
      const authorEmail = rawEmail.slice(0, maxEmail);
      const content = sanitize(rawComment, maxComment);
      const ip = context.request.headers.get('CF-Connecting-IP') || 'unknown';
      const userAgent = context.request.headers.get('User-Agent') || 'unknown';

      const now = Date.now();
      const submittedAt = new Date(now).toISOString();
      const oneHourAgo = new Date(now - 3_600_000).toISOString();
      const windowStart = new Date(now - dedupeWindow).toISOString();

      // Double-submit: report success without storing a second copy, so the
      // visitor is not told their comment failed when it did not. Checked
      // before the hourly limit, so a retry of the comment that used the last
      // of the allowance is that success too, not a 429.
      const isDuplicate = async () => {
        const hit = await context.env.DB
          .prepare(
            'SELECT COUNT(*) as count FROM comments ' +
            'WHERE author_email = ? AND content = ? AND submitted_at > ?'
          )
          .bind(authorEmail, content, windowStart)
          .first<{ count: number }>();
        return Boolean(hit && hit.count > 0);
      };
      if (await isDuplicate()) return json({ success: true, message: t('success') });

      // The limit and the duplicate rule are conditions of the INSERT itself,
      // one statement D1 decides atomically — as a separate COUNT, a burst
      // from one IP all read the same count and every post was stored (see
      // contact.ts).
      const inserted = await context.env.DB
        .prepare(
          'INSERT INTO comments (post_id, post_slug, parent_id, author_name, author_email, ' +
          'content, submitted_at, ip, user_agent, status) ' +
          'SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? ' +
          'WHERE (SELECT COUNT(*) FROM comments WHERE ip = ? AND submitted_at > ?) < ? ' +
          'AND NOT EXISTS (SELECT 1 FROM comments WHERE author_email = ? AND content = ? AND submitted_at > ?)'
        )
        .bind(postId, postSlug, parentId, authorName, authorEmail, content,
              submittedAt, ip, userAgent, 'pending',
              ip, oneHourAgo, limit,
              authorEmail, content, windowStart)
        .run();

      if (!inserted.meta?.changes) {
        // Nothing stored: the allowance is spent, or the twin of a
        // double-click landed first — only the second is a success.
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
            if (!outcome.woken) console.warn(`[comment] WordPress was not woken: ${outcome.reason}`);
          })
        );
      }

      if (options.onStored) {
        const stored = { authorName, authorEmail, content, postSlug };
        context.waitUntil(
          (async () => options.onStored!(stored, withReplayableBody(context, read.raw)))().catch((err) =>
            console.error('[comment] onStored failed:', err)
          )
        );
      }

      return json({ success: true, message: t('success') });
    } catch (error) {
      console.error('[comment] failed:', error);
      return json({ error: t('genericError') }, 500);
    }
  };
}
