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

-- Any form, one JSON record per submission. `functions/api/form.ts` writes it;
-- the plugin drains it as type `form`.
--
-- A column per field is what made every new form cost a schema change, an
-- endpoint and an importer — contact_submissions above is that shape, and it
-- takes exactly one form. Here `fields` holds the form's answers as a JSON
-- array of {name,label,type,value}, in form order, where `value` is a string
-- or an array of strings. The drain returns it as that string, unparsed.
CREATE TABLE IF NOT EXISTS form_submissions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  form_plugin  TEXT NOT NULL,   -- 'contact-form-7' | 'wpforms' | 'gravityforms' | 'fluentform' | 'formidable' | 'ninja-forms' | 'elementor-pro' | 'html'
  form_id      TEXT,            -- the plugin's own form id, when it has one
  form_title   TEXT,
  page         TEXT NOT NULL,   -- site-relative path it was submitted from
  fields       TEXT NOT NULL,   -- JSON array of {name,label,type,value}, in form order
  submitted_at TEXT NOT NULL,   -- ISO 8601 UTC
  ip           TEXT,
  user_agent   TEXT,
  synced       INTEGER NOT NULL DEFAULT 0
);

-- The sync drain's query shape.
CREATE INDEX IF NOT EXISTS idx_contact_synced ON contact_submissions(synced, submitted_at);
CREATE INDEX IF NOT EXISTS idx_comments_synced ON comments(synced, submitted_at);
CREATE INDEX IF NOT EXISTS idx_form_synced ON form_submissions(synced, submitted_at);

-- Rate limiting counts by IP within a window.
CREATE INDEX IF NOT EXISTS idx_contact_ip ON contact_submissions(ip, submitted_at);
CREATE INDEX IF NOT EXISTS idx_comments_ip ON comments(ip, submitted_at);
CREATE INDEX IF NOT EXISTS idx_form_ip ON form_submissions(ip, submitted_at);

-- Reading a page's approved comments.
CREATE INDEX IF NOT EXISTS idx_comments_slug_status ON comments(post_slug, status);

-- Refusing a double-clicked duplicate.
CREATE INDEX IF NOT EXISTS idx_comments_dedup ON comments(author_email, submitted_at);
-- A generic form has no sender to match on, so a repeat is the same page with
-- the same answers; the page narrows it before `fields` is compared.
CREATE INDEX IF NOT EXISTS idx_form_dedup ON form_submissions(page, submitted_at);

-- Nonces, so a signed request cannot be replayed.
--
-- On D1 rather than KV, for the reason the rate limiting already documents: a
-- KV read carries a 60-second minimum cache TTL, so a read-then-write check
-- cannot see its own writes inside the window it is enforcing — which is
-- exactly the window a replay happens in.
--
-- Named `ews_nonces` rather than `nonces` because a site's database is the
-- site's, and a table called `nonces` is a name somebody else will want.
CREATE TABLE IF NOT EXISTS ews_nonces (
  nonce      TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS ews_nonces_expiry ON ews_nonces (expires_at);

-- ─────────────────────────────────────────────────────────────────────────
-- Commerce: WordPress pages, Stripe at the edge (docs/STRIPE-COMMERCE.md).
-- Unused, and harmless, on a site that sells nothing.
-- ─────────────────────────────────────────────────────────────────────────

-- What a page shows for a price: filled from Stripe on first view, refreshed by
-- the webhook and after PRICE_TTL_SECONDS. What a customer is *charged* is
-- never read from here — /api/checkout asks Stripe live.
CREATE TABLE IF NOT EXISTS ews_stripe_prices (
  id           TEXT PRIMARY KEY,
  product_id   TEXT NOT NULL,
  product_name TEXT NOT NULL DEFAULT '',
  unit_amount  INTEGER,
  currency     TEXT NOT NULL,
  interval     TEXT,
  sellable     INTEGER NOT NULL DEFAULT 0,
  fetched_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS ews_stripe_prices_product ON ews_stripe_prices (product_id);

-- What a product-keyed Buy button shows: the product's *default* price, keyed
-- by product id, so a new price (the mirror makes one and archives the old)
-- reaches the page without a republish. Same lifecycle as ews_stripe_prices.
CREATE TABLE IF NOT EXISTS ews_stripe_products (
  product_id   TEXT PRIMARY KEY,
  price_id     TEXT NOT NULL DEFAULT '',
  product_name TEXT NOT NULL DEFAULT '',
  unit_amount  INTEGER,
  currency     TEXT NOT NULL DEFAULT '',
  interval     TEXT,
  sellable     INTEGER NOT NULL DEFAULT 0,
  fetched_at   INTEGER NOT NULL
);

-- ── Customer accounts (docs/EDGE-ACCOUNTS.md) ─────────────────────────────

-- The account itself: permanent, because every sign-in needs it. One row per
-- person, and the least this side can hold and still recognise them.
-- Status and erasure are the owner's to decide, in WordPress, and arrive here
-- as a signed push; everything else the customer writes.
CREATE TABLE IF NOT EXISTS ews_accounts (
  id                 TEXT PRIMARY KEY,
  email              TEXT NOT NULL UNIQUE,
  name               TEXT NOT NULL DEFAULT '',
  -- active | blocked. Blocked cannot sign in and holds no session.
  status             TEXT NOT NULL DEFAULT 'active',
  stripe_customer_id TEXT NOT NULL DEFAULT '',
  -- Filled by the drain, so a later push can name the WordPress user.
  wp_user_id         INTEGER,
  created_at         INTEGER NOT NULL,
  last_seen_at       INTEGER
);

-- What the account did, for WordPress to import: created, profile changed,
-- signed in. A mailbox exactly like form_submissions — drained through
-- /api/sync?type=account, marked synced, purged later — which is why it
-- carries `synced` and its own timestamp column.
CREATE TABLE IF NOT EXISTS ews_account_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  type       TEXT NOT NULL,
  email      TEXT NOT NULL,
  name       TEXT NOT NULL DEFAULT '',
  -- Anything the type needs, as JSON. The importer reads it as a string.
  data       TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  synced     INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS ews_account_events_unsynced ON ews_account_events (synced, created_at);

-- A sign-in link, hashed. The link itself exists only in the visitor's inbox:
-- a database that could hand out a working link would be a password file.
-- Keyed by email rather than by account, because the account is made when the
-- link is followed — otherwise anyone could create accounts, and WordPress
-- users, for addresses that never asked.
CREATE TABLE IF NOT EXISTS ews_login_tokens (
  token_hash TEXT PRIMARY KEY,
  email      TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  -- Single use: set when the link is followed, kept until it expires so a
  -- second click says "already used" rather than "unknown".
  used_at    INTEGER
);

CREATE INDEX IF NOT EXISTS ews_login_tokens_email ON ews_login_tokens (email, created_at);
CREATE INDEX IF NOT EXISTS ews_login_tokens_expiry ON ews_login_tokens (expires_at);

-- Sessions, hashed the same way. Deleted by a block or an erase, which is what
-- makes either take effect at once rather than when a cookie expires.
CREATE TABLE IF NOT EXISTS ews_sessions (
  token_hash   TEXT PRIMARY KEY,
  account_id   TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  last_seen_at INTEGER
);

CREATE INDEX IF NOT EXISTS ews_sessions_account ON ews_sessions (account_id);
CREATE INDEX IF NOT EXISTS ews_sessions_expiry ON ews_sessions (expires_at);

-- Stripe events already handled. Stripe retries until it gets a 2xx and may
-- deliver an event twice; the id is recorded after the work, and every write
-- the work does is an upsert, so a second delivery changes nothing.
CREATE TABLE IF NOT EXISTS ews_stripe_events (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL,
  received_at INTEGER NOT NULL
);

-- Paid checkouts, as facts about money only: no name, email or address.
-- Those stay in Stripe, which is the processor of record.
CREATE TABLE IF NOT EXISTS ews_stripe_orders (
  session_id     TEXT PRIMARY KEY,
  mode           TEXT NOT NULL,
  amount_total   INTEGER NOT NULL,
  currency       TEXT NOT NULL,
  payment_status TEXT NOT NULL,
  created_at     INTEGER NOT NULL
);
