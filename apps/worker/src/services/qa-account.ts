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
import { and, count, eq, inArray, isNull, ne, sql, type SQL } from "drizzle-orm";
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
  trainingPlans,
  users,
  workoutCompletionMatches,
} from "@rg/database";
import { adaptiveConfigSchema, addDays, DEFAULT_USER_PREFERENCES, newId, nowInstant, todayInZone, type UserPreferences } from "@rg/domain";
import { classifyWorkout } from "@rg/scheduling";
import type { Env } from "../env.js";
import { isQaAddress, QA_EMAIL, qaPossible } from "../auth/qa-identity.js";
import { sha256Hex } from "../auth/crypto.js";
import { HARNESS_TOKEN_MAX_MS, qaHarnessToken, qaPlanToken, qaUserIdOf } from "../auth/qa-tokens.js";
import { PAIRING_SCOPE } from "../auth/device-scope.js";
import { mintPairing, revokeAllDevices } from "../auth/native-devices.js";
import { ACCOUNT_TABLES, accountTable, columnBySqlName, scopeWhere } from "./account-tables.js";
import { loadPreferences, savePreferences } from "./calendar-sync.js";
import { chunkIds, runAtomically, type Db } from "./db.js";
import { createDocWorkout } from "./doc-workouts.js";
import { slotId } from "./program-slots.js";

export { isQaAddress, isQaEmail, QA_EMAIL, qaPossible } from "../auth/qa-identity.js";
export {
  HARNESS_TOKEN_MAX_MS,
  qaHarnessToken,
  qaPlanToken,
  qaPlanTokenAccount,
  qaUserIdOf,
  verifyHarnessToken,
} from "../auth/qa-tokens.js";
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

/** The account is the QA account (one read). False wherever the QA account can't exist. */
export async function isQaAccount(db: Db, env: Pick<Env, "ALLOWED_GOOGLE_EMAIL"> | undefined, userId: string): Promise<boolean> {
  if (!qaPossible(env)) return false;
  const [row] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId)).limit(1);
  return row !== undefined && isQaAddress(row.email);
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
  if (!row || !isQaAddress(row.email)) return null;
  return brand(userId);
}

/** Every write re-reads the target's row: it must still be the QA account's — never the owner's — or nothing is written. */
async function assertQaRow(db: Db, env: Pick<Env, "ALLOWED_GOOGLE_EMAIL">, target: QaTarget): Promise<void> {
  if (!qaPossible(env)) throw new QaGuardError("qa_impossible");
  const [row] = await db.select({ email: users.email }).from(users).where(eq(users.id, target.userId)).limit(1);
  if (!row || !isQaAddress(row.email) || norm(row.email) === norm(env.ALLOWED_GOOGLE_EMAIL)) throw new QaGuardError("not_qa");
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

  // The run: a COROS plan's session as the plan import writes one (the owner's runs come that way) — its plan row and its
  // session row, at no address on any watch — written directly: the import's own reconciling of a whole schedule would cost
  // this request twenty statements more (Workers Free's budget).
  const planRowId = newId();
  const runTitle = `${QA_TITLE_PREFIX}Easy run`;
  const runId = newId();
  const { category } = classifyWorkout({ title: runTitle, sport: "run", stages: [] });
  await runAtomically(db, [
    db.insert(trainingPlans).values({
      id: planRowId, userId, provider: "coros", sourcePlanId: `qa-plan-${userId}`, name: `${QA_TITLE_PREFIX}Plan`, startDate: today, endDate: tomorrow,
      status: "active", createdAt: now, updatedAt: now,
    }),
    db.insert(plannedWorkouts).values({
      id: runId, userId, planId: planRowId, sourceWorkoutId: `qa-run-${today}`, title: runTitle, category, sport: "run", originalPlanDate: today,
      lastVerifiedCorosDate: today, effectiveDate: today, effectiveTime: t3, sourceContentFingerprint: `qa-run-${today}`,
      sourceEstimatedDurationSeconds: 1200, fallbackEstimatedDurationSeconds: 1200, calendarBlockDurationSeconds: 1200,
      calendarSyncState: "not_created", corosSyncState: "calendar_only", completionState: "scheduled", createdAt: now, updatedAt: now,
    }),
  ]);
  fixtures.push({ id: runId, title: runTitle, date: today, time: t3, kind: "run" });

  await doc(`${QA_TITLE_PREFIX}Core reset`, tomorrow, "07:00", "core");
  return { today, tomorrow, fixtures };
}

// ── Pairing and the run's tokens ─────────────────────────────────────────────────────────────────────────────

/**
 * How the panel and the phone's state snapshot name an account without its id: the first 8 hex of LifeOS's own account key
 * (LifeOS `RunGardenAccountKey`: SHA-256 of "lifeos run-garden account v1\n" and the id), so the two can be compared.
 */
export const accountTag = async (userId: string): Promise<string> => (await sha256Hex(`lifeos run-garden account v1\n${userId}`)).slice(0, 8);

/** A QA pairing code, as the harness token's door answers it: the code alone, never a token (the review's MINOR-3). */
export interface QaCode {
  code: string;
  expiresAt: string;
  scope: string;
  accountTag: string;
}

/** A QA pairing code with the run's tokens, as the owner's cookie route answers it: only the owner's laptop mints tokens. */
export interface QaMint extends QaCode {
  planToken: string;
  harnessToken: string;
  harnessExpiresAt: string;
}

/**
 * A pairing code for the QA account: the same code, HMAC, lifetime and per-account mint bound as the owner's own
 * (`mintPairing`). A phone that redeems it is the QA account's, active at once, at `PAIRING_SCOPE`. With `tokens` (the owner's
 * cookie route only), the run's tokens too: a harness token good for `HARNESS_TOKEN_MAX_MS` from now, and the plan token.
 * Without (the harness token's own door), the code alone — so a harness token can never renew itself, and six hours from
 * the owner's mint bounds it (the review's MINOR-3).
 */
export async function mintQaPairing(
  db: Db,
  env: Env,
  target: QaTarget,
  opts: { tokens: true },
  now?: string,
): Promise<QaMint | { refused: true; retryAfterSeconds: number }>;
export async function mintQaPairing(
  db: Db,
  env: Env,
  target: QaTarget,
  opts: { tokens: false },
  now?: string,
): Promise<QaCode | { refused: true; retryAfterSeconds: number }>;
export async function mintQaPairing(
  db: Db,
  env: Env,
  target: QaTarget,
  opts: { tokens: boolean },
  now?: string,
): Promise<QaCode | QaMint | { refused: true; retryAfterSeconds: number }>;
export async function mintQaPairing(
  db: Db,
  env: Env,
  target: QaTarget,
  opts: { tokens: boolean },
  now: string = nowInstant(),
): Promise<QaCode | QaMint | { refused: true; retryAfterSeconds: number }> {
  await assertQaRow(db, env, target);
  // The redeem throttles stay as they are: they guard the owner's code too, and only the owner's own Pair lifts them.
  const minted = await mintPairing(db, env, target.userId, now, { liftRedeemThrottles: false });
  if ("refused" in minted) return minted;
  const code: QaCode = { code: minted.code, expiresAt: minted.expiresAt, scope: PAIRING_SCOPE, accountTag: await accountTag(target.userId) };
  if (!opts.tokens) return code;
  const harnessExp = Date.parse(now) + HARNESS_TOKEN_MAX_MS;
  return {
    ...code,
    planToken: await qaPlanToken(env, target.userId),
    harnessToken: await qaHarnessToken(env, target.userId, harnessExp),
    harnessExpiresAt: new Date(Math.floor(harnessExp / 1000) * 1000).toISOString(),
  };
}

/**
 * REVOKE THE QA PHONE (the panel's button, the review's N-3): every paired phone of the QA account, at once — the owner's
 * Settings → Devices lists only the owner's own, so this is the one way, short of the purge, to end a QA phone that was kept
 * (`phone-qa.sh --keep`). The account and its fixtures stay. How many it revoked.
 */
export async function revokeQaPhones(db: Db, env: Pick<Env, "ALLOWED_GOOGLE_EMAIL">, target: QaTarget, now: string = nowInstant()): Promise<number> {
  await assertQaRow(db, env, target);
  return revokeAllDevices(db, target.userId, now);
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
  // The provider rows, in one statement.
  const [p] = (await db.all(sql`select
      (select count(*) from ${providerConnections} where ${providerConnections.userId} = ${userId}) as connections,
      (select count(*) from ${corosWriteJobs} where ${corosWriteJobs.userId} = ${userId}) as corosWriteJobs,
      (select count(*) from ${calendarEventLinks} where ${calendarEventLinks.workoutId} in (select id from planned_workouts where user_id = ${userId})) as calendarEventLinks,
      (select count(*) from ${studioPlanPushes} where ${studioPlanPushes.planId} in (select id from studio_plans where user_id = ${userId})) as studioPlanPushes,
      (select count(*) from ${syncRuns} where ${syncRuns.userId} = ${userId}) as syncRuns,
      (select count(*) from ${syncIntents} where ${syncIntents.userId} = ${userId}) as syncIntents`)) as Array<Record<string, number>>;
  const providers = {
    connections: Number(p?.connections ?? 0),
    corosWriteJobs: Number(p?.corosWriteJobs ?? 0),
    calendarEventLinks: Number(p?.calendarEventLinks ?? 0),
    studioPlanPushes: Number(p?.studioPlanPushes ?? 0),
    syncRuns: Number(p?.syncRuns ?? 0),
    syncIntents: Number(p?.syncIntents ?? 0),
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

/**
 * Counts in a few statements, not one a table (Workers Free allows 50 subrequests a request, and every D1 statement is
 * one: account-restore.ts's final audit G21). Each statement is `COUNTS_PER_STATEMENT` scalar subqueries, each binding the
 * account once — or, for a child counted by its parent's recorded ids, one JSON array of them (`json_each`), whatever
 * their number — well under D1's 100 bound parameters.
 */
const COUNTS_PER_STATEMENT = 40;

/** One count: its name, and the subquery that counts it. */
type Count = { name: string; query: SQL };

async function runCounts(db: Db, counts: readonly Count[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (let i = 0; i < counts.length; i += COUNTS_PER_STATEMENT) {
    const chunk = counts.slice(i, i + COUNTS_PER_STATEMENT);
    const columns = sql.join(chunk.map((c, j) => sql`(${c.query}) as ${sql.raw(`c${j}`)}`), sql`, `);
    const [row] = (await db.all(sql`select ${columns}`)) as Array<Record<string, unknown>>;
    chunk.forEach((c, j) => (out[c.name] = Number(row?.[`c${j}`] ?? 0)));
  }
  return out;
}

const countOf = (table: SQLiteTable, where: SQL): SQL => sql`select count(*) from ${table} where ${where}`;

/** The sign-in tables the registry leaves to delete-all (account-tables.ts `signIn`), and `account_state`: by the account. */
const signInCounts = (userId: string): Count[] => [
  { name: "sessions", query: countOf(sessions, eq(sessions.userId, userId)) },
  { name: "native_devices", query: countOf(nativeDevices, eq(nativeDevices.userId, userId)) },
  { name: "native_pairings", query: countOf(nativePairings, eq(nativePairings.userId, userId)) },
  { name: "native_pair_limits", query: countOf(nativePairLimits, eq(nativePairLimits.key, `mint:${userId}`)) },
  { name: "account_state", query: countOf(accountState, eq(accountState.userId, userId)) },
];

/**
 * Every table's rows for the account: each `identity`, `user` and `child` table of the registry (a child by `parentIds`
 * when given — the ids its parent table held for the account before a wipe — else through its parent as it is now), and
 * the sign-in tables. Non-zero entries only, unless `all`. A few statements (`COUNTS_PER_STATEMENT`).
 */
export async function qaRowCounts(
  db: Db,
  userId: string,
  opts: { parentIds?: ReadonlyMap<string, readonly string[]>; all?: boolean } = {},
): Promise<Record<string, number>> {
  const counts: Count[] = [];
  for (const entry of ACCOUNT_TABLES) {
    const scope = entry.scope;
    if (scope.kind === "excluded") continue;
    const where =
      scope.kind === "child" && opts.parentIds
        ? sql`${columnBySqlName(entry.table, scope.column)} in (select value from json_each(${JSON.stringify(opts.parentIds.get(entry.name) ?? [])}))`
        : scopeWhere(entry, userId);
    counts.push({ name: entry.name, query: countOf(entry.table, where) });
  }
  counts.push(...signInCounts(userId));
  const all = await runCounts(db, counts);
  return opts.all ? all : Object.fromEntries(Object.entries(all).filter(([, n]) => n > 0));
}

/**
 * For each child table of the registry, the ids its parent holds for the account now (what the child is checked by after
 * the wipe) — one statement: each parent's ids as one JSON array.
 */
async function parentIdsOf(db: Db, userId: string): Promise<Map<string, string[]>> {
  const parents = new Map<string, { table: SQLiteTable; key: string; where: SQL }>();
  for (const entry of ACCOUNT_TABLES) {
    if (entry.scope.kind !== "child") continue;
    const parent = accountTable(entry.scope.parent);
    const key = entry.scope.parentKey ?? "id";
    parents.set(`${parent.name}.${key}`, { table: parent.table, key, where: scopeWhere(parent, userId) });
  }
  const names = [...parents.keys()];
  const columns = sql.join(
    names.map((name, j) => {
      const p = parents.get(name)!;
      return sql`(select json_group_array(${columnBySqlName(p.table, p.key)}) from ${p.table} where ${p.where}) as ${sql.raw(`p${j}`)}`;
    }),
    sql`, `,
  );
  const [row] = (await db.all(sql`select ${columns}`)) as Array<Record<string, unknown>>;
  const byParent = new Map(names.map((name, j) => [name, JSON.parse(String(row?.[`p${j}`] ?? "[]")) as string[]]));
  const out = new Map<string, string[]>();
  for (const entry of ACCOUNT_TABLES) {
    if (entry.scope.kind !== "child") continue;
    out.set(entry.name, byParent.get(`${accountTable(entry.scope.parent).name}.${entry.scope.parentKey ?? "id"}`) ?? []);
  }
  return out;
}

/**
 * Table deletes one purge step makes at most. A step that is also the last, at this many tables, runs 1 guard read + 1
 * parent-ids read + 3 counts + the phones' revoke + 25 deletes + 6 sign-in deletes + 3 counts = 40, and the owner's route 3
 * more: 43 of the repo's 45-statement budget (Workers Free: 50), with room for a statement more in `requireUser` or the
 * guard (the review's MINOR-4: at 28 it was exactly 45).
 */
export const PURGE_DELETES_PER_STEP = 25;

/** One step's answer: what it removed, and — once `done` — every table counted again (all zero) and their total. */
export interface QaPurgeStep {
  done: boolean;
  removed: Record<string, number>;
  /** Once done: every table, counted for the account after; before: the tables still holding rows. */
  remaining: Record<string, number>;
  total: number;
}

/**
 * EVERYTHING THE QA ACCOUNT OWNS, GONE, AND CHECKED — one bounded step a request (Workers Free counts every D1 statement,
 * a batch's included, against 50 a request; account-restore.ts G21), repeated until `done`. The target's row is read again
 * first (the QA address, never the owner's). Each step counts every registry table for the account (a few statements),
 * then deletes up to `PURGE_DELETES_PER_STEP` of the tables still holding rows in one batch, CHILDREN FIRST — the registry's
 * own wipe order (account-tables.ts `wipeAccountData`), kept across steps: a parent's rows go only in a step whose batch
 * already holds every child of it still holding rows, so no child is ever left without the parent that reaches it.
 *
 * The step that empties the last table also deletes, in one batch, the account's `account_state`, sessions, paired phones,
 * pairing code, mint counter and `users` row — nothing global (no orphan sweep, no `oauth_states` clear, no redeem
 * counter) — and counts every table again for the id, children by the ids their parents held at that step's start: any
 * row left is `QaPurgeIncompleteError`, the tables named. A step never deletes a row of another account: every delete is
 * the registry's own scope for this id.
 */
export async function purgeQaStep(db: Db, env: Pick<Env, "ALLOWED_GOOGLE_EMAIL">, target: QaTarget): Promise<QaPurgeStep> {
  await assertQaRow(db, env, target);
  const userId = target.userId;
  const parentIds = await parentIdsOf(db, userId);
  const before = await qaRowCounts(db, userId, { all: true });
  const holding = ACCOUNT_TABLES.filter((t) => (t.scope.kind === "user" || t.scope.kind === "child") && (before[t.name] ?? 0) > 0).sort(
    (a, b) => b.order - a.order,
  );
  const step: typeof holding = [];
  for (const t of holding) {
    if (step.length >= PURGE_DELETES_PER_STEP) break;
    // A parent only with every child of it that still holds rows already in this batch (descending order puts them first).
    const children = holding.filter((c) => c.scope.kind === "child" && c.scope.parent === t.name);
    if (!children.every((c) => step.includes(c))) break;
    step.push(t);
  }
  // The account's phones revoked first, in the batch before its first delete (the review's MINOR-5): a request that reads its
  // device row after this commits is refused 401 `device_revoked`, so nothing a QA phone sends lands once the purge is under
  // way — on rows about to go, or after `done` on an id no loop sees. One statement; it matches nothing on later steps.
  const revoke = db
    .update(nativeDevices)
    .set({ state: "revoked", revokedAt: nowInstant(), revokedReason: "owner_all" })
    .where(and(eq(nativeDevices.userId, userId), ne(nativeDevices.state, "revoked")));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (step.length > 0) await runAtomically(db, [revoke, ...step.map((t) => db.delete(t.table as any).where(scopeWhere(t, userId)))]);
  const removed = Object.fromEntries(step.map((t) => [t.name, before[t.name] ?? 0]));
  if (step.length < holding.length) {
    const left = Object.fromEntries(holding.filter((t) => !step.includes(t)).map((t) => [t.name, before[t.name] ?? 0]));
    return { done: false, removed, remaining: left, total: Object.values(left).reduce((a, b) => a + b, 0) };
  }
  for (const name of ["users", "account_state", "sessions", "native_devices", "native_pairings", "native_pair_limits"]) {
    if ((before[name] ?? 0) > 0) removed[name] = before[name]!;
  }
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
  return { done: true, removed, remaining, total: 0 };
}

/** Every step of the purge, in one call (tests, and a host with no per-request statement budget): the steps' sum. */
export async function purgeQa(db: Db, env: Pick<Env, "ALLOWED_GOOGLE_EMAIL">, target: QaTarget): Promise<QaPurgeStep> {
  const removed: Record<string, number> = {};
  for (let i = 0; i < 20; i++) {
    const step = await purgeQaStep(db, env, target);
    for (const [name, n] of Object.entries(step.removed)) removed[name] = (removed[name] ?? 0) + n;
    if (step.done) return { ...step, removed };
  }
  throw new QaPurgeIncompleteError({ steps: 20 });
}
