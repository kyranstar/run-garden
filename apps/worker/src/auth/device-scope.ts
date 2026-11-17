/**
 * WHAT A DEVICE TOKEN MAY REACH, BY ITS OWN SCOPE, deny by default (SLICE-CONTRACT revision 2 §10.3; stage 2 DESIGN §5.1):
 *
 *  - `training-slice-v1`: the smallest workout — the phone's reads, Build `{}`, Start and the save. Kept exactly as it was.
 *  - `training-v2` (stage 2a, "Moves in run-garden too"): v1's own entries, and run-garden's move, skip and unskip of a
 *    planned session and the watch drain — the web's routes, guard and services, each validating as it does for the web.
 *
 * Exact (method, anchored pattern) pairs, matched against `c.req.path` (the same decoded path the router matches) and
 * `c.req.method`, for every method: HEAD is its own method here and is on no pair, so a device's HEAD is refused like any
 * other off-list request. `requireUser`'s device branch checks the device's OWN scope's list before the restore rule
 * (423), and anything off it is 403 `out_of_scope`. A pair may also hold a body rule: the request's body is read (Hono
 * keeps it, so the handler reads the same bytes) and refused 403 `out_of_scope` when it asks for more than the scope
 * allows.
 *
 * A new pairing is minted at the newest scope. A device keeps the scope it was paired at: there is no in-place upgrade
 * (device management is the laptop's, and a pairing is the owner's consent to what it allows), so a v1 phone pairs again.
 * Later stages get new scopes, never a widened one. `native-allowlist.test.ts` holds every route the app mounts against
 * each scope's list, every method, so a new route fails that test until it is classified.
 */
import type { Context } from "hono";
import { isLocalDate } from "@rg/domain";

export const DEVICE_SCOPE_V1 = "training-slice-v1";
export const DEVICE_SCOPE_V2 = "training-v2";
export type DeviceScope = typeof DEVICE_SCOPE_V1 | typeof DEVICE_SCOPE_V2;

/** The scope a new pairing is minted at. */
export const NEWEST_DEVICE_SCOPE: DeviceScope = DEVICE_SCOPE_V2;

/** True when the body, as raw text, is within the scope. */
type BodyRule = (raw: string) => boolean;

export interface DeviceRoute {
  method: "GET" | "POST" | "PUT";
  pattern: RegExp;
  /** Answers true when the body is in scope. */
  body?: BodyRule;
}

const parsed = (raw: string): { ok: true; value: unknown } | { ok: false } => {
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false };
  }
};

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Build from the phone is the day's build as it stands: exactly `{}` — no checks, overrides or swaps. */
export const emptyObjectBody: BodyRule = (raw) => {
  const p = parsed(raw);
  return p.ok && isPlainObject(p.value) && Object.keys(p.value).length === 0;
};

/**
 * A save from the phone is the app's own session with nothing of a plan edit in it (§9.6, §10.5): `review.graduations`
 * (a graduation switches a block's lift) and `review.excluded` ("not for me", an `exercise_prefs` write) absent or
 * empty, and `source` absent or the app's own ("app"; a watch review or an import is not the phone's). The phone strips
 * those two fields before it queues, so a refusal here is a bug path. A body that is not a JSON object is left to the
 * route, which answers 422 `invalid_save` as it does for the web.
 */
export const deviceSaveBody: BodyRule = (raw) => {
  const p = parsed(raw);
  if (!p.ok || !isPlainObject(p.value)) return true;
  const body = p.value;
  if ("source" in body && body.source !== "app") return false;
  if (body.review === undefined) return true;
  if (!isPlainObject(body.review)) return false;
  const { graduations, excluded } = body.review;
  if (graduations !== undefined && !(Array.isArray(graduations) && graduations.length === 0)) return false;
  if (excluded !== undefined && !(isPlainObject(excluded) && Object.keys(excluded).length === 0)) return false;
  return true;
};

/** Skip, unskip and the drain from the phone carry nothing: no body, or `{}` (the routes read none). */
export const emptyBody: BodyRule = (raw) => raw.trim() === "" || emptyObjectBody(raw);

/** A time the phone moves a session to: a clock time, `HH:MM`. */
const CLOCK_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
/** A time as the device's reads give one (`/api/native/today`, the plan read): `HH:MM`, else the row has none (null). */
const READ_TIME = /^\d{2}:\d{2}$/;

/** Whether `o` has every one of `required`, and nothing outside `required` and `optional`. */
const keysAre = (o: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean =>
  required.every((k) => Object.hasOwn(o, k)) && Object.keys(o).every((k) => required.includes(k) || optional.includes(k));

/**
 * A move from the phone is exactly `{toDate, toTime, from?}` (stage 2 DESIGN §5.3): a real local date, a clock time
 * (R2-2: a move always sets one), and, when sent, `from: {date, time}` — where the phone last saw the session, its time as
 * the reads gave it (`HH:MM`, or null for none). Nothing else: no key the route might read later, for the web, slips
 * through a device. The route's own schema then validates again, as it does for the web.
 */
export const deviceMoveBody: BodyRule = (raw) => {
  const p = parsed(raw);
  if (!p.ok || !isPlainObject(p.value) || !keysAre(p.value, ["toDate", "toTime"], ["from"])) return false;
  const { toDate, toTime, from } = p.value;
  if (typeof toDate !== "string" || !isLocalDate(toDate) || typeof toTime !== "string" || !CLOCK_TIME.test(toTime)) return false;
  if (!Object.hasOwn(p.value, "from")) return true;
  if (!isPlainObject(from) || !keysAre(from, ["date", "time"])) return false;
  return typeof from.date === "string" && isLocalDate(from.date) && (from.time === null || (typeof from.time === "string" && READ_TIME.test(from.time)));
};

/** One path segment, as Hono's `:param` matches one. */
const SEG = "[^/]+";

/** The slice, exactly (SLICE-CONTRACT §10.3). */
const TRAINING_SLICE_V1: readonly DeviceRoute[] = [
  { method: "GET", pattern: /^\/api\/native\/me$/ },
  { method: "GET", pattern: /^\/api\/native\/today$/ },
  { method: "POST", pattern: /^\/api\/native\/sign-out$/ },
  { method: "GET", pattern: new RegExp(`^/api/sessions/${SEG}$`) },
  { method: "GET", pattern: new RegExp(`^/api/sessions/${SEG}/review-basis$`) },
  { method: "POST", pattern: new RegExp(`^/api/sessions/${SEG}/build$`), body: emptyObjectBody },
  { method: "POST", pattern: new RegExp(`^/api/sessions/${SEG}/start$`) },
  { method: "PUT", pattern: new RegExp(`^/api/sessions/performed/${SEG}$`), body: deviceSaveBody },
];

/**
 * Stage 2a (DESIGN §9): v1's own entries, then a linked workout moved, skipped or put back on run-garden's plan, and the
 * watch drain a move or skip hands back (`watchDrain`; 404 while the watch switch is off, as for the web).
 */
const TRAINING_V2: readonly DeviceRoute[] = [
  ...TRAINING_SLICE_V1,
  { method: "POST", pattern: new RegExp(`^/api/plan/workouts/${SEG}/move$`), body: deviceMoveBody },
  { method: "POST", pattern: new RegExp(`^/api/plan/workouts/${SEG}/skip$`), body: emptyBody },
  { method: "POST", pattern: new RegExp(`^/api/plan/workouts/${SEG}/unskip$`), body: emptyBody },
  { method: "POST", pattern: /^\/api\/sessions\/watch\/drain$/, body: emptyBody },
];

/** Each scope's list. Nothing else answers a device of that scope. */
export const DEVICE_SCOPES: Readonly<Record<DeviceScope, readonly DeviceRoute[]>> = {
  [DEVICE_SCOPE_V1]: TRAINING_SLICE_V1,
  [DEVICE_SCOPE_V2]: TRAINING_V2,
};

/** Whether a device row's scope is one this Worker knows (any other is refused 403 `out_of_scope`). */
export const isDeviceScope = (scope: string): scope is DeviceScope => Object.hasOwn(DEVICE_SCOPES, scope);

/** The pair of `scope`'s list this request is, or undefined (off the list). */
export function deviceRouteOf(scope: DeviceScope, method: string, path: string): DeviceRoute | undefined {
  return DEVICE_SCOPES[scope].find((r) => r.method === method && r.pattern.test(path));
}

/** Whether this request is in the device's scope: on its list, and its body within the pair's rule. */
export async function inDeviceScope(c: Context, scope: DeviceScope): Promise<boolean> {
  const route = deviceRouteOf(scope, c.req.method, c.req.path);
  if (!route) return false;
  if (!route.body) return true;
  return route.body(await c.req.text());
}
