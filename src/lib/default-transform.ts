/**
 * The HTML transform a site gets when it has not written one.
 *
 * `update-page` takes the transform as an argument rather than owning one,
 * because the two sites running this today are 3% identical in that file — two
 * different answers to the same problem, not one file that drifted. That
 * decision assumed a site repo with a developer in it. A stranger deploying the
 * edge from a button has neither, and `update-page` cannot be called without a
 * transform, so without this there is nothing for them to deploy.
 *
 * **It is deliberately the honest minimum.** Full fidelity — form conversion,
 * search, structured-data rewriting, the standards pass — is the conversion
 * pipeline, and the conversion pipeline is Node. This does the two things that
 * are wrong on *every* page if nobody does them: it removes the origin, and it
 * removes the links that point at machinery a static copy does not have.
 *
 * ## The rules came from real pages, twice
 *
 * The same list exists in PHP in the plugin's static export
 * (`class-export.php`). That is not duplication anyone chose: one runs inside
 * WordPress on a folder of files, the other inside a Worker on one page at a
 * time, and neither runtime can call the other. What is shared is the *reason*
 * for each rule, and each was learned the same way — by running a rewrite over
 * a real page and finding what broke.
 *
 * The head links are the case worth knowing. A suite written alongside a
 * rewrite was green while four links per page were dead, because the fixtures
 * carried no RSS feed, no comments feed, no REST index and no
 * `type="application/json"` alternate — every one of them WordPress telling a
 * client where to find something a folder of files does not serve.
 */

import { stripSearchActions } from './jsonld.js';

/** Where the page came from, and where it is going to live. */
export interface DefaultTransformOptions {
  /** The public address of the static site, e.g. `https://example.com`. */
  siteUrl: string;
  /** The WordPress origin the page was fetched from, e.g. `https://ia.example.com`. */
  wpOrigin: string;
}

/**
 * `rel` values naming something a static site does not serve.
 *
 * Matched by `rel` because WordPress spells these consistently. The REST links
 * are matched by destination instead — see below.
 */
const DEAD_RELS = [
  'alternate', // only when it points at a feed or the REST record; checked below
  'pingback',
  'EditURI',
  'wlwmanifest',
  'shortlink',
];

/** Feeds, by the type WordPress declares on them. */
const FEED_TYPES = /type=["'](application\/(rss\+xml|atom\+xml|json)|text\/xml)["']/i;

/** Anything pointing into the REST API or XML-RPC, whatever it calls itself. */
const DEAD_HREFS = /href=["'][^"']*(\/wp-json\/|xmlrpc\.php)[^"']*["']/i;

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const trimSlash = (value: string): string => value.replace(/\/+$/, '');

/**
 * Remove one `<link>` element per rule, by inspecting the whole tag.
 *
 * Tag-at-a-time rather than one clever expression: the rules disagree about
 * what identifies a dead link — some by `rel`, feeds by `type`, the REST links
 * by where they point — and a single pattern trying to express all three is how
 * a rule that strips the stylesheet passes every test that was written for the
 * feeds.
 */
function stripDeadLinks(html: string): string {
  return html.replace(/<link\b[^>]*>/gi, (tag) => {
    const rel = /rel=["']([^"']+)["']/i.exec(tag)?.[1]?.toLowerCase() ?? '';

    // Never touch what makes the page render or rank.
    if (/^(stylesheet|preload|preconnect|dns-prefetch|icon|apple-touch-icon|canonical|manifest|next|prev|author|profile)$/.test(rel)) {
      return tag;
    }

    if (DEAD_HREFS.test(tag)) return '';

    if (rel === 'alternate') {
      // An alternate is a feed, a REST record, or an hreflang. Only the first
      // two are dead; dropping hreflang would break a multilingual site's
      // relationships between its own pages.
      return FEED_TYPES.test(tag) ? '' : tag;
    }

    return DEAD_RELS.includes(rel) || rel === 'edituri' ? '' : tag;
  });
}

/**
 * Drop the oEmbed discovery links and the emoji loader.
 *
 * oEmbed links point into `/wp-json/` and are the one place the origin appears
 * percent-encoded inside a query parameter — a spelling that is not a path and
 * cannot become one, so they are removed rather than rewritten.
 *
 * The emoji loader is a script WordPress prints on every page to replace emoji
 * with images on browsers that have not needed it in a decade. It costs a
 * request on a site that no longer has WordPress behind it.
 */
function stripWordPressArtefacts(html: string): string {
  return html
    .replace(/<link[^>]+rel=["']alternate["'][^>]+type=["']application\/json\+oembed["'][^>]*>/gi, '')
    .replace(/<link[^>]+type=["']text\/xml\+oembed["'][^>]*>/gi, '')
    /*
     * One <script> element at a time, then judged. This was a single
     * expression, `<script[^>]*>[\s\S]*?window\._wpemojiSettings…</script>`,
     * whose lazy middle starts at the *first* script on the page and runs to
     * the emoji one. That was harmless while WordPress printed the emoji
     * loader first in <head>. Current WordPress prints it last, in the footer,
     * as a JSON `wp-emoji-settings` block plus a module — so the expression
     * matched from the import map in <head> to the end of the body, and every
     * pushed page lost `<main>` and everything in it. Found 2026-09-19 by the
     * asset-version pair test, on a page captured from WordPress 7.1.
     */
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, (element) =>
      /id=["']wp-emoji-settings["']|_wpemojiSettings|wp-emoji-(?:release|loader)/.test(element) ? '' : element)
    .replace(/<style[^>]*>\s*img\.wp-smiley[\s\S]*?<\/style>/gi, '');
}

/**
 * What may follow the origin's host for it to be the origin and not a longer
 * name that starts the same way: not another host character, not a dot that
 * begins another label, not a port. `ia.example.com.evil.test`,
 * `ia.example.community` and `ia.example.com:8443` are other hosts; the
 * origin followed by `/`, `\/`, `%2F`, a quote or a sentence's full stop is
 * the origin.
 *
 * There was no bound until 2026-09-26: the pattern was the bare origin, so
 * `https://ia.example.com.evil.test/` became `https://example.com.evil.test/`.
 */
const HOST_END = '(?![A-Za-z0-9_-]|\\.[A-Za-z0-9_-]|:\\d|%3[Aa]\\d)';

/** A pattern for percent-encoded text, with the escapes' hex matched in either case. */
const percentPattern = (encoded: string): string =>
  escapeRegExp(encoded).replace(/%([0-9A-F])([0-9A-F])/g, (_all, a: string, b: string) =>
    `%${/[A-F]/.test(a) ? `[${a}${a.toLowerCase()}]` : a}${/[A-F]/.test(b) ? `[${b}${b.toLowerCase()}]` : b}`);

/**
 * Replace the origin, in every spelling it occurs in.
 *
 * Plain, and JSON-escaped inside structured data — which is how Yoast and Rank
 * Math write their `@graph`. The escaped form is the one that has shipped to
 * production twice with the origin still in it, because a page can look
 * completely clean while its JSON-LD still names the private host.
 *
 * Three more since 2026-09-26, found by a read-only SEO review of the live
 * edges, each in all three of those forms:
 *
 *  - **percent-encoded** — `https%3A%2F%2Fia.example.com`, as share links
 *    and oEmbed parameters carry it. Percent escapes are case-insensitive, so
 *    `%3a%2f%2f` is the same text. The engine's site-transform helper
 *    (`replaceOrigin` in src/transforms/builtin.mjs) already handled it;
 *  - **the other scheme** — `http://` when the origin is `https://`, and the
 *    reverse. Old content written before a site moved to TLS keeps the old
 *    scheme in every link it has; it names the same host;
 *  - **protocol-relative** — `//ia.example.com`, which becomes the site's
 *    address without a scheme, so it stays protocol-relative.
 *
 * One expression, one pass, each match replaced in kind so the surrounding
 * syntax stays valid. One pass matters: separate passes re-read their own
 * output, and where the site's address continues the origin's
 * (`https://example.com` → `https://example.com/blog`) a second pass would
 * rewrite what the first had written.
 */
export function rewriteOrigin(html: string, wpOrigin: string, siteUrl: string): string {
  const from = trimSlash(wpOrigin);
  const to = trimSlash(siteUrl);
  if (!from || from === to) return html;

  // The origin without its scheme: `ia.example.com`, or `example.com/wp` for a
  // WordPress in a subdirectory.
  const rest = from.replace(/^(?:https?:)?\/\//i, '');
  // The site without its scheme, for a protocol-relative match. A site URL
  // with none (empty, for site-relative output) is the same either way.
  const bare = /^https?:\/\//i.test(to) ? to.replace(/^https?:/i, '') : to;

  const pattern = new RegExp(
    `(?:((https?:)?//${escapeRegExp(rest)})` +
    `|((https?:)?\\\\/\\\\/${escapeRegExp(rest.replace(/\//g, '\\/'))})` +
    `|((https?%3[Aa])?%2[Ff]%2[Ff]${percentPattern(encodeURIComponent(rest))}))` +
    HOST_END,
    'g'
  );

  return html.replace(pattern, (_all: string, plain?: string, plainScheme?: string, escaped?: string, escapedScheme?: string, _encoded?: string, encodedScheme?: string) => {
    if (plain !== undefined) return plainScheme ? to : bare;
    if (escaped !== undefined) return (escapedScheme ? to : bare).replace(/\//g, '\\/');
    return encodeURIComponent(encodedScheme ? to : bare);
  });
}

/**
 * Build the transform `update-page` expects.
 *
 * Returns the HTML as a string; the caller decides what to do with it. It never
 * throws on odd input: a page that cannot be improved is returned as it
 * arrived, because a sync that fails closed on one strange page stops a whole
 * site updating.
 *
 * **Declines anything that is not HTML** — returns `null`, which `update-page`
 * records as neither delivered nor failed. The publisher pushes the feed and
 * the sitemap with every publish, and the default middleware labels every
 * cached entry `text/html`. Storing an RSS feed or an XML sitemap here would
 * serve correct bytes under the wrong type: exactly what one site's feed did
 * until 2026-09-21, found by reconcile, and what a core `/wp-sitemap.xml`
 * would have done the moment the publisher stopped assuming `/sitemap.xml`.
 * A site that does want those cached — and serves them with their own type —
 * brings its own transform.
 *
 * A reply with no Content-Type is treated as HTML: WordPress always sends one,
 * so its absence is an oddity to pass through, not a reason to drop a page.
 */
export function createDefaultTransform(options: DefaultTransformOptions) {
  return async (response: Response, spec: { path: string; sourceOrigin: string }): Promise<string | null> => {
    const type = response.headers.get('Content-Type') || '';
    if (type && !/text\/html/i.test(type)) return null;

    const html = await response.text();

    // The origin the page actually came from wins over configuration: a page
    // fetched from somewhere else is a page whose links point somewhere else.
    const origin = spec.sourceOrigin || options.wpOrigin;

    return rewriteOrigin(stripSearchActions(stripWordPressArtefacts(stripDeadLinks(html))), origin, options.siteUrl);
  };
}

/** Exported for tests, and for a site that wants one rule without the others. */
export const __rules = { stripDeadLinks, stripWordPressArtefacts, rewriteOrigin, stripSearchActions };
