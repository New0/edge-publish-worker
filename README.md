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

## The three things it asks for

| | What to put |
|---|---|
| `SYNC_SECRET` | A long random string. The same value goes into the plugin. It is what proves a publish came from your WordPress. |
| `WP_BASIC_AUTH` | Only if your WordPress is behind HTTP Basic Auth. Base64 of `user:password`. Leave empty otherwise. |
| `TURNSTILE_SECRET_KEY` | Only if your forms use a Turnstile widget. Leave empty and Turnstile is off. |

Then edit two values in `wrangler.jsonc` and push, or change them in the
Cloudflare dashboard:

- `ALLOWED_ORIGIN` — the public address of your site.
- `WP_SOURCE` — where WordPress lives now, usually a subdomain.

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
| `migrations/` | the database tables submissions and comments land in |
| `public/` | the static site. One placeholder page until your first sync |

## Updating the runtime

This repository was generated from Edge Publish 2.1.0 on 2026-09-10.

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
