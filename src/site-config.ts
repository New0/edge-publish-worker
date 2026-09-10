/**
 * The one file in this repository you are expected to edit.
 *
 * Everything here has a working default, so a deployment nobody has touched
 * answers correctly. Change something when your site needs it to.
 */

import type { SiteConfig } from './worker-entry.js';

export const siteConfig: SiteConfig = {
  // Which record types WordPress may drain, and from which table. These two
  // match the tables in migrations/. Adding a form type means adding a table
  // and naming it here.
  sync: {
    types: {
      contact: { table: 'contact_submissions', timestampColumn: 'submitted_at' },
      comment: { table: 'comments', timestampColumn: 'submitted_at' },
    },
  },

  // Submissions allowed per IP per hour, before the endpoint starts refusing.
  contact: { rateLimit: 5 },

  // Comments are rate limited separately, and identical comments within the
  // window are treated as a double-click rather than as two comments.
  comment: { rateLimit: 5 },
};
