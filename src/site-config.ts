/**
 * The one file in this repository you are expected to edit.
 *
 * Everything here has a working default, so a deployment nobody has touched
 * answers correctly. Change something when your site needs it to.
 */

import type { SiteConfig } from './worker-entry.js';

export const siteConfig: SiteConfig = {
  // Which record types WordPress may drain, and from which table. These four
  // match tables in migrations/. `form` holds every plugin's forms —
  // Contact Form 7, WPForms, Gravity and the rest — as one JSON record per
  // submission, so a new form needs no new table. A bespoke record type does:
  // add the table, then name it here.
  sync: {
    types: {
      contact: { table: 'contact_submissions', timestampColumn: 'submitted_at' },
      comment: { table: 'comments', timestampColumn: 'submitted_at' },
      form: { table: 'form_submissions', timestampColumn: 'submitted_at' },
      // Customer accounts, for a site that has them (docs/EDGE-ACCOUNTS.md):
      // what each account did, drained into WordPress as edge_customer users.
      // Its timestamps are Unix seconds, not ISO text: compared as text, every
      // integer sorts before every date, so the drain's `since` found none of
      // them and the cleanup took all of them.
      account: { table: 'ews_account_events', timestampColumn: 'created_at', timestampType: 'unix' },
    },
  },

  // Submissions allowed per IP per hour, before the endpoint starts refusing.
  contact: { rateLimit: 5 },

  // The same for /api/form, counted once across every form on the site.
  form: { rateLimit: 5 },

  // Comments are rate limited separately, and identical comments within the
  // window are treated as a double-click rather than as two comments.
  comment: { rateLimit: 5 },
};
