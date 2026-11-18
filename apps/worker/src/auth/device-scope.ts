/**
 * WHAT A DEVICE TOKEN MAY REACH, BY ITS OWN SCOPE, deny by default (SLICE-CONTRACT revision 2 §10.3; stage 2 DESIGN §5.1):
 *
 *  - `training-slice-v1`: the smallest workout — the phone's reads, Build `{}`, Start and the save. Kept exactly as it was.
 *  - `training-v2` (stage 2a, "Moves in run-garden too"): v1's own entries, and run-garden's move, skip and unskip of a
 *    planned session and the watch drain — the web's routes, guard and services, each validating as it does for the web.
 *  - `training-v3` (stage 2b, "Fit it to the day"; kit v0.15): v2's entries, Build with the day's choices (the body check,
 *    minutes, place and swaps), the review's own feedback in the save ("not for me" and graduations), and a session's
 *    document read and revised by its revision (`GET`/`PUT /api/workouts/:id/doc`). v1's and v2's entries are untouched:
 *    v3 has its own Build and save body rules, on the same pairs.
 *
 * Exact (method, anchored pattern) pairs, matched against `c.req.path` (the same decoded path the router matches) and
 * `c.req.method`, for every method: HEAD is its own method here and is on no pair, so a device's HEAD is refused like any
 * other off-list request. `requireUser`'s device branch checks the device's OWN scope's list before the restore rule
 * (423), and anything off it is 403 `out_of_scope`. A pair may also hold a body rule: the request's body is read (Hono
 * keeps it, so the handler reads the same bytes) and refused 403 `out_of_scope` when it asks for more than the scope
 * allows — the save's privileged fields among them.
 *
 * THE SCOPE IS THE DEVICE ROW'S, READ ON EVERY REQUEST (kit v0.15): nothing holds it in the token or anywhere else, so a
 * grant takes effect on the device's next request. A new pairing is minted at `PAIRING_SCOPE`; the owner's laptop moves an
 * active device to its next scope in place (`NEXT_DEVICE_SCOPE`, one step a grant, never down: native-devices.ts
 * `grantNextScope`), keeping its token, account, expiry and saves. Later stages get new scopes, never a widened one.
 * `native-allowlist.test.ts` holds every route the app mounts against each scope's list, every method, so a new route
 * fails that test until it is classified.
 */
import type { Context } from "hono";
import { isLocalDate } from "@rg/domain";

export const DEVICE_SCOPE_V1 = "training-slice-v1";
export const DEVICE_SCOPE_V2 = "training-v2";
export const DEVICE_SCOPE_V3 = "training-v3";
export type DeviceScope = typeof DEVICE_SCOPE_V1 | typeof DEVICE_SCOPE_V2 | typeof DEVICE_SCOPE_V3;

/** The newest scope this Worker knows. */
export const NEWEST_DEVICE_SCOPE: DeviceScope = DEVICE_SCOPE_V3;

/**
 * THE SCOPE A NEW PAIRING IS MINTED AT: the newest, v3 (stage 2b RG-NOTES §3.5, §8): one pairing gets everything, and a
 * phone paired again after its 30-day expiry needs no grant each time. The laptop's code says what it allows. It rests on
 * the release precondition: this Worker ships only once the installed LifeOS is at or after `12e86ca8`, which reads
 * scopes as ordered (v3 includes v2), so a fresh v3 pairing on a build without 2b's screens still edits the plan.
 * (LifeOS `7f1388aa` read any scope but exactly `training-v2` as v1.) The laptop's step-down narrows a pairing in place.
 */
export const PAIRING_SCOPE: DeviceScope = NEWEST_DEVICE_SCOPE;

/**
 * The scope the laptop's grant moves a device to from each (kit v0.15): the next named one, one step a grant; null at the
 * top. Never a downgrade, never a skip.
 */
export const NEXT_DEVICE_SCOPE: Readonly<Record<DeviceScope, DeviceScope | null>> = {
  [DEVICE_SCOPE_V1]: DEVICE_SCOPE_V2,
  [DEVICE_SCOPE_V2]: DEVICE_SCOPE_V3,
  [DEVICE_SCOPE_V3]: null,
};

/**
 * The scope the laptop's step-down moves a device back to from each (review r-m4: an undo of a grant, a rollback without
 * a Revoke): the one below, one step at a time; null at the bottom.
 */
export const PREVIOUS_DEVICE_SCOPE: Readonly<Record<DeviceScope, DeviceScope | null>> = {
  [DEVICE_SCOPE_V1]: null,
  [DEVICE_SCOPE_V2]: DEVICE_SCOPE_V1,
  [DEVICE_SCOPE_V3]: DEVICE_SCOPE_V2,
};

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

/** Skip and unskip from the phone carry nothing: no body, or `{}` (the routes read none). */
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

/**
 * The phone's watch drain names the one session it moved: exactly `{workoutId}`, 1–200 characters (kit v0.14). The drain
 * then runs only that session's own queued watch jobs — never another session's push, nor the mirror's sweep. The web's
 * drain, which names none, is the account's, as before.
 */
export const deviceDrainBody: BodyRule = (raw) => {
  const p = parsed(raw);
  if (!p.ok || !isPlainObject(p.value) || !keysAre(p.value, ["workoutId"])) return false;
  const { workoutId } = p.value;
  return typeof workoutId === "string" && workoutId.length >= 1 && workoutId.length <= 200;
};

/** Whether `v` is a non-negative integer (a document revision). */
const isRevision = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;

/**
 * Build from a v3 phone, *Make it fit* (stage 2 DESIGN §4.2; kit v0.15): a JSON object holding only the day's choices the
 * phone offers — `checks` (the body check), `overrides` with only `minutes` and `locationId` (time and place), and `swaps`
 * (a slot's move for one of its own choices). Never `overrides.mode` or `.theme`: the web's sheet offers those, the phone
 * doesn't. The route's own schema then validates every value (422 `invalid_build`), and the engine applies a swap only
 * from the slot's own choices; a document's build reads the checks alone. Start's gate is untouched.
 */
export const deviceBuildBody: BodyRule = (raw) => {
  const p = parsed(raw);
  if (!p.ok || !isPlainObject(p.value) || !keysAre(p.value, [], ["checks", "overrides", "swaps"])) return false;
  const { checks, overrides, swaps } = p.value;
  if (checks !== undefined && !isPlainObject(checks)) return false;
  if (swaps !== undefined && !isPlainObject(swaps)) return false;
  return overrides === undefined || (isPlainObject(overrides) && keysAre(overrides, [], ["minutes", "locationId"]));
};

/**
 * A save from a v3 phone: the app's own session (`source` absent or "app", as v1), now with the review's own choices —
 * `review.graduations` (the athlete's Switch) and `review.excluded` ("not for me") — as the web sends them (kit v0.15).
 * The save applies them exactly once (session-save.ts), and a device's graduation only when the session's own recorded
 * sets earn it. A body that is not a JSON object is left to the route (422 `invalid_save`), as v1's rule does.
 */
export const deviceFeedbackSaveBody: BodyRule = (raw) => {
  const p = parsed(raw);
  if (!p.ok || !isPlainObject(p.value)) return true;
  const body = p.value;
  if ("source" in body && body.source !== "app") return false;
  return body.review === undefined || isPlainObject(body.review);
};

/**
 * A v3 phone's document edit (*Make it fit* for a document workout: swap, remove or place, with run-garden's own editor):
 * exactly `{doc, baseRev}`, the document as an object and the revision it was edited from. The route validates the
 * document for its day, and refuses a stale revision and a session it can't revise, as for the web.
 */
export const deviceDocBody: BodyRule = (raw) => {
  const p = parsed(raw);
  return p.ok && isPlainObject(p.value) && keysAre(p.value, ["doc", "baseRev"]) && isPlainObject(p.value.doc) && isRevision(p.value.baseRev);
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
 * watch drain a move hands back (`watchDrain: true`), bound to the session moved (`deviceDrainBody`; 404 while the watch
 * switch is off, as for the web).
 */
const TRAINING_V2: readonly DeviceRoute[] = [
  ...TRAINING_SLICE_V1,
  { method: "POST", pattern: new RegExp(`^/api/plan/workouts/${SEG}/move$`), body: deviceMoveBody },
  { method: "POST", pattern: new RegExp(`^/api/plan/workouts/${SEG}/skip$`), body: emptyBody },
  { method: "POST", pattern: new RegExp(`^/api/plan/workouts/${SEG}/unskip$`), body: emptyBody },
  { method: "POST", pattern: /^\/api\/sessions\/watch\/drain$/, body: deviceDrainBody },
];

/** v1's Build and save pairs, which v3 keeps with its own body rules. */
const V1_BUILD = TRAINING_SLICE_V1[5]!;
const V1_SAVE = TRAINING_SLICE_V1[7]!;

/**
 * Stage 2b (kit v0.15, "Fit it to the day"): v2's entries in v2's order — Build's and the save's with v3's body rules,
 * the rest the very same entries — then a session's document, read and revised by its revision.
 */
const TRAINING_V3: readonly DeviceRoute[] = [
  ...TRAINING_V2.map((r) => (r === V1_BUILD ? { ...r, body: deviceBuildBody } : r === V1_SAVE ? { ...r, body: deviceFeedbackSaveBody } : r)),
  { method: "GET", pattern: new RegExp(`^/api/workouts/${SEG}/doc$`) },
  { method: "PUT", pattern: new RegExp(`^/api/workouts/${SEG}/doc$`), body: deviceDocBody },
];

/** Each scope's list. Nothing else answers a device of that scope. */
export const DEVICE_SCOPES: Readonly<Record<DeviceScope, readonly DeviceRoute[]>> = {
  [DEVICE_SCOPE_V1]: TRAINING_SLICE_V1,
  [DEVICE_SCOPE_V2]: TRAINING_V2,
  [DEVICE_SCOPE_V3]: TRAINING_V3,
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
