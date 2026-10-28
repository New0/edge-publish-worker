/**
 * Reading a visitor's request body, with a ceiling.
 *
 * Moved here from api/form.ts so contact and comment read their bodies the
 * same way. Until 2026-09-28 they called `request.json()`, which reads any
 * size, and then touched the result as an object with string fields — so
 * `null`, or `{"name": 1}`, was a TypeError: a 500 and an error log for every
 * bot that sent one.
 */

/** A JSON object, as opposed to an array, `null`, or a bare value. */
export const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Read the body, refusing it the moment it passes `max` bytes.
 *
 * Content-Length is checked by the callers first and is not trusted: a
 * chunked request has none, and a client can send a small one and a large
 * body. So the stream is counted as it arrives and abandoned past the cap,
 * rather than buffered whole and measured afterwards.
 */
export async function readCapped(request: Request, max: number): Promise<string | null> {
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export type JsonObjectBody =
  | { ok: true; body: Record<string, unknown>; raw: string }
  | { ok: false; reason: 'too_large' | 'invalid_json' };

/**
 * The body as a JSON object, or why not: `too_large` past `max` bytes
 * (declared or counted), `invalid_json` for anything that does not parse or
 * parses to something other than an object. Never throws for the client's
 * mistakes — those are a 4xx, not an error of ours.
 */
export async function readJsonObject(request: Request, max: number): Promise<JsonObjectBody> {
  // Refused before a byte is read when the client says it is too large.
  const declared = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > max) return { ok: false, reason: 'too_large' };

  const raw = await readCapped(request, max);
  if (raw === null) return { ok: false, reason: 'too_large' };

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'invalid_json' };
  }
  return isPlainObject(body) ? { ok: true, body, raw } : { ok: false, reason: 'invalid_json' };
}

/** A field that must be text: its value when it is a string, '' when it is anything else. */
export const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/**
 * The context an `onStored` hook is handed: the same context, except that its
 * request can be read again.
 *
 * A handler reads the body once, and a stream read once is spent — so a hook
 * that read `context.request` got nothing, and one that called `.clone()` on
 * it threw ("Body is unusable") before it could catch anything. A live
 * site's contact hook did exactly that to find the visitor's language, from
 * 2026-09-02 until 2026-09-28: its owner notification and the visitor's
 * confirmation mail never sent, and the only trace was a logged
 * "onStored failed". The submission itself was stored and drained, so the
 * failure was silent where it mattered.
 *
 * A Proxy rather than a copy: the runtime's context carries methods
 * (`waitUntil`, `next`) that may depend on their receiver, so everything but
 * `request` is read from, and bound to, the real context.
 */
export function withReplayableBody<C extends { request: Request }>(context: C, raw: string): C {
  const original = context.request;
  const request = new Request(original.url, { method: original.method, headers: original.headers, body: raw });
  return new Proxy(context, {
    get(target, prop) {
      if (prop === 'request') return request;
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
