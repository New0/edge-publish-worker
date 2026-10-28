/**
 * What the WordPress plugin may drain, and from which table — in one place.
 *
 * Three things need this list and used to each carry their own copy: the Pages
 * route a deploy writes (`src/deploy/pages-functions.mjs`), the Workers front
 * door (`worker-entry.ts`), and the edge template a site owner creates from a
 * button. A table added to `src/cloudflare/edge-schema.sql` and to two of the
 * three is a table whose rows are written and never fetched — silently, which
 * is how `form` and then `account` were each missing from deployed sites for a
 * while. `src/tests/pages-functions-workspace.test.mjs` now checks this list
 * against the schema, so the schema and the drain cannot drift apart.
 */

/** One drainable record type: which table, which column carries its time, and how that time is stored. */
export interface SyncTypeConfig {
  table: string;
  timestampColumn: string;
  /**
   * How the timestamp column stores time.
   *
   * `iso` — a TEXT ISO 8601 string, which is what the submission tables use.
   * `unix` — an INTEGER of seconds, which is what the account tables use.
   *
   * It matters because the cleanup and the `since` filter compare against it.
   * SQLite happily compares an INTEGER column with the text `2026-08-23T…`,
   * converting the text to the number 2026 — so every row looks newer than the
   * cutoff and nothing is ever purged. No error, no log: just a table that
   * grows for ever. Found in review, 2026-09-22.
   */
  timestampType?: 'iso' | 'unix';
}

/** The types the shared schema creates. A site with its own table adds it to this shape. */
export const DEFAULT_SYNC_TYPES: Record<string, SyncTypeConfig> = {
  contact: { table: 'contact_submissions', timestampColumn: 'submitted_at' },
  comment: { table: 'comments', timestampColumn: 'submitted_at' },
  form: { table: 'form_submissions', timestampColumn: 'submitted_at' },
  // Customer account events (docs/EDGE-ACCOUNTS.md). A site with no accounts
  // has none to drain, so naming it here costs nothing.
  account: { table: 'ews_account_events', timestampColumn: 'created_at', timestampType: 'unix' },
};

/** A cutoff in the form one type's column stores, so a comparison means what it says. */
export function cutoffFor(type: SyncTypeConfig, cutoffMs: number): string | number {
  return type.timestampType === 'unix' ? Math.floor(cutoffMs / 1000) : new Date(cutoffMs).toISOString();
}

/** The same, for a `since` a caller supplies as either spelling. */
export function sinceFor(type: SyncTypeConfig, since: string): string | number | null {
  if (type.timestampType !== 'unix') return since;
  const seconds = /^\d+$/.test(since) ? Number(since) : Math.floor(Date.parse(since) / 1000);
  return Number.isFinite(seconds) ? seconds : null;
}
