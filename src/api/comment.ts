/**
 * Blog comments — shared Pages Function.
 *
 * GET  returns approved comments for a post.
 * POST accepts a submission and stores it pending moderation.
 *
 * Factory-shaped for the same reason as contact: copy, limits and notification
 * behaviour belong to the site; validation, rate limiting and storage do not.
 */

import { isAllowedOrigin, getResponseOrigin, corsHeaders } from '../lib/cors.js';
import { validateTurnstile } from '../lib/turnstile.js';
import { sanitize, isValidEmail } from '../lib/escape.js';
import { createMessages, resolveMessages, type MessageSource } from '../lib/messages.js';

export interface CommentEnv {
  DB: D1Database;
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
  /** Called after a successful insert — moderation notifications, etc. */
  onStored?: (
    record: { authorName: string; authorEmail: string; content: string; postSlug: string },
    context: EventContext<CommentEnv, string, Record<string, unknown>>
  ) => void | Promise<void>;
}

const DEFAULTS = {
  rateLimit: 5, maxAuthor: 100, maxEmail: 254, maxComment: 3000, dedupeWindowMs: 120_000,
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
export function normalizeSlug(raw: string | null | undefined): string {
  return (raw || '').trim().slice(0, 200).replace(/[^a-zA-Z0-9-]/g, '');
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
      const body = (await context.request.json()) as CommentBody;
      t = resolveMessages(options.messages, context.request, body);

      if (body._hp) return json({ success: true, message: t('success') });

      if (context.env.TURNSTILE_SECRET_KEY) {
        const ok = await validateTurnstile(
          body['cf-turnstile-response'] || '',
          context.env.TURNSTILE_SECRET_KEY,
          context.request.headers.get('CF-Connecting-IP') || undefined
        );
        if (!ok) return json({ error: t('antispamFailed') }, 400);
      }

      if (!body.author?.trim() || !body.email?.trim() || !body.comment?.trim()) {
        return json({ error: t('fieldsRequired'), required: ['author', 'email', 'comment'] }, 400);
      }
      if (!isValidEmail(body.email.trim())) {
        return json({ error: t('invalidEmail') }, 400);
      }

      const postId = Number(body.post_id) || 0;
      const postSlug = normalizeSlug(body.post_slug);
      const parentId = Number(body.parent_id) || 0;
      if (!postId && !postSlug) return json({ error: t('postRefMissing') }, 400);

      const authorName = sanitize(body.author, maxAuthor);
      const authorEmail = body.email.trim().slice(0, maxEmail);
      const content = sanitize(body.comment, maxComment);
      const ip = context.request.headers.get('CF-Connecting-IP') || 'unknown';
      const userAgent = context.request.headers.get('User-Agent') || 'unknown';

      const oneHourAgo = new Date(Date.now() - 3_600_000).toISOString();
      const recent = await context.env.DB
        .prepare('SELECT COUNT(*) as count FROM comments WHERE ip = ? AND submitted_at > ?')
        .bind(ip, oneHourAgo)
        .first<{ count: number }>();
      if (recent && recent.count >= limit) return json({ error: t('rateLimited') }, 429);

      // Double-submit: report success without storing a second copy, so the
      // visitor is not told their comment failed when it did not.
      const windowStart = new Date(Date.now() - dedupeWindow).toISOString();
      const duplicate = await context.env.DB
        .prepare(
          'SELECT COUNT(*) as count FROM comments ' +
          'WHERE author_email = ? AND content = ? AND submitted_at > ?'
        )
        .bind(authorEmail, content, windowStart)
        .first<{ count: number }>();
      if (duplicate && duplicate.count > 0) return json({ success: true, message: t('success') });

      await context.env.DB
        .prepare(
          'INSERT INTO comments (post_id, post_slug, parent_id, author_name, author_email, ' +
          'content, submitted_at, ip, user_agent, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        )
        .bind(postId, postSlug, parentId, authorName, authorEmail, content,
              new Date().toISOString(), ip, userAgent, 'pending')
        .run();

      if (options.onStored) {
        const stored = { authorName, authorEmail, content, postSlug };
        context.waitUntil(
          (async () => options.onStored!(stored, context))().catch((err) =>
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
