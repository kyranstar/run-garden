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
 *  - `training-v4` (stage 2c, *Coming up* and *History*; kit v0.16, DESIGN-2c §3): v3's fourteen entries, the very same, and
 *    three READS of the plan and the record — `GET /api/native/days`, `GET /api/native/history` and
 *    `GET /api/native/sessions/:id/ahead` — none of which writes anything. Reads only, but a new class of data (90 days of
 *    the plan, a year of the training record) to a phone that could be lost, so it is its own named consent.
 *  - `training-v5` (R1: the library, the coach on the phone; kit v0.20, DESIGN-3 §3.5): v4's seventeen entries, the very
 *    same, then the saved workouts and the moves read trimmed (`GET /api/native/templates`, `/library`), a saved workout
 *    put on the plan with a take-back receipt (`POST /api/native/templates/:id/place`), the receipt-bound take-back
 *    (`POST /api/native/take-back`, `GET /api/native/receipts/:id`), switch A's flag (`GET`/`PUT /api/native/sharing`, off
 *    until the owner turns it on, on the phone), and the coach designer's own routes — runs, the conversation, proposals
 *    approved only by their ops and version, the watch drain, what it remembers, its nudges and the week's spend. Every
 *    training write is run-garden's own route and rules; nothing writes the plan but an approve naming its ops.
 *
 * Exact (method, anchored pattern) pairs, matched against `c.req.path` (the same decoded path the router matches) and
 * `c.req.method`, for every method: HEAD is its own method here and is on no pair, so a device's HEAD is refused like any
 * other off-list request. `requireUser`'s device branch checks the device's OWN scope's list before the restore rule
 * (423), and anything off it is 403 `out_of_scope`. A pair may also hold a body rule: the request's body is read (Hono
 * keeps it, so the handler reads the same bytes) and refused 403 `out_of_scope` when it asks for more than the scope
 * allows — the save's privileged fields among them. And a pair may hold a QUERY RULE (v4's three only; DESIGN-2c §2.5):
 * the request's query, as its decoded parameters, checked after the path and before the body, refused 403 `out_of_scope`
 * when it isn't the rule's shape. The gate checks only the shape; the route checks the values (real dates, the bounds) with
 * 400. A pair without a query rule — every pair of v1–v3 — never has its query looked at, exactly as before.
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
export const DEVICE_SCOPE_V4 = "training-v4";
export const DEVICE_SCOPE_V5 = "training-v5";
export type DeviceScope = typeof DEVICE_SCOPE_V1 | typeof DEVICE_SCOPE_V2 | typeof DEVICE_SCOPE_V3 | typeof DEVICE_SCOPE_V4 | typeof DEVICE_SCOPE_V5;

/** The newest scope this Worker knows. */
export const NEWEST_DEVICE_SCOPE: DeviceScope = DEVICE_SCOPE_V5;

/**
 * THE SCOPE A NEW PAIRING IS MINTED AT: the newest, v5 (stage 2b RG-NOTES §3.5, §8; DESIGN-2c §3; DESIGN-3 §3.5): one
 * pairing gets everything, and a phone paired again after its 30-day expiry needs no grant each time. The laptop's code
 * says what it allows. It rests on the release precondition: this Worker ships only once the installed LifeOS is at or
 * after `12e86ca8`, which reads scopes as ordered levels (`training-v<N>` is level N: v5 includes v4, v4 includes v3), so a
 * fresh v5 pairing on a build without 3a's screens keeps every v2–v4 ability and simply never asks the new routes. (LifeOS
 * `7f1388aa` read any scope but exactly `training-v2` as v1.) The laptop's step-down narrows a pairing in place. A v5
 * pairing shares nothing of the phone's day: switch A starts off (`GET /api/native/sharing`).
 */
export const PAIRING_SCOPE: DeviceScope = NEWEST_DEVICE_SCOPE;

/**
 * The scope the laptop's grant moves a device to from each (kit v0.15): the next named one, one step a grant; null at the
 * top. Never a downgrade, never a skip.
 */
export const NEXT_DEVICE_SCOPE: Readonly<Record<DeviceScope, DeviceScope | null>> = {
  [DEVICE_SCOPE_V1]: DEVICE_SCOPE_V2,
  [DEVICE_SCOPE_V2]: DEVICE_SCOPE_V3,
  [DEVICE_SCOPE_V3]: DEVICE_SCOPE_V4,
  [DEVICE_SCOPE_V4]: DEVICE_SCOPE_V5,
  [DEVICE_SCOPE_V5]: null,
};

/**
 * The scope the laptop's step-down moves a device back to from each (review r-m4: an undo of a grant, a rollback to a
 * worker that knows the scope below, without a Revoke): one rung at a time, v4 → v3 and v3 → v2, and never below v2 (the
 * lead's call on review r2-m2). Below v2 is no step-down: a phone told it holds less than v2 drops every plan edit it
 * hasn't sent, so stopping plan edits is Revoke's, never a quiet rung. Null where there is none.
 */
export const PREVIOUS_DEVICE_SCOPE: Readonly<Record<DeviceScope, DeviceScope | null>> = {
  [DEVICE_SCOPE_V1]: null,
  [DEVICE_SCOPE_V2]: null,
  [DEVICE_SCOPE_V3]: DEVICE_SCOPE_V2,
  [DEVICE_SCOPE_V4]: DEVICE_SCOPE_V3,
  [DEVICE_SCOPE_V5]: DEVICE_SCOPE_V4,
};

/** True when the body, as raw text, is within the scope. */
type BodyRule = (raw: string) => boolean;

/** True when the query, as its decoded parameters, is within the scope (DESIGN-2c §2.5). */
type QueryRule = (params: URLSearchParams) => boolean;

export interface DeviceRoute {
  /** PATCH and DELETE since v5 (what the coach remembers): the restore rule's `MUTATING` holds both already. */
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  pattern: RegExp;
  /** Answers true when the body is in scope. */
  body?: BodyRule;
  /** Answers true when the query is in scope. Absent: the query is never looked at (every pair of v1–v3, and v5's with a
   * body rule). */
  query?: QueryRule;
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

/** A date's shape, `YYYY-MM-DD`: the gate checks no more (the route checks it is a real date, within its bounds). */
const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

/** Each key of a query, and every value it was given (a repeated key has more than one). */
function queryKeys(params: URLSearchParams): Map<string, string[]> {
  const keys = new Map<string, string[]>();
  for (const [k, v] of params) keys.set(k, [...(keys.get(k) ?? []), v]);
  return keys;
}

/** `GET /api/native/days` from the phone: exactly the keys `from` and `to`, each once, each `YYYY-MM-DD`. */
export const deviceDaysQuery: QueryRule = (params) => {
  const keys = queryKeys(params);
  return keys.size === 2 && ["from", "to"].every((k) => keys.get(k)?.length === 1 && DATE_SHAPE.test(keys.get(k)![0]!));
};

/** A page's size as the phone asks it: 1–99, no leading zero (the route then holds it to 1–30). */
const LIMIT_SHAPE = /^[1-9]\d?$/;

/** `GET /api/native/history` from the phone: keys among `before` (`YYYY-MM-DD`) and `limit`, each at most once. */
export const deviceHistoryQuery: QueryRule = (params) => {
  for (const [k, values] of queryKeys(params)) {
    if (values.length !== 1) return false;
    if (k === "before" ? !DATE_SHAPE.test(values[0]!) : k === "limit" ? !LIMIT_SHAPE.test(values[0]!) : true) return false;
  }
  return true;
};

/** `GET /api/native/sessions/:id/ahead` from the phone: no query at all. */
export const deviceAheadQuery: QueryRule = (params) => queryKeys(params).size === 0;

// ── v5 (DESIGN-3 §3.5): the shapes only — each route checks the values, as for the web ───────────────────────────────

/** A v5 read that takes no query at all (a template, a move, a receipt, the current run, a proposal, the memory list…). */
export const noQuery: QueryRule = (params) => queryKeys(params).size === 0;

/** Keys among `allowed`, each at most once, each value passing its own shape. */
const queryOf =
  (allowed: Readonly<Record<string, RegExp>>): QueryRule =>
  (params) => {
    for (const [k, values] of queryKeys(params)) {
      const shape = Object.hasOwn(allowed, k) ? allowed[k] : undefined;
      if (!shape || values.length !== 1 || !shape.test(values[0]!)) return false;
    }
    return true;
  };

/** A word of the library's vocabulary as a filter names one: a family, a body area, a piece of gear. */
const VOCAB_WORD = /^[a-z0-9_-]{1,40}$/;
/** `GET /api/native/library` from the phone: keys among `q` (1–80 characters), `family`, `region`, `equipment`, `limit`
 * (1–100, no leading zero) and `cursor` (an offset, digits), each at most once. */
export const deviceLibraryQuery: QueryRule = queryOf({
  // eslint-disable-next-line no-control-regex
  q: /^[^\u0000-\u001f\u007f]{1,80}$/,
  family: VOCAB_WORD,
  region: VOCAB_WORD,
  equipment: VOCAB_WORD,
  limit: /^(100|[1-9]\d?)$/,
  cursor: /^\d{1,4}$/,
});

/** A run read's `afterSeq` (the step's arm too): digits, at most once; absent is 0. */
export const deviceAfterSeqQuery: QueryRule = queryOf({ afterSeq: /^\d{1,9}$/ });
/** `GET /api/coach/conversation` from the phone: `id` at most once (the route checks it is a conversation's id). */
export const deviceConversationQuery: QueryRule = queryOf({ id: /^[A-Za-z0-9_-]{1,100}$/ });
/** `GET /api/coach/nudges` from the phone: `seen` at most once (the chips the phone has shown; the route parses it). */
// eslint-disable-next-line no-control-regex
export const deviceNudgesQuery: QueryRule = queryOf({ seen: /^[^\u0000-\u001f\u007f]{0,2000}$/ });

/** An id the phone holds of the server's (a template, a receipt, a client's key): 1–`max` visible characters. */
// eslint-disable-next-line no-control-regex
const isIdText = (v: unknown, max = 200): v is string => typeof v === "string" && v.length >= 1 && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);

/**
 * *Put it on…* from the phone (3a): exactly `{date, clientId}` and, when sent, `time` — a local date, a clock time or null,
 * and the placement's key (made once on the phone, so a resend is the same row and the same receipt). The route checks the
 * date is real and not gone, and the template is the account's.
 */
export const devicePlaceBody: BodyRule = (raw) => {
  const p = parsed(raw);
  if (!p.ok || !isPlainObject(p.value) || !keysAre(p.value, ["date", "clientId"], ["time"])) return false;
  const { date, time, clientId } = p.value;
  return typeof date === "string" && DATE_SHAPE.test(date) && isIdText(clientId, 100) && (time === undefined || time === null || (typeof time === "string" && CLOCK_TIME.test(time)));
};

/** The most receipts one take-back names: a grouped card's ops (DESIGN-3 §3.5, pair 6). */
export const TAKE_BACK_MAX = 12;

/** *Take back* from the phone (3a, 3b): exactly `{receiptIds, requestId}` — 1–12 distinct receipt ids and the take-back's own
 * key, made once on the phone, so a resend answers what the first did. */
export const deviceTakeBackBody: BodyRule = (raw) => {
  const p = parsed(raw);
  if (!p.ok || !isPlainObject(p.value) || !keysAre(p.value, ["receiptIds", "requestId"])) return false;
  const { receiptIds, requestId } = p.value;
  return (
    Array.isArray(receiptIds) &&
    receiptIds.length >= 1 &&
    receiptIds.length <= TAKE_BACK_MAX &&
    receiptIds.every((id) => isIdText(id, 100)) &&
    new Set(receiptIds).size === receiptIds.length &&
    isIdText(requestId, 100)
  );
};

/** Switch A from the phone (Settings → Coach → *Your day and your training*): exactly `{toTraining, disclosureVersion}` —
 * on or off, and the version of the words the owner was shown when they chose. */
export const deviceSharingBody: BodyRule = (raw) => {
  const p = parsed(raw);
  if (!p.ok || !isPlainObject(p.value) || !keysAre(p.value, ["toTraining", "disclosureVersion"])) return false;
  const { toTraining, disclosureVersion } = p.value;
  return typeof toTraining === "boolean" && typeof disclosureVersion === "string" && /^[A-Za-z0-9._-]{1,40}$/.test(disclosureVersion);
};

/**
 * Ask your training coach, from the phone (3b; `frame` 3c): keys among `scope`, `request`, `focus`, `conversationId`,
 * `nudge` and `frame` — never `rehearsal` (the developer's lane) or `savesBatchId` (the laptop's saves flow). The route
 * checks every value, the frame's exact keys and switch A among them (400, 409 `sharing_off`).
 */
export const deviceRunCreateBody: BodyRule = (raw) => {
  const p = parsed(raw);
  if (!p.ok || !isPlainObject(p.value) || !keysAre(p.value, [], ["scope", "request", "focus", "conversationId", "nudge", "frame"])) return false;
  return p.value.frame === undefined || isPlainObject(p.value.frame);
};

/** An answer to the coach's question from the phone: keys among `answers`, `dismissed` and `conditionCheckId`. */
export const deviceRunAnswerBody: BodyRule = (raw) => {
  const p = parsed(raw);
  return p.ok && isPlainObject(p.value) && keysAre(p.value, [], ["answers", "dismissed", "conditionCheckId"]);
};

/** Taking back what the coach kept from an answer, from the phone: exactly `{handle}`. */
export const deviceUndoAnswerBody: BodyRule = (raw) => {
  const p = parsed(raw);
  return p.ok && isPlainObject(p.value) && keysAre(p.value, ["handle"]) && isIdText(p.value.handle, 300);
};

/** A proposal's version as the read gives it: 64 lower-case hex. */
const VERSION = /^[0-9a-f]{64}$/;

/**
 * APPROVE FROM THE PHONE NAMES WHAT IT APPROVES (DESIGN-3 §3.4.4; v0.20): exactly `{opIds, version}` — at least one op id,
 * and the version of the proposal the owner was shown — or exactly `{edit, version}`, one op's draft as the owner edited
 * it. Never a bare `{}` (the web's "everything open"), never opIds without the version. The route checks the version
 * against the proposal as it stands (409 `proposal_changed`) and refuses an incomplete one (409 `incomplete`).
 */
export const deviceApproveBody: BodyRule = (raw) => {
  const p = parsed(raw);
  if (!p.ok || !isPlainObject(p.value)) return false;
  const body = p.value;
  if (typeof body.version !== "string" || !VERSION.test(body.version)) return false;
  if (keysAre(body, ["opIds", "version"])) return Array.isArray(body.opIds) && body.opIds.length >= 1 && body.opIds.every((id) => isIdText(id));
  return keysAre(body, ["edit", "version"]) && isPlainObject(body.edit) && keysAre(body.edit, ["opId", "doc"], ["date", "time"]) && isPlainObject(body.edit.doc);
};

/** *Not this* from the phone: keys among `opIds` and `reason`. */
export const deviceDeclineBody: BodyRule = (raw) => {
  const p = parsed(raw);
  return p.ok && isPlainObject(p.value) && keysAre(p.value, [], ["opIds", "reason"]);
};

/** A memory item edited, pinned or confirmed from the phone: keys among `body`, `pinned` and `confirm`, at least one. */
export const deviceMemoryPatchBody: BodyRule = (raw) => {
  const p = parsed(raw);
  return p.ok && isPlainObject(p.value) && Object.keys(p.value).length > 0 && keysAre(p.value, [], ["body", "pinned", "confirm"]);
};

/** *Tell your training coach* (3c, the owner's tap): exactly `{kind, body, clientId}` — the route holds the body to one line
 * of at most 140 characters and the kind to note, fact or rule. */
export const deviceMemoryBody: BodyRule = (raw) => {
  const p = parsed(raw);
  return p.ok && isPlainObject(p.value) && keysAre(p.value, ["kind", "body", "clientId"]) && isIdText(p.value.clientId, 100);
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

/**
 * Stage 2c (kit v0.16, DESIGN-2c §2, §3): v3's fourteen entries, the very same objects in v3's order, then three reads that
 * write nothing — the plan's days (`from`…`to`, at most 14), the record behind it (a page of whole days, back one year) and
 * *What's in it* for one session ahead — each held to its query rule.
 */
const TRAINING_V4: readonly DeviceRoute[] = [
  ...TRAINING_V3,
  { method: "GET", pattern: /^\/api\/native\/days$/, query: deviceDaysQuery },
  { method: "GET", pattern: /^\/api\/native\/history$/, query: deviceHistoryQuery },
  { method: "GET", pattern: new RegExp(`^/api/native/sessions/${SEG}/ahead$`), query: deviceAheadQuery },
];

/**
 * R1 (kit v0.20, DESIGN-3 §3.5): v4's seventeen entries, the very same objects in v4's order, then the library (3a), the
 * take-back, switch A's flag and the coach designer's own routes (3b, 3c), each with its body or query rule. Left out on
 * purpose: the thread coach (`/state`, `/message`, `/wake`), `/analyze`, questions, plans (2d), preferences, replay, every
 * `/api/templates` and `/api/library` write (2d) and `POST /api/workouts`.
 */
const TRAINING_V5: readonly DeviceRoute[] = [
  ...TRAINING_V4,
  // 3a: saved workouts and moves, read trimmed; one put on the plan, with its receipt.
  { method: "GET", pattern: /^\/api\/native\/templates$/, query: noQuery },
  { method: "GET", pattern: new RegExp(`^/api/native/templates/${SEG}$`), query: noQuery },
  { method: "GET", pattern: /^\/api\/native\/library$/, query: deviceLibraryQuery },
  { method: "GET", pattern: new RegExp(`^/api/native/library/${SEG}$`), query: noQuery },
  { method: "POST", pattern: new RegExp(`^/api/native/templates/${SEG}/place$`), body: devicePlaceBody },
  // Take-back, bound to its receipts; a receipt's state and its provider work, read live.
  { method: "POST", pattern: /^\/api\/native\/take-back$/, body: deviceTakeBackBody },
  { method: "GET", pattern: new RegExp(`^/api/native/receipts/${SEG}$`), query: noQuery },
  // Switch A (off until the owner turns it on, on the phone).
  { method: "GET", pattern: /^\/api\/native\/sharing$/, query: noQuery },
  { method: "PUT", pattern: /^\/api\/native\/sharing$/, body: deviceSharingBody },
  // 3b: the coach designer's runs. `current` before `:id`, which would take it for an id.
  { method: "POST", pattern: /^\/api\/coach\/runs$/, body: deviceRunCreateBody },
  { method: "POST", pattern: new RegExp(`^/api/coach/runs/${SEG}/step$`), query: deviceAfterSeqQuery, body: emptyBody },
  { method: "GET", pattern: /^\/api\/coach\/runs\/current$/, query: noQuery },
  { method: "GET", pattern: new RegExp(`^/api/coach/runs/${SEG}$`), query: deviceAfterSeqQuery },
  { method: "POST", pattern: new RegExp(`^/api/coach/runs/${SEG}/answer$`), body: deviceRunAnswerBody },
  { method: "POST", pattern: new RegExp(`^/api/coach/runs/${SEG}/cancel$`), body: emptyBody },
  { method: "POST", pattern: new RegExp(`^/api/coach/runs/${SEG}/undo-answer$`), body: deviceUndoAnswerBody },
  { method: "GET", pattern: /^\/api\/coach\/conversation$/, query: deviceConversationQuery },
  // Its proposals: read, a draft, approved by their ops and version, declined; the watch drain after.
  { method: "GET", pattern: new RegExp(`^/api/coach/proposals/${SEG}$`), query: noQuery },
  { method: "GET", pattern: new RegExp(`^/api/coach/proposals/${SEG}/ops/${SEG}/draft$`), query: noQuery },
  { method: "POST", pattern: new RegExp(`^/api/coach/proposals/${SEG}/approve$`), body: deviceApproveBody },
  { method: "POST", pattern: new RegExp(`^/api/coach/proposals/${SEG}/decline$`), body: deviceDeclineBody },
  { method: "POST", pattern: /^\/api\/coach\/drain$/, body: emptyBody },
  // What it remembers: read, edit, delete; and (3c, the owner's tap) a stated item.
  { method: "GET", pattern: /^\/api\/coach\/memory$/, query: noQuery },
  { method: "PATCH", pattern: new RegExp(`^/api/coach/memory/${SEG}$`), body: deviceMemoryPatchBody },
  { method: "DELETE", pattern: new RegExp(`^/api/coach/memory/${SEG}$`), body: emptyBody },
  { method: "GET", pattern: /^\/api\/coach\/nudges$/, query: deviceNudgesQuery },
  { method: "GET", pattern: /^\/api\/coach\/spend$/, query: noQuery },
];

/** Each scope's list. Nothing else answers a device of that scope. */
export const DEVICE_SCOPES: Readonly<Record<DeviceScope, readonly DeviceRoute[]>> = {
  [DEVICE_SCOPE_V1]: TRAINING_SLICE_V1,
  [DEVICE_SCOPE_V2]: TRAINING_V2,
  [DEVICE_SCOPE_V3]: TRAINING_V3,
  [DEVICE_SCOPE_V4]: TRAINING_V4,
  [DEVICE_SCOPE_V5]: TRAINING_V5,
};

/** Whether a device row's scope is one this Worker knows (any other is refused 403 `out_of_scope`). */
export const isDeviceScope = (scope: string): scope is DeviceScope => Object.hasOwn(DEVICE_SCOPES, scope);

/** The pair of `scope`'s list this request is, or undefined (off the list). */
export function deviceRouteOf(scope: DeviceScope, method: string, path: string): DeviceRoute | undefined {
  return DEVICE_SCOPES[scope].find((r) => r.method === method && r.pattern.test(path));
}

/** Whether this request is in the device's scope: on its list, its query within the pair's rule, and its body too. */
export async function inDeviceScope(c: Context, scope: DeviceScope): Promise<boolean> {
  const route = deviceRouteOf(scope, c.req.method, c.req.path);
  if (!route) return false;
  if (route.query && !route.query(new URL(c.req.url).searchParams)) return false;
  if (!route.body) return true;
  return route.body(await c.req.text());
}
