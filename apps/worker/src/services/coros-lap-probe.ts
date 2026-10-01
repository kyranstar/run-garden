import { addDays, sportIdForCorosCode, todayInZone, type UserPreferences } from "@rg/domain";
import { CorosApiError } from "@rg/coros";
import type { RawCorosActivityDetail } from "@rg/providers";
import { fixtureModeEnabled, type Env } from "../env.js";
import type { Db } from "./db.js";
import { corosClient } from "./coros-connection.js";
import { isRuntimeLimit } from "./runtime-limit.js";

/**
 * THE MASKED LAP PROBE (Task 15): what does COROS actually put in a strength
 * activity's laps? The normalizer keeps `exerciseNameKey` and nothing
 * strength-specific, so reps and load are either on the wire and dropped, or
 * not on the wire at all — and only the athlete's real activities can say.
 *
 * It runs on real personal data, so it returns SHAPE ONLY: every key, its type,
 * and array lengths. Not one value — not a number, not a string, not a name.
 * Keys pass only when they look like a field name (camelCase, at most two
 * digits — `maskKey`); everything else, data used as a key included, is
 * masked. A heuristic: a short lowercase word used as a key would still pass.
 * Array lengths are reported, so counts (reps, sets) are visible by design.
 */

export type KeySkeleton = { [key: string]: KeySkeletonNode };
export type KeySkeletonNode = string | KeySkeleton;

/** Past this depth an object is reported as "object" and not descended. */
const MAX_DEPTH = 6;
/** How many of the most recent strength activities are probed. */
export const MAX_PROBED = 5;
/** Accepted window, days back from today (inclusive). */
export const MAX_WINDOW_DAYS = 180;

const MASKED_KEY = "(masked key)";
/** Set on a merged object when some elements were not objects. */
const TYPE_KEY = "(type)";

/** A COROS field name: camelCase, short, few digits (Audit 2 E2E M6 — an
 * allowlist; the old denylist passed names, emails, coordinates and ids). */
const FIELD_NAME = /^[a-z][A-Za-z0-9]{0,40}$/;

function maskKey(key: string): string {
  return FIELD_NAME.test(key) && (key.match(/\d/g)?.length ?? 0) <= 2 ? key : MASKED_KEY;
}

/** Accumulators without a prototype: a key named `constructor` or
 * `toString` is just a key (Audit 2 E2E M7). */
function skeletonObject(...from: KeySkeleton[]): KeySkeleton {
  return Object.assign(Object.create(null) as KeySkeleton, ...from);
}

function typeLabel(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `array(${value.length})`;
  return typeof value;
}

/**
 * Union of two type strings ("number" | "string" → "number|string"). Several
 * array lengths collapse to a range, so a union never grows with the data.
 */
function unionTypes(a: string, b: string): string {
  const parts = new Set([...a.split("|"), ...b.split("|")]);
  const lengths: number[] = [];
  const rest: string[] = [];
  for (const p of parts) {
    const m = /^array\((\d+)(?:\.\.(\d+))?\)$/.exec(p);
    if (m) {
      lengths.push(Number(m[1]));
      if (m[2] !== undefined) lengths.push(Number(m[2]));
    } else {
      rest.push(p);
    }
  }
  if (lengths.length > 0) {
    const lo = Math.min(...lengths);
    const hi = Math.max(...lengths);
    rest.push(lo === hi ? `array(${lo})` : `array(${lo}..${hi})`);
  }
  return rest.sort().join("|");
}

function mergeNodes(a: KeySkeletonNode | undefined, b: KeySkeletonNode): KeySkeletonNode {
  if (a === undefined) return b;
  if (typeof a === "string" && typeof b === "string") return unionTypes(a, b);
  if (typeof a === "object" && typeof b === "object") {
    const out = skeletonObject(a);
    for (const [k, v] of Object.entries(b)) out[k] = mergeNodes(out[k], v);
    return out;
  }
  // One side an object, the other a plain type: keep the object's keys and
  // record that the slot is sometimes something else.
  const obj = (typeof a === "object" ? a : b) as KeySkeleton;
  const other = (typeof a === "string" ? a : b) as string;
  const prior = typeof obj[TYPE_KEY] === "string" ? (obj[TYPE_KEY] as string) : "object";
  return skeletonObject(obj, { [TYPE_KEY]: unionTypes(prior, other) });
}

function nodeOf(value: unknown, depth: number): KeySkeletonNode {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return typeLabel(value);
  if (depth >= MAX_DEPTH) return "object";
  const out = skeletonObject();
  for (const [rawKey, v] of Object.entries(value as Record<string, unknown>)) {
    const key = maskKey(rawKey);
    out[key] = mergeNodes(out[key], nodeOf(v, depth + 1));
    if (Array.isArray(v) && v.length > 0) {
      // The elements' shape, merged into one — a sibling "<key>[]" entry, so
      // every value in the skeleton stays either a type string or an object.
      let merged: KeySkeletonNode | undefined;
      for (const el of v) merged = mergeNodes(merged, nodeOf(el, depth + 1));
      out[`${key}[]`] = mergeNodes(out[`${key}[]`], merged!);
    }
  }
  return out;
}

/**
 * `{ key: typeof value | "array(n)" | nested skeleton }`, recursively. Array
 * elements are merged into one skeleton under `"<key>[]"`. No value survives.
 */
export function keySkeleton(value: unknown): KeySkeletonNode {
  return nodeOf(value, 0);
}

/** One level only: each top-level key and what kind of thing it holds. */
function shallowKeys(value: Record<string, unknown>): Record<string, string> {
  const out = Object.create(null) as Record<string, string>;
  for (const [rawKey, v] of Object.entries(value)) {
    const label = v !== null && typeof v === "object" && !Array.isArray(v) ? "object" : typeLabel(v);
    const key = maskKey(rawKey);
    out[key] = out[key] ? unionTypes(out[key]!, label) : label;
  }
  return out;
}

export type LapProbeResult =
  | { status: "fixture_mode" }
  | { status: "not_connected" }
  | { status: "coros_error"; code?: string }
  /** Our own subrequest/CPU ceiling — never COROS's failure (runtime-limit.ts). */
  | { status: "runtime_limit" }
  /** The probe's own code failed on what COROS sent. */
  | { status: "probe_error" }
  | {
      status: "ok";
      body: {
        windowDays: number;
        /** Strength activities in the window (the probe reads at most MAX_PROBED). */
        strengthActivities: number;
        probed: number;
        /** Newest first. */
        activities: Array<
          | { detailKeys: Record<string, string>; skeleton: KeySkeletonNode }
          | { error: "detail_failed"; code?: string }
        >;
      };
    };

export async function probeStrengthLapKeys(
  db: Db,
  env: Env,
  userId: string,
  prefs: UserPreferences,
  days: number,
  fetchImpl: typeof fetch = fetch,
): Promise<LapProbeResult> {
  // Fixture mode never talks to real providers (repo-wide convention).
  if (fixtureModeEnabled(env)) return { status: "fixture_mode" };
  const client = await corosClient(db, env, userId, fetchImpl);
  if (!client) return { status: "not_connected" };

  const today = todayInZone(prefs.timezone);
  try {
    const items = await client.getActivities(addDays(today, -days), today);
    const strength = items
      .filter((item) => sportIdForCorosCode(item.sportType) === "strength")
      .sort((a, b) => (b.startTime ?? 0) - (a.startTime ?? 0) || b.date - a.date);
    const activities: Extract<LapProbeResult, { status: "ok" }>["body"]["activities"] = [];
    for (const item of strength.slice(0, MAX_PROBED)) {
      let detail: RawCorosActivityDetail;
      try {
        // The same detail call corosReadNow's snapshot makes.
        detail = await client.getActivityDetail(item.labelId, item.sportType);
      } catch (e) {
        if (isRuntimeLimit(e)) throw e; // the whole run hit our ceiling, not this detail
        activities.push({
          error: "detail_failed",
          ...(e instanceof CorosApiError && e.resultCode ? { code: e.resultCode } : {}),
        });
        continue;
      }
      try {
        activities.push({
          detailKeys: shallowKeys(detail as Record<string, unknown>),
          skeleton: keySkeleton({ summary: detail.summary, lapList: detail.lapList }),
        });
      } catch {
        return { status: "probe_error" };
      }
    }
    return {
      status: "ok",
      body: {
        windowDays: days,
        strengthActivities: strength.length,
        probed: activities.length,
        activities,
      },
    };
  } catch (e) {
    if (isRuntimeLimit(e)) return { status: "runtime_limit" };
    // Result code only — a CorosApiError message never carries account data,
    // but nothing but the code is needed.
    return { status: "coros_error", ...(e instanceof CorosApiError && e.resultCode ? { code: e.resultCode } : {}) };
  }
}
