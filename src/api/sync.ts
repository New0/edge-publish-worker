/**
 * D1 → WordPress drain — shared Pages Function.
 *
 * GET  returns unsynced rows of a registered type.
 * POST marks rows synced, or purges old synced rows.
 *
 * Note the direction: this moves *submissions* back to WordPress. It is not
 * the WordPress→edge content sync, which is `update-page` and `update-index`.
 * The two are easy to confuse and do opposite things.
 *
 * Configured, not hardcoded: the two sites this generalises registered
 * different type sets (2 and 5), which is exactly why their versions were only
 * 59% identical. A site supplies its own registry.
 */

import { authenticate } from '../lib/auth.js';
import { corsHeaders, getResponseOrigin } from '../lib/cors.js';

export interface SyncEnv {
  DB: D1Database;
  SYNC_SECRET: string;
  ALLOWED_ORIGIN: string;
  PAGES_PROJECT?: string;
}

/** One drainable record type: which table, and which column carries its timestamp. */
export interface SyncTypeConfig {
  table: string;
  timestampColumn: string;
}

export interface SyncOptions {
  /** e.g. `{ contact: { table: 'contact_submissions', timestampColumn: 'submitted_at' } }` */
  types: Record<string, SyncTypeConfig>;
  /** Max rows returned per GET. */
  pageSize?: number;
  /** Max ids accepted per mark-synced POST. */
  maxIds?: number;
}

const DEFAULTS = { pageSize: 500, maxIds: 500 };

/**
 * SQL identifiers cannot be bound as parameters, so table and column names are
 * interpolated. In the site versions those came from a closed literal map and
 * were safe by construction. Here they come from site configuration, so they
 * are validated before use — a config typo should fail loudly, and a config
 * value must never be able to carry SQL.
 */
export function isSafeIdentifier(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && name.length <= 64;
}

/** Validate a registry once, at construction, rather than per request. */
export function assertValidTypes(types: Record<string, SyncTypeConfig>): void {
  for (const [key, cfg] of Object.entries(types)) {
    if (!isSafeIdentifier(cfg.table)) {
      throw new Error(`sync: type "${key}" has an unsafe table name: ${cfg.table}`);
    }
    if (!isSafeIdentifier(cfg.timestampColumn)) {
      throw new Error(`sync: type "${key}" has an unsafe timestamp column: ${cfg.timestampColumn}`);
    }
  }
}

export function createSyncOptionsHandler(): PagesFunction<SyncEnv> {
  return async (context) => {
    const origin = getResponseOrigin(
      context.request, context.env.ALLOWED_ORIGIN, context.env.PAGES_PROJECT
    );
    return new Response(null, { headers: corsHeaders(origin, 'GET, POST, OPTIONS') });
  };
}

export function createSyncGetHandler(options: SyncOptions): PagesFunction<SyncEnv> {
  assertValidTypes(options.types);
  const pageSize = options.pageSize ?? DEFAULTS.pageSize;
  const valid = Object.keys(options.types);

  return async (context) => {
    const origin = getResponseOrigin(
      context.request, context.env.ALLOWED_ORIGIN, context.env.PAGES_PROJECT
    );
    const headers = {
      ...corsHeaders(origin, 'GET, POST, OPTIONS'), 'Content-Type': 'application/json',
    };
    const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers });

    if (!(await authenticate(context.request, context.env.SYNC_SECRET))) {
      return json({ error: 'Unauthorized' }, 401);
    }

    const url = new URL(context.request.url);
    const type = url.searchParams.get('type');
    const since = url.searchParams.get('since');
    const countOnly = '1' === url.searchParams.get('count');

    if (!type || !valid.includes(type)) {
      return json({ error: `Invalid type. Must be one of: ${valid.join(', ')}` }, 400);
    }

    const { table, timestampColumn: ts } = options.types[type];

    try {
      /*
       * `?count=1` answers "how many are waiting" without shipping the rows.
       *
       * The plugin's dashboard shows a pending count per type on every load.
       * Without this it has to fetch a full page of rows and take its length —
       * up to `pageSize` submissions, with their message bodies, per type, per
       * screen load, only to throw them away. It also means an operator can see
       * the backlog without personal data leaving D1 at all.
       *
       * The count is exact rather than capped at `pageSize`, which is the whole
       * point: a real backlog is precisely the case the paged read cannot
       * report, because there the length it returns *is* the page size.
       */
      if (countOnly) {
        const stmt = since
          ? context.env.DB.prepare(
              `SELECT COUNT(*) AS n FROM ${table} WHERE synced = 0 AND ${ts} > ?`
            ).bind(since)
          : context.env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE synced = 0`);
        const row = await stmt.first<{ n: number }>();
        return json({ type, count: row?.n ?? 0, exact: true });
      }

      const stmt = since
        ? context.env.DB.prepare(
            `SELECT * FROM ${table} WHERE synced = 0 AND ${ts} > ? ORDER BY ${ts} ASC LIMIT ${pageSize}`
          ).bind(since)
        : context.env.DB.prepare(
            `SELECT * FROM ${table} WHERE synced = 0 ORDER BY ${ts} ASC LIMIT ${pageSize}`
          );
      const results = await stmt.all();
      return json({ type, count: results.results?.length || 0, rows: results.results || [] });
    } catch (error) {
      console.error('[sync] query failed:', error);
      return json({ error: 'Sync query failed' }, 500);
    }
  };
}

export function createSyncPostHandler(options: SyncOptions): PagesFunction<SyncEnv> {
  assertValidTypes(options.types);
  const maxIds = options.maxIds ?? DEFAULTS.maxIds;
  const valid = Object.keys(options.types);

  return async (context) => {
    const origin = getResponseOrigin(
      context.request, context.env.ALLOWED_ORIGIN, context.env.PAGES_PROJECT
    );
    const headers = {
      ...corsHeaders(origin, 'GET, POST, OPTIONS'), 'Content-Type': 'application/json',
    };
    const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers });

    if (!(await authenticate(context.request, context.env.SYNC_SECRET))) {
      return json({ error: 'Unauthorized' }, 401);
    }

    try {
      const body = (await context.request.json()) as {
        action?: string; type?: string; ids?: number[]; max_age_days?: number;
      };

      if (body.action === 'cleanup') {
        // Clamped: a caller must not be able to purge everything by passing 0,
        // nor keep rows forever by passing a huge value.
        const maxAgeDays = Math.max(1, Math.min(body.max_age_days || 30, 365));
        const cutoff = new Date(Date.now() - maxAgeDays * 86_400_000).toISOString();
        let deleted = 0;
        for (const key of valid) {
          const { table, timestampColumn: ts } = options.types[key];
          const result = await context.env.DB
            .prepare(`DELETE FROM ${table} WHERE synced = 1 AND ${ts} < ?`)
            .bind(cutoff)
            .run();
          deleted += result.meta.changes || 0;
        }
        return json({ success: true, action: 'cleanup', deleted, cutoff_date: cutoff });
      }

      const { type, ids } = body;
      if (!type || !valid.includes(type)) {
        return json({ error: `Invalid type. Must be one of: ${valid.join(', ')}` }, 400);
      }
      if (!Array.isArray(ids) || ids.length === 0) {
        return json({ error: 'ids array required' }, 400);
      }
      if (ids.length > maxIds) {
        return json({ error: `Maximum ${maxIds} ids per request` }, 400);
      }
      if (!ids.every((id) => typeof id === 'number' && Number.isInteger(id))) {
        return json({ error: 'All ids must be integers' }, 400);
      }

      const { table } = options.types[type];
      const placeholders = ids.map(() => '?').join(',');
      await context.env.DB
        .prepare(`UPDATE ${table} SET synced = 1 WHERE id IN (${placeholders})`)
        .bind(...ids)
        .run();

      return json({ success: true, type, marked_synced: ids.length });
    } catch (error) {
      console.error('[sync] update failed:', error);
      return json({ error: 'Sync update failed' }, 500);
    }
  };
}
