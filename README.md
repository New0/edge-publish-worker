# The edge side of your WordPress site

This repository is the half of an Edge Publish site that runs on Cloudflare. It
serves your pages from the data centre nearest each visitor, and it keeps the
parts of WordPress that cannot be a file — forms, comments, search — working as
small functions beside them.

WordPress stays where it is. It stops being the thing your visitors' browsers
talk to, and goes on being the place you write.

## Deploy it

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/New0/edge-publish-worker)

The button clones this repository into your own account, creates the KV
namespaces and the database it needs, asks you for the secrets below, and
deploys. You end up with an address like
`https://edge-publish-site.YOUR-SUBDOMAIN.workers.dev`.

> **Not yet exercised end to end.** The application here is tested and
> compiles. The button flow — provisioning, the secret prompts, the first
> migration — has not been run by us against a real account. If something in it
> surprises you, that is worth telling us about rather than working around.

## What it asks for

| | What to put |
|---|---|
| `SYNC_SECRET` | A long random string. The same value goes into the plugin. It is what proves a publish came from your WordPress. |
| `WP_BASIC_AUTH` | Only if your WordPress is sealed with HTTP Basic Auth at the web server. Base64 of `user:password`. Leave empty otherwise — the recommended guard, the edge-origin-guard mu-plugin, admits this deployment by its `SYNC_SECRET` signature. |
| `TURNSTILE_SECRET_KEY` | Only if your forms — or your customer sign-in form — use a Turnstile widget. Leave empty and Turnstile is off. |
| `MAIL_FROM`, `BREVO_API_KEY` | Only if your customers sign in and you want the edge to send their sign-in link through your Brevo account (`Site name <noreply@your-domain>`, on a domain Brevo has verified). Leave empty and WordPress sends it. |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Only if you sell. A restricted key (Products, Prices, Checkout Sessions, Customer portal, Customers: write) and the webhook's signing secret. Empty means this site sells nothing, and says so rather than failing. If your customers have accounts, save Stripe's customer portal settings once in its dashboard, or "Manage billing" says it is unavailable. |

Then edit these values in `wrangler.jsonc` and push, or change them in the
Cloudflare dashboard:

- `ALLOWED_ORIGIN` — the public address of your site.
- `WP_SOURCE` — where WordPress lives now, usually a subdomain.
- `ACCOUNT_PATH` — only if your customers' account page is not `/account/`
  (a French site might use `/compte/`). It must match the path your build
  publishes the page at.
- `STRIPE_PORTAL_CONFIGURATION` — only if one Stripe account sells for
  several sites: the customer portal configuration (`bpc_…`) this one opens.

Leave `SIGNATURE_MIN_VERSION` at `"2"`: it refuses a request signed the old
way, which does not say which address it was meant for. Every Edge Publish
release since 2026-09-29 signs the new way.

## Then, in WordPress

1. Install **Edge Publish**.
2. Settings → paste this deployment's address as the endpoint, and the same
   `SYNC_SECRET`.
3. **Test connection.** It names the failure if there is one — unreachable,
   wrong secret, or a record type this deployment does not know.
4. **Resync the whole site.** Pages start arriving.

## What is in here

| | |
|---|---|
| `src/index.ts` | three lines: the Worker, built from the shared runtime and your config |
| `src/site-config.ts` | **yours to edit** — record types, rate limits |
| `src/worker-entry.ts`, `src/api/`, `src/lib/`, `src/_middleware.ts` | the shared runtime. Replaced wholesale on an update; editing it means merging by hand later |
| `migrations/` | the database: submissions and comments, customer accounts and their sign-in links and sessions, the Stripe price, product and order caches, and the nonces that stop a signed request being replayed |
| `public/` | the static site. One placeholder page until your first sync |

## Updating the runtime

This repository was generated from the EdgeWPsync engine 3.0.0 on 2026-10-28.

Regenerating replaces the runtime — `src/worker-entry.ts`, `src/api/`,
`src/lib/`, `src/_middleware.ts` and `src/index.ts` — and leaves everything
that is yours: `src/site-config.ts`, `wrangler.jsonc`, `public/`,
`package.json` and this file. Existing migrations are never rewritten, because
a migration that has already run is history; a schema change arrives as a new
numbered file.

## Licence

MIT. This repository contains the shared Workers runtime, which is MIT — the
**plugin** is GPL-2.0-or-later, as anything running inside WordPress must be.
They are two pieces of software with two licences, and this is the MIT one.
