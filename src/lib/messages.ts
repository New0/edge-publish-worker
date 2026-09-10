/**
 * User-facing strings for the shared form endpoints.
 *
 * The endpoints are engine-owned; the words are not. Copy is branding — tone,
 * language, and legal phrasing all belong to the site. So an endpoint never
 * embeds a string, it asks for one.
 *
 * The site implementation this generalises inlined its own `t()` and a
 * hardcoded sender address, which is exactly what made the file unshareable.
 */

/** Message keys every form endpoint may need. */
export type MessageKey =
  | 'success'
  | 'fieldsRequired'
  | 'invalidEmail'
  | 'antispamFailed'
  | 'rateLimited'
  | 'genericError'
  | 'postRefMissing'
  | 'slugRequired';

/**
 * Resolve a key (optionally interpolating values) to display text.
 * A site supplies this; the engine only calls it.
 */
export type MessageResolver = (key: MessageKey, vars?: Record<string, string>) => string;

/**
 * A resolver, or a function that produces one from the request.
 *
 * The second form exists because a multilingual site picks its language
 * per request — from a body field, a path prefix, or Accept-Language — and a
 * resolver fixed at construction cannot express that. The gap surfaced on the
 * first site migrated, which serves three languages.
 */
export type MessageSource =
  | MessageResolver
  | ((request: Request, body: unknown) => MessageResolver);

/** Normalize either form to a resolver for one request. */
export function resolveMessages(
  source: MessageSource | undefined,
  request: Request,
  body: unknown
): MessageResolver {
  if (!source) return createMessages();
  return isFactory(source)
    ? (source as (r: Request, b: unknown) => MessageResolver)(request, body)
    : (source as MessageResolver);
}

/**
 * A factory is marked explicitly rather than sniffed: a resolver also accepts
 * two arguments (key, vars), so arity alone cannot tell them apart.
 */
const FACTORY = Symbol.for('edgewpsync.messageFactory');

export function messageFactory(
  fn: (request: Request, body: unknown) => MessageResolver
): MessageSource {
  (fn as unknown as Record<symbol, boolean>)[FACTORY] = true;
  return fn as MessageSource;
}

function isFactory(fn: unknown): boolean {
  return Boolean((fn as Record<symbol, boolean>)[FACTORY]);
}

/** Neutral English fallbacks, so an endpoint is usable before a site writes copy. */
const DEFAULTS: Record<MessageKey, string> = {
  success: 'Thank you — your message has been received.',
  fieldsRequired: 'Please fill in all required fields.',
  invalidEmail: 'Please enter a valid email address.',
  antispamFailed: 'Anti-spam verification failed. Please try again.',
  rateLimited: 'Too many submissions. Please try again later.',
  genericError: 'Something went wrong. Please try again.',
  postRefMissing: 'Could not determine which post this refers to.',
  slugRequired: 'A post reference is required.',
};

/**
 * Build a resolver from a partial override map. Missing keys fall back to the
 * neutral defaults rather than rendering an empty string or the key itself —
 * a blank error message is worse than a generic one.
 */
export function createMessages(overrides: Partial<Record<MessageKey, string>> = {}): MessageResolver {
  return (key, vars) => {
    let text = overrides[key] ?? DEFAULTS[key] ?? key;
    if (vars) {
      for (const [name, value] of Object.entries(vars)) {
        text = text.replaceAll(`{${name}}`, value);
      }
    }
    return text;
  };
}
