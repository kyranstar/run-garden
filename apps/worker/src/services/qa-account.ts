/**
 * THE LIFEOS QA ACCOUNT (the phone QA harness, kit v0.16): one account in production that exists only to prove the phone's
 * workout flows on fixtures, and is purged after each run. It is the owner's tool, never a second athlete:
 *
 *  - IT CAN NEVER BE THE OWNER'S. Its email is `QA_EMAIL`, `lifeos-qa@invalid` — `.invalid` is reserved (RFC 2606): no
 *    mailbox, no Google account, no verified address — so Google sign-in (which needs Google's verified assertion of
 *    `ALLOWED_GOOGLE_EMAIL`) can never open it, and it has no cookie session at all. Where the owner's address would be
 *    the QA address (`qaPossible` false), nothing here treats any account as QA and every QA route is a 404.
 *  - EVERY WRITE NAMES IT BY A `QaTarget`, which only `resolveQaTarget` and `createQaUser` make, and every write re-reads its
 *    `users` row by id and refuses unless the row's email is still exactly `QA_EMAIL` (`assertQaRow`) — so even a target
 *    built by hand around the owner's id writes nothing.
 *  - NO PROVIDERS: made with no connection, AI off, COROS writes off, no calendar, the owner's timezone (its "today" is
 *    the phone's). The crons leave it out (index.ts `allUserIds`, the programme passes), and the provider boundary refuses
 *    it (`QA_EMAIL` in `googleCalendarClient`'s and `corosClient`'s reads; the device routes pass it no provider effects).
 *  - PAIRED FROM THE OWNER'S LAPTOP ONLY: `mintQaPairing` is the owner's cookie (routes/qa.ts); a QA code's phone is active
 *    at once (the owner's mint is its consent) — auth/native-devices.ts `redeemPairing`.
 *  - TWO RUN TOKENS, stateless (HMAC under `SESSION_SECRET`, labelled, bound to the QA account's id, so a purge and a new
 *    account retire them): the PLAN token reads the QA account's plan at `/api/lifeos/plan` (LifeOS QA's plan connection);
 *    the HARNESS token (`rgq_…`, at most `HARNESS_TOKEN_MAX_MS`) reads its state, mints a fresh code and purges it, for
 *    `scripts/phone-qa.sh` (routes/qa.ts `/run/*`).
 *  - PURGED WHOLE, AND CHECKED: `purgeQa` wipes every table of the registry (account-tables.ts) for the QA id, then its
 *    sign-ins and its `users` row, then counts every table again for that id — children by the ids their parents held
 *    before the wipe — and refuses to call it done unless every count is zero. Nothing global is touched.
 */
import { and, count, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import { DateTime } from "luxon";
import {
  accountState,
  auditEvents,
  calendarEventLinks,
  corosWriteJobs,
  nativeDevices,
  nativePairings,
  nativePairLimits,
  performedSessions,
  plannedWorkouts,
  programs,
  providerConnections,
  scheduleOverrides,
  sessionBuilds,
  sessions,
  studioPlanPushes,
  syncIntents,
  syncRuns,
  users,
  workoutCompletionMatches,
} from "@rg/database";
import { adaptiveConfigSchema, addDays, DEFAULT_USER_PREFERENCES, newId, nowInstant, todayInZone, type UserPreferences } from "@rg/domain";
import type { SourcePlannedWorkout } from "@rg/providers";
import type { Env } from "../env.js";
import { QA_EMAIL, qaPossible } from "../auth/qa-identity.js";
import { hmacSha256Hex, sha256Hex } from "../auth/crypto.js";
import { sameHex } from "../auth/token.js";
import { PAIRING_SCOPE } from "../auth/device-scope.js";
import { mintPairing } from "../auth/native-devices.js";
import { ACCOUNT_TABLES, accountTable, columnBySqlName, scopeWhere, wipeAccountData } from "./account-tables.js";
import { loadPreferences, savePreferences } from "./calendar-sync.js";
import { chunkIds, runAtomically, type Db } from "./db.js";
import { createDocWorkout } from "./doc-workouts.js";
import { importPlanSnapshot } from "./import-plan.js";
import { slotId } from "./program-slots.js";

export { isQaEmail, QA_EMAIL, qaPossible } from "../auth/qa-identity.js";
/** Its name, where an account's name shows. */
export const QA_NAME = "LifeOS QA";
/** Every fixture's title starts so: a screenshot or a snapshot can't be taken for the owner's plan. */
export const QA_TITLE_PREFIX = "QA ";

const norm = (email: string | null | undefined): string => (email ?? "").trim().toLowerCase();

/** A refusal of the guard: never a write. */
export class QaGuardError extends Error {
  constructor(readonly code: "qa_impossible" | "qa_is_owner" | "not_qa") {
    super(code);
    this.name = "QaGuardError";
  }
}
export class QaExistsError extends Error {
  constructor() {
    super("qa_exists");
    this.name = "QaExistsError";
  }
}
export class QaAlreadySeededError extends Error {
  constructor() {
    super("already_seeded");
    this.name = "QaAlreadySeededError";
  }
}
export class QaPurgeIncompleteError extends Error {
  constructor(readonly remaining: Record<string, number>) {
    super("purge_incomplete");
    this.name = "QaPurgeIncompleteError";
  }
}

declare const QA_BRAND: unique symbol;
/** The QA account, as only `resolveQaTarget` and `createQaUser` name it. */
export type QaTarget = { readonly userId: string; readonly [QA_BRAND]: true };
const brand = (userId: string): QaTarget => ({ userId }) as QaTarget;

/** The QA account's id, or null when there is none. One read. */
export async function qaUserIdOf(db: Db): Promise<string | null> {
  const [row] = await db.select({ id: users.id }).from(users).where(eq(users.email, QA_EMAIL)).limit(1);
  return row?.id ?? null;
}

/** The account is the QA account (one read). False wherever the QA account can't exist. */
export async function isQaAccount(db: Db, env: Pick<Env, "ALLOWED_GOOGLE_EMAIL"> | undefined, userId: string): Promise<boolean> {
  if (!qaPossible(env)) return false;
  const [row] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId)).limit(1);
  return row !== undefined && norm(row.email) === QA_EMAIL;
}

/**
 * THE ONE WAY TO NAME THE QA ACCOUNT for a write, from the owner's request (`ownerUserId`, the cookie's account): null when
 * there is none; a refusal when it would be the caller's own account, or the owner's address. Throws `qa_impossible`
 * where the QA account can't exist.
 */
export async function resolveQaTarget(db: Db, env: Pick<Env, "ALLOWED_GOOGLE_EMAIL">, ownerUserId: string): Promise<QaTarget | null> {
  if (!qaPossible(env)) throw new QaGuardError("qa_impossible");
  const [row] = await db.select({ id: users.id, email: users.email }).from(users).where(eq(users.email, QA_EMAIL)).limit(1);
  if (!row) return null;
  if (row.id === ownerUserId || norm(row.email) === norm(env.ALLOWED_GOOGLE_EMAIL)) throw new QaGuardError("qa_is_owner");
  return brand(row.id);
}

/** The harness token's account, as `verifyHarnessToken` found it: a target only while its row is the QA account's. */
export async function qaTargetById(db: Db, env: Pick<Env, "ALLOWED_GOOGLE_EMAIL">, userId: string): Promise<QaTarget | null> {
  if (!qaPossible(env)) return null;
  const [row] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId)).limit(1);
  if (!row || norm(row.email) !== QA_EMAIL) return null;
  return brand(userId);
}

/** Every write re-reads the target's row: it must still be the QA account's — never the owner's — or nothing is written. */
async function assertQaRow(db: Db, env: Pick<Env, "ALLOWED_GOOGLE_EMAIL">, target: QaTarget): Promise<void> {
  if (!qaPossible(env)) throw new QaGuardError("qa_impossible");
  const [row] = await db.select({ email: users.email }).from(users).where(eq(users.id, target.userId)).limit(1);
  if (!row || norm(row.email) !== QA_EMAIL || norm(row.email) === norm(env.ALLOWED_GOOGLE_EMAIL)) throw new QaGuardError("not_qa");
}

/** The QA account's preferences: the owner's timezone, and nothing that reaches a provider or a model. */
export function qaPreferences(timezone: string): UserPreferences {
  return { ...DEFAULT_USER_PREFERENCES, timezone, aiEnabled: false, corosWritesEnabled: false, calendarId: null };
}

/** Makes the QA account (`QaExistsError` when there is one), on the owner's clock. */
export async function createQaUser(db: Db, env: Pick<Env, "ALLOWED_GOOGLE_EMAIL">, ownerUserId: string, now: string = nowInstant()): Promise<QaTarget> {
  if (await resolveQaTarget(db, env, ownerUserId)) throw new QaExistsError();
  const { timezone } = await loadPreferences(db, ownerUserId);
  const id = newId();
  try {
    await db.insert(users).values({ id, email: QA_EMAIL, name: QA_NAME, googleSub: null, createdAt: now });
  } catch (e) {
    // Two at once: `users.email` is unique, and the other made it.
    if (await qaUserIdOf(db)) throw new QaExistsError();
    throw e;
  }
  await savePreferences(db, id, qaPreferences(timezone));
  return brand(id);
}

// ── Fixtures ──────────────────────────────────────────────────────────────────────────────────────────────────

/** One fixture, as the seed answers it. */
export interface QaFixture {
  id: string;
  title: string;
  date: string;
  time: string;
  kind: "document" | "programme_slot" | "run";
}

/** A short document workout: two moves, one set each, so the phone's player is through in a minute. */
export function qaDoc(title: string): Record<string, unknown> {
  return {
    version: 1,
    title,
    intent: { summary: "A short fixture session for the phone's QA run.", goals: ["posture"], focus: [], effort: "maintain" },
    parts: [
      {
        purpose: "main",
        format: "straight",
        items: [
          { kind: "exercise", libraryId: "bridge", dose: { sets: 1, reps: 10, restSec: 15 } },
          { kind: "exercise", libraryId: "deadBug", dose: { sets: 1, reps: 8, restSec: 15 } },
        ],
      },
    ],
    source: { kind: "studio" },
  };
}

const hh = (hour: number): string => `${String(hour).padStart(2, "0")}:00`;

/**
 * Today's fixture times: the next whole hour + 1, + 2, + 3 on the account's clock, kept between 06:00 and 21:00 (so *Later
 * today* has room before midnight — late in the evening the three share the last hours).
 */
export function qaTimes(now: string, timezone: string): [string, string, string] {
  const hour = DateTime.fromISO(now, { zone: "utc" }).setZone(timezone).hour;
  const at = (n: number) => hh(Math.min(21, Math.max(6, hour + n)));
  return [at(1), at(2), at(3)];
}

/** An adaptive programme's slot, as placement writes one (program-slots.ts), for `date` at `time`. */
function slotRow(userId: string, programId: string, title: string, date: string, time: string, at: string) {
  const id = slotId(programId, date);
  return {
    id,
    userId,
    planId: programId,
    sourceWorkoutId: id,
    title,
    category: "yoga",
    sport: "yoga",
    originalPlanDate: date,
    lastVerifiedCorosDate: "",
    effectiveDate: date,
    effectiveTime: time,
    sourceContentFingerprint: "program",
    calendarBlockDurationSeconds: 1200,
    fallbackEstimatedDurationSeconds: 1200,
    corosSyncState: "calendar_only",
    completionState: "scheduled",
    origin: "program",
    contentState: "outline",
    createdAt: at,
    updatedAt: at,
  } as const;
}

/**
 * THE FIXTURES, on the QA account's own clock (refused unless the account has no plan rows yet: purge first):
 *  - today: `QA Hips and back` (a Studio document workout), `QA Mobility` (an adaptive programme's slot), `QA Easy run`
 *    (a run, imported as a COROS plan's session is, at no address on any watch);
 *  - tomorrow: `QA Core reset` (a document workout) and `QA Mobility`'s next slot.
 * Through the services the web's routes use, never the route layer: no calendar booking, no cloud job runs from here.
 */
export async function seedQaFixtures(db: Db, env: Pick<Env, "ALLOWED_GOOGLE_EMAIL">, target: QaTarget, now: string = nowInstant()): Promise<{
  today: string;
  tomorrow: string;
  fixtures: QaFixture[];
}> {
  await assertQaRow(db, env, target);
  const userId = target.userId;
  const [{ n }] = (await db.select({ n: count() }).from(plannedWorkouts).where(eq(plannedWorkouts.userId, userId))) as [{ n: number }];
  if (n > 0) throw new QaAlreadySeededError();
  const prefs = await loadPreferences(db, userId);
  const today = todayInZone(prefs.timezone, new Date(now));
  const tomorrow = addDays(today, 1);
  const [t1, t2, t3] = qaTimes(now, prefs.timezone);
  const ctx = { today, now, prefs };
  const fixtures: QaFixture[] = [];

  const doc = async (title: string, date: string, time: string, key: string) => {
    const made = await createDocWorkout(db, userId, { date, time, doc: qaDoc(title), clientId: `qa-${key}-${date}` }, ctx);
    fixtures.push({ id: made.workout.id, title, date, time, kind: "document" });
  };
  await doc(`${QA_TITLE_PREFIX}Hips and back`, today, t1, "hips");

  // The programme and its two slots (today's and tomorrow's), as placement writes them.
  const programId = newId();
  await db.insert(programs).values({
    id: programId,
    userId,
    kind: "adaptive",
    name: `${QA_TITLE_PREFIX}Mobility`,
    status: "active",
    disciplines: ["yoga", "strength"],
    startDate: today,
    endDate: null,
    raceDate: null,
    source: null,
    config: adaptiveConfigSchema.parse({ defaultMinutes: 20, weeklyGoal: 2 }),
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
  });
  for (const [date, time] of [
    [today, t2],
    [tomorrow, "08:00"],
  ] as const) {
    const row = slotRow(userId, programId, `${QA_TITLE_PREFIX}Mobility`, date, time, now);
    await db.insert(plannedWorkouts).values(row);
    fixtures.push({ id: row.id, title: row.title, date, time, kind: "programme_slot" });
  }

  // The run: imported as a COROS plan's session is (the owner's runs come that way), with no address on any watch.
  const sourcePlanId = `qa-plan-${userId}`;
  const run: SourcePlannedWorkout = {
    sourcePlanId,
    sourceWorkoutId: `qa-run-${today}`,
    title: `${QA_TITLE_PREFIX}Easy run`,
    sport: "run",
    date: today,
    estimatedDurationSeconds: 1200,
    stages: [],
    contentFingerprint: `qa-run-${today}`,
    isRestDay: false,
  };
  await importPlanSnapshot(
    db,
    { userId, plan: { sourcePlanId, name: `${QA_TITLE_PREFIX}Plan`, startDate: today, endDate: tomorrow }, workouts: [run], rangeStart: today, rangeEnd: tomorrow, source: "fixture" },
    prefs,
  );
  const [runRow] = await db
    .update(plannedWorkouts)
    .set({ effectiveTime: t3, updatedAt: now })
    .where(and(eq(plannedWorkouts.userId, userId), eq(plannedWorkouts.sourceWorkoutId, run.sourceWorkoutId), isNull(plannedWorkouts.archivedAt)))
    .returning({ id: plannedWorkouts.id, title: plannedWorkouts.title });
  if (runRow) fixtures.push({ id: runRow.id, title: runRow.title, date: today, time: t3, kind: "run" });

  await doc(`${QA_TITLE_PREFIX}Core reset`, tomorrow, "07:00", "core");
  return { today, tomorrow, fixtures };
}

// ── Pairing and the run's tokens ─────────────────────────────────────────────────────────────────────────────

/** The longest a harness token lives (a run is minutes; a build and an install, a few more). */
export const HARNESS_TOKEN_MAX_MS = 6 * 3_600_000;
const PLAN_LABEL = "run-garden lifeos qa plan token v1";
const HARNESS_LABEL = "run-garden lifeos qa harness token v1";
const HARNESS_TOKEN = /^rgq_([0-9a-f-]{36})_(\d{10})_([0-9a-f]{64})$/;

/** The QA account's plan token: 64 hex, the shape LifeOS's plan connection takes; read only, its plan only. */
export const qaPlanToken = (env: Pick<Env, "SESSION_SECRET">, qaUserId: string): Promise<string> =>
  hmacSha256Hex(env.SESSION_SECRET, `${PLAN_LABEL}\n${qaUserId}`);

/** The harness token for `qaUserId`, good until `expiresAtMs` (whole seconds). */
export async function qaHarnessToken(env: Pick<Env, "SESSION_SECRET">, qaUserId: string, expiresAtMs: number): Promise<string> {
  const exp = Math.floor(expiresAtMs / 1000);
  return `rgq_${qaUserId}_${exp}_${await hmacSha256Hex(env.SESSION_SECRET, `${HARNESS_LABEL}\n${qaUserId}\n${exp}`)}`;
}

/** A well-formed, live, genuine harness token's account id, or null. Says nothing about whether that account still exists. */
export async function verifyHarnessToken(env: Pick<Env, "SESSION_SECRET" | "ALLOWED_GOOGLE_EMAIL">, token: string, nowMs: number = Date.now()): Promise<string | null> {
  if (!qaPossible(env)) return null;
  const m = HARNESS_TOKEN.exec(token);
  if (!m) return null;
  const [, userId, expText, mac] = m as unknown as [string, string, string, string];
  const exp = Number(expText) * 1000;
  if (!(exp > nowMs) || exp > nowMs + HARNESS_TOKEN_MAX_MS + 60_000) return null;
  const expected = await hmacSha256Hex(env.SESSION_SECRET, `${HARNESS_LABEL}\n${userId}\n${expText}`);
  return sameHex(mac, expected) ? userId : null;
}

/** The account a plan token reads: the QA account's id when `token` is its plan token, else null. Reads only when it could be. */
export async function qaPlanTokenAccount(db: Db, env: Pick<Env, "SESSION_SECRET" | "ALLOWED_GOOGLE_EMAIL">, token: string): Promise<string | null> {
  if (!qaPossible(env) || !/^[0-9a-f]{64}$/.test(token)) return null;
  const qaId = await qaUserIdOf(db);
  if (!qaId) return null;
  return sameHex(token, await qaPlanToken(env, qaId)) ? qaId : null;
}

/** The first 8 hex of SHA-256(userId): how the phone's state snapshot and the panel name an account without its id. */
export const accountTag = async (userId: string): Promise<string> => (await sha256Hex(userId)).slice(0, 8);

/**
 * A pairing code for the QA account (the owner's laptop, or the harness token), with the run's tokens: the same code, HMAC,
 * lifetime and per-account mint bound as the owner's own (`mintPairing`). A phone that redeems it is the QA account's, active
 * at once, at `PAIRING_SCOPE`.
 */
export async function mintQaPairing(
  db: Db,
  env: Env,
  target: QaTarget,
  now: string = nowInstant(),
): Promise<
  | { code: string; expiresAt: string; scope: string; planToken: string; harnessToken: string; harnessExpiresAt: string; accountTag: string }
  | { refused: true; retryAfterSeconds: number }
> {
  await assertQaRow(db, env, target);
  // The redeem throttles stay as they are: they guard the owner's code too, and only the owner's own Pair lifts them.
  const minted = await mintPairing(db, env, target.userId, now, { liftRedeemThrottles: false });
  if ("refused" in minted) return minted;
  const harnessExp = Date.parse(now) + HARNESS_TOKEN_MAX_MS;
  return {
    ...minted,
    scope: PAIRING_SCOPE,
    planToken: await qaPlanToken(env, target.userId),
    harnessToken: await qaHarnessToken(env, target.userId, harnessExp),
    harnessExpiresAt: new Date(Math.floor(harnessExp / 1000) * 1000).toISOString(),
    accountTag: await accountTag(target.userId),
  };
}

// ── State ──────────────────────────────────────────────────────────────────────────────────────────────────

/** What the QA account holds, for the panel and the harness's assertions: ids, states, kinds and counts — no detail text. */
export async function qaState(db: Db, userId: string): Promise<Record<string, unknown>> {
  const prefs = await loadPreferences(db, userId);
  const plan = await db
    .select({
      id: plannedWorkouts.id,
      title: plannedWorkouts.title,
      date: plannedWorkouts.effectiveDate,
      time: plannedWorkouts.effectiveTime,
      state: plannedWorkouts.completionState,
      contentState: plannedWorkouts.contentState,
      origin: plannedWorkouts.origin,
      category: plannedWorkouts.category,
      sport: plannedWorkouts.sport,
      archivedAt: plannedWorkouts.archivedAt,
    })
    .from(plannedWorkouts)
    .where(eq(plannedWorkouts.userId, userId))
    .orderBy(plannedWorkouts.effectiveDate, plannedWorkouts.effectiveTime, plannedWorkouts.id);
  const ids = plan.map((p) => p.id);
  const overrides: Array<Record<string, unknown>> = [];
  const matches: Array<Record<string, unknown>> = [];
  for (const chunk of chunkIds(ids)) {
    overrides.push(
      ...(await db
        .select({ workoutId: scheduleOverrides.workoutId, kind: scheduleOverrides.kind, fromDate: scheduleOverrides.fromDate, toDate: scheduleOverrides.toDate, toTime: scheduleOverrides.toTime, source: scheduleOverrides.source })
        .from(scheduleOverrides)
        .where(inArray(scheduleOverrides.workoutId, chunk))),
    );
    matches.push(
      ...(await db
        .select({ workoutId: workoutCompletionMatches.workoutId, activityId: workoutCompletionMatches.activityId, method: workoutCompletionMatches.method, undoneAt: workoutCompletionMatches.undoneAt })
        .from(workoutCompletionMatches)
        .where(inArray(workoutCompletionMatches.workoutId, chunk))),
    );
  }
  const builds = await db
    .select({ workoutId: sessionBuilds.workoutId, n: count() })
    .from(sessionBuilds)
    .where(eq(sessionBuilds.userId, userId))
    .groupBy(sessionBuilds.workoutId);
  const performed = await db
    .select({ id: performedSessions.id, workoutId: performedSessions.workoutId, completed: performedSessions.completed, source: performedSessions.source, localDate: performedSessions.localDate })
    .from(performedSessions)
    .where(eq(performedSessions.userId, userId));
  const audits = await db
    .select({ kind: auditEvents.kind, at: auditEvents.createdAt, workoutId: sql<string | null>`case when json_valid(${auditEvents.detail}) then json_extract(${auditEvents.detail}, '$.workoutId') end` })
    .from(auditEvents)
    .where(eq(auditEvents.userId, userId))
    .orderBy(auditEvents.createdAt);
  const devices = await db
    .select({ state: nativeDevices.state, scope: nativeDevices.scope, label: nativeDevices.label, lastUsedAt: nativeDevices.lastUsedAt, expiresAt: nativeDevices.expiresAt })
    .from(nativeDevices)
    .where(eq(nativeDevices.userId, userId));
  const providers = {
    connections: await countWhere(db, providerConnections, eq(providerConnections.userId, userId)),
    corosWriteJobs: await countWhere(db, corosWriteJobs, eq(corosWriteJobs.userId, userId)),
    calendarEventLinks: ids.length === 0 ? 0 : await countIn(db, calendarEventLinks, "workout_id", ids),
    studioPlanPushes: await countWhere(db, studioPlanPushes, sql`${studioPlanPushes.planId} in (select id from studio_plans where user_id = ${userId})`),
    syncRuns: await countWhere(db, syncRuns, eq(syncRuns.userId, userId)),
    syncIntents: await countWhere(db, syncIntents, eq(syncIntents.userId, userId)),
  };
  return {
    userId,
    accountTag: await accountTag(userId),
    timezone: prefs.timezone,
    today: todayInZone(prefs.timezone),
    plan,
    overrides,
    builds,
    performed,
    matches,
    audits,
    devices,
    providers,
    rows: await qaRowCounts(db, userId),
  };
}

/** Rows of `table` where `where` holds. */
async function countWhere(db: Db, table: SQLiteTable, where: SQL | undefined): Promise<number> {
  const [row] = (await db.select({ n: count() }).from(table).where(where)) as Array<{ n: number }>;
  return row?.n ?? 0;
}

/** Rows of `table` whose `column` (an SQL name) is one of `ids`, chunked under D1's bind ceiling. */
async function countIn(db: Db, table: SQLiteTable, column: string, ids: readonly string[]): Promise<number> {
  let n = 0;
  for (const chunk of chunkIds([...ids])) n += await countWhere(db, table, inArray(columnBySqlName(table, column), chunk));
  return n;
}

/** The sign-in tables the registry leaves to delete-all (account-tables.ts `signIn`), and `account_state`: by the account. */
const signInCounts = (db: Db, userId: string) => [
  ["sessions", () => countWhere(db, sessions, eq(sessions.userId, userId))],
  ["native_devices", () => countWhere(db, nativeDevices, eq(nativeDevices.userId, userId))],
  ["native_pairings", () => countWhere(db, nativePairings, eq(nativePairings.userId, userId))],
  ["native_pair_limits", () => countWhere(db, nativePairLimits, eq(nativePairLimits.key, `mint:${userId}`))],
  ["account_state", () => countWhere(db, accountState, eq(accountState.userId, userId))],
] as const;

/**
 * Every table's rows for the account: each `identity`, `user` and `child` table of the registry (a child by `parentIds`
 * when given — the ids its parent table held for the account before a wipe — else through its parent as it is now), and
 * the sign-in tables. Non-zero entries only, unless `all`.
 */
export async function qaRowCounts(
  db: Db,
  userId: string,
  opts: { parentIds?: ReadonlyMap<string, readonly string[]>; all?: boolean } = {},
): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const entry of ACCOUNT_TABLES) {
    const scope = entry.scope;
    if (scope.kind === "excluded") continue;
    let n: number;
    if (scope.kind === "child" && opts.parentIds) {
      const ids = opts.parentIds.get(entry.name) ?? [];
      n = ids.length === 0 ? 0 : await countIn(db, entry.table, scope.column, ids);
    } else {
      n = await countWhere(db, entry.table, scopeWhere(entry, userId));
    }
    if (n > 0 || opts.all) out[entry.name] = n;
  }
  for (const [name, read] of signInCounts(db, userId)) {
    const n = await read();
    if (n > 0 || opts.all) out[name] = n;
  }
  return out;
}

/** For each child table of the registry, the ids its parent holds for the account now (what the child is checked by). */
async function parentIdsOf(db: Db, userId: string): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const cache = new Map<string, string[]>();
  for (const entry of ACCOUNT_TABLES) {
    if (entry.scope.kind !== "child") continue;
    const parent = accountTable(entry.scope.parent);
    const key = `${parent.name}.${entry.scope.parentKey ?? "id"}`;
    if (!cache.has(key)) {
      const col = columnBySqlName(parent.table, entry.scope.parentKey ?? "id");
      const rows = (await db.select({ id: col }).from(parent.table).where(scopeWhere(parent, userId))) as Array<{ id: string }>;
      cache.set(key, rows.map((r) => r.id));
    }
    out.set(entry.name, cache.get(key)!);
  }
  return out;
}

/**
 * EVERYTHING THE QA ACCOUNT OWNS, GONE, AND CHECKED. The target's row is read again first (the QA address, never the
 * owner's). Then the registry's own wipe (every `user` and `child` table, children first, one D1 batch), then one batch for
 * its `account_state`, sessions, paired phones, pairing code, mint counter and `users` row — nothing global (no orphan
 * sweep, no `oauth_states` clear, no redeem counter). Then every table is counted again for the id, children by the ids
 * their parents held before the wipe: any row left is `QaPurgeIncompleteError` with the tables named. Answers what was
 * removed, per table, and the (all zero) counts after.
 */
export async function purgeQa(db: Db, env: Pick<Env, "ALLOWED_GOOGLE_EMAIL">, target: QaTarget): Promise<{
  removed: Record<string, number>;
  remaining: Record<string, number>;
  total: number;
}> {
  await assertQaRow(db, env, target);
  const userId = target.userId;
  const parentIds = await parentIdsOf(db, userId);
  const removed = await qaRowCounts(db, userId, { parentIds });
  await wipeAccountData(db, userId, { keep: [] });
  await runAtomically(db, [
    db.delete(accountState).where(eq(accountState.userId, userId)),
    db.delete(sessions).where(eq(sessions.userId, userId)),
    db.delete(nativeDevices).where(eq(nativeDevices.userId, userId)),
    db.delete(nativePairings).where(eq(nativePairings.userId, userId)),
    db.delete(nativePairLimits).where(eq(nativePairLimits.key, `mint:${userId}`)),
    // Last, and only while it is still the QA address: the row the guard read.
    db.delete(users).where(and(eq(users.id, userId), eq(users.email, QA_EMAIL))),
  ]);
  const remaining = await qaRowCounts(db, userId, { parentIds, all: true });
  const left = Object.fromEntries(Object.entries(remaining).filter(([, n]) => n > 0));
  if (Object.keys(left).length > 0) throw new QaPurgeIncompleteError(left);
  return { removed, remaining, total: Object.values(remaining).reduce((a, b) => a + b, 0) };
}
