-- The D1 schema every converted site needs.
--
-- One file, read by `edgewpsync provision` and copied verbatim into the edge
-- template a stranger deploys, because the alternative is what was here before:
-- a schema written from memory in `service-provisioner.mjs` that named the
-- column `ip_address` while every endpoint inserts into `ip`, and had no
-- `synced` column at all — so a site provisioned by the CLI failed on the first
-- form submission and on every sync, and nothing said so until a real
-- submission was lost.
--
-- This is the schema the two production sites have been running. Columns here
-- are the ones `functions/api/*.ts` reads and writes; `src/tests/
-- service-provisioner.test.mjs` checks that claim against their SQL rather
-- than trusting this comment.

CREATE TABLE IF NOT EXISTS contact_submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  message TEXT NOT NULL,
  submitted_at TEXT DEFAULT (datetime('now')),
  ip TEXT,
  user_agent TEXT,
  -- The drain reads `synced = 0` and sets it to 1. Without this column the
  -- rows arrive and nothing ever collects them.
  synced INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER,
  -- Comments are fetched by slug: the static page knows its own path, not the
  -- post id it was rendered from.
  post_slug TEXT,
  parent_id INTEGER DEFAULT 0,
  author_name TEXT NOT NULL,
  author_email TEXT NOT NULL,
  content TEXT NOT NULL,
  submitted_at TEXT DEFAULT (datetime('now')),
  ip TEXT,
  user_agent TEXT,
  status TEXT DEFAULT 'pending',
  synced INTEGER DEFAULT 0
);

-- The sync drain's query shape.
CREATE INDEX IF NOT EXISTS idx_contact_synced ON contact_submissions(synced, submitted_at);
CREATE INDEX IF NOT EXISTS idx_comments_synced ON comments(synced, submitted_at);

-- Rate limiting counts by IP within a window.
CREATE INDEX IF NOT EXISTS idx_contact_ip ON contact_submissions(ip, submitted_at);
CREATE INDEX IF NOT EXISTS idx_comments_ip ON comments(ip, submitted_at);

-- Reading a page's approved comments.
CREATE INDEX IF NOT EXISTS idx_comments_slug_status ON comments(post_slug, status);

-- Refusing a double-clicked duplicate.
CREATE INDEX IF NOT EXISTS idx_comments_dedup ON comments(author_email, submitted_at);
