/**
 * Waking WordPress to bring in what the edge has just stored.
 *
 * A submission or a comment stored at the edge reaches WordPress when the
 * plugin drains it — and it is WordPress that then mails the owner, with its
 * own wp_mail(), so a site needs no paid mail service for that mail. The drain
 * used to run hourly on WP-Cron, which on an origin behind an edge the host's
 * crontab fires, at most once a minute. So the edge wakes WordPress itself,
 * right after storing, with a signed request to the plugin's `/wake` route.
 *
 * The plugin decides (Drain::wake): it drains now if the owner's interval —
 * 15 seconds to an hour — has passed since the last drain, or answers with
 * how long until it has. A wait of up to EDGE_WAIT seconds this request covers
 * itself: it waits, and wakes once more. A longer one the plugin has booked on
 * WP-Cron. So a 15-second interval holds without any cron at all.
 *
 * Called inside `waitUntil`, after the visitor has their answer, and never
 * throws: a WordPress that is down costs a submission nothing — it is stored,
 * and the scheduled drain brings it in later.
 */

import { fetchFromWordPress, type WpFetchEnv } from './wp-fetch.js';

export const WAKE_ROUTE = '/wp-json/edge-publish/v1/wake';

/** The longest this request waits before waking again — Drain::EDGE_WAIT in the plugin. */
export const EDGE_WAIT = 20;

export type WakeOutcome =
  | { woken: true; drained: boolean; imported?: number; dueIn?: number; retried: boolean }
  | { woken: false; reason: string };

export interface WakeOptions {
  /** Waiting, injectable so a test does not wait. */
  sleep?: (ms: number) => Promise<void>;
}

interface WakeAnswer {
  drained?: boolean;
  imported?: number;
  dueIn?: number;
}

/** Can this site wake its WordPress at all? */
export function canWake(env: WpFetchEnv): boolean {
  return Boolean(env.WP_SOURCE && env.SYNC_SECRET);
}

async function ask(env: WpFetchEnv): Promise<{ ok: true; answer: WakeAnswer } | { ok: false; reason: string }> {
  const url = `${String(env.WP_SOURCE).replace(/\/+$/, '')}${WAKE_ROUTE}`;
  const response = await fetchFromWordPress(url, env, {
    method: 'POST',
    body: JSON.stringify({ action: 'wake' }),
    headers: { 'Content-Type': 'application/json' },
  });
  if (!response.ok) return { ok: false, reason: `HTTP ${response.status}` };
  return { ok: true, answer: (await response.json()) as WakeAnswer };
}

/** Wake WordPress; wait and wake once more when it asks for up to EDGE_WAIT seconds. Never throws. */
export async function wakeWordPress(env: WpFetchEnv, options: WakeOptions = {}): Promise<WakeOutcome> {
  if (!canWake(env)) return { woken: false, reason: 'not-configured' };
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  try {
    const first = await ask(env);
    if (!first.ok) return { woken: false, reason: first.reason };
    let answer = first.answer;
    let retried = false;
    const dueIn = Number(answer.dueIn);
    if (!answer.drained && dueIn > 0 && dueIn <= EDGE_WAIT) {
      await sleep(dueIn * 1000 + 250);
      const second = await ask(env);
      if (second.ok) {
        answer = second.answer;
        retried = true;
      }
    }
    return {
      woken: true,
      drained: Boolean(answer.drained),
      ...(typeof answer.imported === 'number' ? { imported: answer.imported } : {}),
      ...(typeof answer.dueIn === 'number' ? { dueIn: answer.dueIn } : {}),
      retried,
    };
  } catch (error) {
    return { woken: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
