/**
 * THE READ-BACK FOR THE LIVE GATE (Phase 3 Task 11; spec §8; plan Task 12 Step 5).
 *
 * After the first real push the owner's account is read back twice, straight from COROS — never the cached read-now,
 * which single-flights on a 90 s window, so a second call would only repeat the first. This answers, for one slot:
 * is the program carrying its push's stamp on the row's recorded day; its steps as stored (the names, overviews and
 * targets this app wrote — never another workout's); whether each step equals the preview the push was built from;
 * and whether its text fingerprint is the one the push observed (the import's "Changed in COROS" test).
 *
 * Read-only: one schedule read through the same cloud client every COROS read uses. Nothing is stored.
 */
import { and, desc, eq } from "drizzle-orm";
import { corosWriteJobs, plannedWorkouts } from "@rg/database";
import { addDays, programSessionPushJobSchema, type ProgramSessionPushJob } from "@rg/domain";
import {
  buildProgramWatchProgram,
  FREE_TEXT_ORIGIN_ID,
  planView,
  previewOfProgram,
  spikeStepFields,
  stampedPlacements,
  type ProgramPreviewStep,
  type SpikeStepFields,
} from "@rg/coros";
import { COROS_EXERCISE_NAMES, localDateToCorosDay, programTextFingerprint, type RawCorosProgram } from "@rg/providers";
import type { Env } from "../env.js";
import type { Db } from "./db.js";
import { corosClient } from "./coros-connection.js";

export interface ProgramReadback {
  /** Our stamped placement found on the row's recorded day. */
  found: boolean;
  date: string | null;
  /** Our own steps only (names, overviews, targets we wrote) — never another workout's data. */
  steps: SpikeStepFields[];
  /** Per step: equal to the preview the push was built from. */
  matchesPreview: boolean[];
  textFingerprintMatches: boolean;
}

/** No push of this slot to read back. */
export class NoPushError extends Error {
  constructor() {
    super("no_push");
  }
}

/** COROS is not connected for this account (or its credentials were refused). */
export class ReadbackNotConnectedError extends Error {
  constructor() {
    super("not_connected");
  }
}

/** The slot's newest push and its payload. */
async function newestPush(db: Db, userId: string, workoutId: string): Promise<ProgramSessionPushJob | null> {
  const rows = await db
    .select({ payload: corosWriteJobs.payload })
    .from(corosWriteJobs)
    .where(and(eq(corosWriteJobs.userId, userId), eq(corosWriteJobs.workoutId, workoutId), eq(corosWriteJobs.kind, "program_session_push")))
    .orderBy(desc(corosWriteJobs.requestedAt))
    .limit(1);
  const parsed = rows[0] ? programSessionPushJobSchema.safeParse(rows[0].payload) : null;
  return parsed?.success ? parsed.data : null;
}

/** The program the push wrote, built again from its own payload (each catalog step's id → the T-code it carries). */
function sentProgram(push: ProgramSessionPushJob): RawCorosProgram {
  const catalog = new Map(push.session.steps.filter((s) => s.originId !== FREE_TEXT_ORIGIN_ID).map((s) => [s.originId, s.name]));
  return buildProgramWatchProgram({ happenDay: String(localDateToCorosDay(push.happenDay)), name: push.name, session: push.session }, catalog);
}

const englishName = (key: string): string | undefined => COROS_EXERCISE_NAMES[key];
const sameStep = (a: ProgramPreviewStep | undefined, b: ProgramPreviewStep | undefined): boolean =>
  !!a && !!b && JSON.stringify(a) === JSON.stringify(b);

/**
 * `GET /api/coros/debug/program-readback/:workoutId`. Throws `NoPushError` (404) when the slot was never sent, and
 * `ReadbackNotConnectedError` (409) without a COROS connection.
 */
export async function programReadback(
  db: Db,
  env: Env,
  userId: string,
  workoutId: string,
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<ProgramReadback> {
  const [row] = await db
    .select({ lastVerifiedCorosDate: plannedWorkouts.lastVerifiedCorosDate })
    .from(plannedWorkouts)
    .where(and(eq(plannedWorkouts.id, workoutId), eq(plannedWorkouts.userId, userId)))
    .limit(1);
  const push = row ? await newestPush(db, userId, workoutId) : null;
  if (!row || !push) throw new NoPushError();
  const client = await corosClient(db, env, userId, opts.fetchImpl ?? fetch);
  if (!client) throw new ReadbackNotConnectedError();

  // The row's recorded day — or, with none (taken off, removed), the day the push was for.
  const day = row.lastVerifiedCorosDate || push.happenDay;
  const raw = await client.getRawSchedule(addDays(day, -3), addDays(day, 3));
  const plans = [...new Set([...(raw.entities ?? []), ...(raw.programs ?? [])].map((r) => String(r.planId ?? "")))];
  const found = plans
    .flatMap((planId) => stampedPlacements(planView(raw, planId), (name) => name === push.name))
    .find((f) => f.date === day && f.program);
  if (!found?.program) return { found: false, date: null, steps: [], matchesPreview: [], textFingerprintMatches: false };

  const sent = sentProgram(push);
  const want = previewOfProgram(sent, englishName);
  const got = previewOfProgram(found.program, englishName);
  const steps = spikeStepFields(found.program);
  return {
    found: true,
    date: found.date,
    steps,
    matchesPreview: steps.map((_, i) => sameStep(got[i], want[i])),
    textFingerprintMatches: programTextFingerprint(found.program) === (push.observed?.text ?? programTextFingerprint(sent)),
  };
}
