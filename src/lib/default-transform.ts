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
    .replace(/<script[^>]*>[\s\S]*?window\._wpemojiSettings[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>\s*img\.wp-smiley[\s\S]*?<\/style>/gi, '');
}

/**
 * Replace the origin, in both spellings it occurs in.
 *
 * Plain, and JSON-escaped inside structured data — which is how Yoast and Rank
 * Math write their `@graph`. The escaped form is the one that has shipped to
 * production twice with the origin still in it, because a page can look
 * completely clean while its JSON-LD still names the private host.
 */
function rewriteOrigin(html: string, wpOrigin: string, siteUrl: string): string {
  const from = trimSlash(wpOrigin);
  const to = trimSlash(siteUrl);
  if (!from || from === to) return html;

  const plain = new RegExp(escapeRegExp(from), 'g');
  const escaped = new RegExp(escapeRegExp(from.replace(/\//g, '\\/')), 'g');

  return html.replace(plain, to).replace(escaped, to.replace(/\//g, '\\/'));
}

/**
 * Build the transform `update-page` expects.
 *
 * Returns the HTML as a string; the caller decides what to do with it. It never
 * throws on odd input: a page that cannot be improved is returned as it
 * arrived, because a sync that fails closed on one strange page stops a whole
 * site updating.
 */
export function createDefaultTransform(options: DefaultTransformOptions) {
  return async (response: Response, spec: { path: string; sourceOrigin: string }): Promise<string> => {
    const html = await response.text();

    // The origin the page actually came from wins over configuration: a page
    // fetched from somewhere else is a page whose links point somewhere else.
    const origin = spec.sourceOrigin || options.wpOrigin;

    return rewriteOrigin(stripWordPressArtefacts(stripDeadLinks(html)), origin, options.siteUrl);
  };
}

/** Exported for tests, and for a site that wants one rule without the others. */
export const __rules = { stripDeadLinks, stripWordPressArtefacts, rewriteOrigin };
