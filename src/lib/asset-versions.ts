/**
 * Content-versioned asset URLs, on the edge.
 *
 * The same rule as `src/core/asset-versions.mjs`, which is where the reasons
 * are written down; read that file first. Two copies because the build is
 * Node `.mjs` and this is a Worker, and neither can import the other — the
 * same arrangement as `jsonld.ts`. `src/tests/asset-versions-parity.test.mjs`
 * runs one set of cases through both and fails on any difference: a page a
 * publish writes and a page a build writes must link the same URLs.
 *
 * What only the edge needs is at the bottom: reading the build's
 * `ews-assets.json` out of the site's own static files.
 */

export const VERSIONED_EXTENSIONS = /\.(css|js|mjs|woff2?|ttf|otf|eot|png|jpe?g|gif|webp|avif|svg|ico)$/i;

export const ASSET_MANIFEST = 'ews-assets.json';

export type VersionLookup = (assetPath: string) => string | null;

const URL_PATTERN = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;

const IMPORT_STRING_PATTERN = /(@import\s+)(['"])([^'"]+)\2/g;

const attrPattern = (name: string): RegExp => new RegExp(`(\\s${name}\\s*=\\s*)(["'])([^"']*)\\2`, 'i');

const trimSlash = (value: string): string => String(value || '').replace(/\/+$/, '');

export function resolveAssetPath(ref: string, fromPath: string, origins: string[] = []): string | null {
  const raw = String(ref || '').trim();
  if (!raw || raw.startsWith('#') || /^(data|about|blob|mailto|tel|javascript):/i.test(raw)) return null;

  let local = raw;
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('//')) {
    const match = origins
      .map(trimSlash)
      .filter(Boolean)
      .find((origin) => {
        const candidate = raw.startsWith('//') ? origin.replace(/^[a-z][a-z0-9+.-]*:/i, '') : origin;
        const rest = raw.slice(candidate.length);
        return raw.toLowerCase().startsWith(candidate.toLowerCase()) && (rest === '' || /^[/?#]/.test(rest));
      });
    if (!match) return null;
    const prefix = raw.startsWith('//') ? match.replace(/^[a-z][a-z0-9+.-]*:/i, '') : match;
    local = raw.slice(prefix.length) || '/';
  }

  const clean = local.split('#')[0].split('?')[0];
  if (!clean) return null;

  const base = String(fromPath || '/');
  const segments = clean.startsWith('/')
    ? clean.split('/')
    : `${base.slice(0, base.lastIndexOf('/'))}/${clean}`.split('/');

  const out: string[] = [];
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') { out.pop(); continue; }
    out.push(segment);
  }
  const resolved = `/${out.join('/')}`;
  try {
    return decodeURIComponent(resolved);
  } catch {
    return null;
  }
}

export function withVersion(ref: string, version: string): string {
  const raw = String(ref);
  const hashAt = raw.indexOf('#');
  const fragment = hashAt === -1 ? '' : raw.slice(hashAt);
  const beforeFragment = hashAt === -1 ? raw : raw.slice(0, hashAt);
  const queryAt = beforeFragment.indexOf('?');
  const bare = queryAt === -1 ? beforeFragment : beforeFragment.slice(0, queryAt);
  return `${bare}?v=${version}${fragment}`;
}

function versionRef(ref: string, fromPath: string, lookup: VersionLookup, origins: string[]): string {
  const assetPath = resolveAssetPath(ref, fromPath, origins);
  if (!assetPath || !VERSIONED_EXTENSIONS.test(assetPath)) return ref;
  const version = lookup(assetPath);
  return version ? withVersion(ref, version) : ref;
}

export function versionCss(css: string, fromPath: string, lookup: VersionLookup, origins: string[] = []): string {
  return String(css)
    .replace(URL_PATTERN, (whole, quote: string, ref: string) => {
      const next = versionRef(ref, fromPath, lookup, origins);
      return next === ref ? whole : `url(${quote}${next}${quote})`;
    })
    .replace(IMPORT_STRING_PATTERN, (whole, lead: string, quote: string, ref: string) => {
      const next = versionRef(ref, fromPath, lookup, origins);
      return next === ref ? whole : `${lead}${quote}${next}${quote}`;
    });
}

const decodeAmpersands = (value: string): string => value.replace(/&(?:amp|#0*38|#x0*26);/gi, '&');

function versionAttribute(tag: string, name: string, pagePath: string, lookup: VersionLookup, origins: string[]): string {
  const pattern = attrPattern(name);
  const match = pattern.exec(tag);
  if (!match) return tag;
  const [, lead, quote, value] = match;
  const ref = decodeAmpersands(value);
  const next = versionRef(ref, pagePath, lookup, origins);
  if (next === ref) return tag;
  return tag.replace(pattern, () => `${lead}${quote}${next.replace(/&/g, '&amp;')}${quote}`);
}

function versionImportMap(json: string, pagePath: string, lookup: VersionLookup, origins: string[]): string {
  return json.replace(/(:\s*)"((?:[^"\\]|\\.)*)"/g, (whole, colon: string, inner: string) => {
    const escaped = inner.includes('\\/');
    const ref = escaped ? inner.replace(/\\\//g, '/') : inner;
    const next = versionRef(ref, pagePath, lookup, origins);
    if (next === ref) return whole;
    return `${colon}"${escaped ? next.replace(/\//g, '\\/') : next}"`;
  });
}

export function versionHtml(
  html: string,
  { pagePath = '/', lookup, origins = [] }: { pagePath?: string; lookup: VersionLookup; origins?: string[] }
): string {
  return String(html)
    .replace(/(<script\b[^>]*type=["']importmap["'][^>]*>)([\s\S]*?)(<\/script>)/gi, (whole, open: string, json: string, close: string) => {
      const next = versionImportMap(json, pagePath, lookup, origins);
      return next === json ? whole : `${open}${next}${close}`;
    })
    .replace(/<link\b[^>]*>/gi, (tag) => versionAttribute(tag, 'href', pagePath, lookup, origins))
    .replace(/<script\b[^>]*>/gi, (tag) => versionAttribute(tag, 'src', pagePath, lookup, origins))
    .replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, (whole, open: string, css: string, close: string) => {
      const next = versionCss(css, pagePath, lookup, origins);
      return next === css ? whole : `${open}${next}${close}`;
    });
}

/** What a version is. Anything else in a manifest is refused, not written into a page. */
const VERSION_SHAPE = /^[0-9a-f]{10}$/;

/**
 * Read an `ews-assets.json`, or say why it cannot be used. Never throws: the
 * caller reports "not versioned, and why" rather than failing the page. Only
 * the edge reads a manifest; the build writes one.
 */
export function parseAssetManifest(text: string): { lookup: VersionLookup; size: number } | { error: string } {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { error: 'not JSON' };
  }
  const record = data as { v?: unknown; assets?: unknown } | null;
  if (!record || record.v !== 1 || typeof record.assets !== 'object' || record.assets === null) {
    return { error: 'not a version 1 asset manifest' };
  }
  const assets = record.assets as Record<string, unknown>;
  // A manifest ships with the deployment, so this is hygiene rather than a
  // defence: a value that is not a version would otherwise land in an
  // attribute as it is — `?v=[object Object]`, or a quote.
  if (!Object.values(assets).every((value) => typeof value === 'string' && VERSION_SHAPE.test(value))) {
    return { error: 'a version in the manifest is not ten hex characters' };
  }
  return {
    lookup: (assetPath) => (Object.prototype.hasOwnProperty.call(assets, assetPath) ? (assets[assetPath] as string) : null),
    size: Object.keys(assets).length,
  };
}

// ── Edge only ──────────────────────────────────────────────────────────────

/**
 * What happened to asset versions on a push, reported in the response.
 *
 * `absent` is the normal answer for a site that has not opted in: its build
 * wrote no manifest. `unreadable` is the one that matters — a site that opted
 * in and whose pushed pages are going out unversioned — and it says why,
 * because the sync contract allows the fast path to be wrong but never
 * silently.
 */
export type AssetVersionStatus =
  | { state: 'applied'; assets: number }
  | { state: 'absent' }
  | { state: 'unreadable'; reason: string };

/**
 * Read the build's manifest from the site's own static files.
 *
 * Through the `ASSETS` binding, not over the network: the manifest is part of
 * the deployment that is serving this request, so it always matches the files
 * that deployment holds. Never throws.
 */
export async function loadAssetVersions(
  assets: { fetch: (request: Request) => Promise<Response> } | undefined,
  requestUrl: string
): Promise<{ lookup: VersionLookup | null; status: AssetVersionStatus }> {
  if (!assets) return { lookup: null, status: { state: 'absent' } };
  try {
    const response = await assets.fetch(new Request(new URL(`/${ASSET_MANIFEST}`, requestUrl).toString()));
    if (response.status === 404) return { lookup: null, status: { state: 'absent' } };
    if (!response.ok) return { lookup: null, status: { state: 'unreadable', reason: `HTTP ${response.status}` } };
    // A Pages project with no 404.html answers a missing file with its home
    // page and a 200. That is "no manifest", not a broken one.
    if (!/json/i.test(response.headers.get('Content-Type') ?? '')) {
      return { lookup: null, status: { state: 'absent' } };
    }
    const parsed = parseAssetManifest(await response.text());
    if ('error' in parsed) return { lookup: null, status: { state: 'unreadable', reason: parsed.error } };
    return { lookup: parsed.lookup, status: { state: 'applied', assets: parsed.size } };
  } catch (error) {
    return {
      lookup: null,
      status: { state: 'unreadable', reason: error instanceof Error ? error.message : 'fetch failed' },
    };
  }
}
