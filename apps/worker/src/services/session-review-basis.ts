/**
 * WHAT THE REVIEW NEEDS OF THE HISTORY, AT START (Phase 2b Task 7; spec §2b "Review and save").
 *
 * The review runs on the phone after the last step — offline, where the history is not — and shows what the session
 * achieved (`Records.forSession`) and the core lifts it topped out (graduation offers). Both read the whole history.
 * So when the athlete starts (online, ruling 2b-R1) the player fetches this once and keeps it on the device:
 *
 *   records     `Records.baseline`: the history folded down to what one more session — on the build's day, playing only
 *               the build's moves and alternatives — can read (bests for those moves, the weeks it touches, the
 *               milestone counters). The review folds the session played onto it: the same answer as the whole
 *               history (packages/session-engine/test/records-baseline.test.ts).
 *   graduation  the program's block (when it is still the build's) and, per core lift the build plays, the newest
 *               logged entries progression reads (`Hist.TRIM.progressionEntries`, ties kept), ids made canonical;
 *               plus the harder moves those lifts graduate to, which the build's slice may not carry.
 *   prefs       the saved 👍 / 👎 / "not for me" of the build's moves, so the review's toggles start from them.
 *
 * A read: nothing is written. 404 for a slot that is not this user's; 409 `not_built` before there is a build.
 */
import { and, eq, inArray } from "drizzle-orm";
import { exercisePrefs, plannedWorkouts, programs } from "@rg/database";
import { adaptiveConfigSchema, type WeightUnit } from "@rg/domain";
import { EXERCISES, type EngineData, type ExerciseRecord } from "@rg/exercise-library";
import { Hist, Records, type Block, type HistorySession, type RecordsState } from "@rg/session-engine";
import { activeProfileIds } from "./condition-views.js";
import { chunkIds, type Db } from "./db.js";
import { loadHistory, loadProgramState } from "./engine-inputs.js";
import { engineDataFor, loadSession, NotBuiltError, SessionNotFoundError, type ExerciseSlice } from "./session-build.js";

export interface ReviewBasis {
  workoutId: string;
  buildId: string;
  records: RecordsState;
  graduation: {
    block: Block | null;
    /** Only the block's lifts' newest logged entries, ids canonical. */
    sessions: HistorySession[];
    unit: WeightUnit;
  };
  /** Saved ratings and "not for me" of the build's moves. */
  prefs: { ratings: Record<string, number>; excluded: string[] };
  /** Harder moves the block's lifts may graduate to that the build's own slice does not carry. */
  exercises: Record<string, ExerciseSlice>;
}

const isProgression = (e: HistorySession["entries"][number] | null | undefined): boolean =>
  Boolean(e && e.id && e.format !== "ladder" && e.format !== "circuit" && (e.sets || []).some(Boolean));

/**
 * The sessions progression reads for these lifts: per lift, the sessions holding its newest logged entries (ties at the
 * cut kept), with only the lifts' entries, under their canonical ids. In the history's order.
 */
export function graduationSessions(data: EngineData, history: readonly HistorySession[], lifts: readonly string[], keepPerLift: number): HistorySession[] {
  const wanted = new Set(lifts.map((id) => Hist.canonical(data, id)));
  const keep = new Set<HistorySession>();
  for (const lift of wanted) {
    const holding = history.filter((s) => (s.entries || []).some((e) => isProgression(e) && Hist.canonical(data, e.id) === lift));
    const keys = holding.map((s) => String(s.startedAt || s.date)).sort((a, b) => b.localeCompare(a));
    const cut = keys[Math.min(keepPerLift, keys.length) - 1];
    if (cut === undefined) continue;
    for (const s of holding) if (String(s.startedAt || s.date) >= cut) keep.add(s);
  }
  return history
    .filter((s) => keep.has(s))
    .map((s) => ({
      ...s,
      done: [],
      entries: (s.entries || [])
        .filter((e) => isProgression(e) && wanted.has(Hist.canonical(data, e.id)))
        .map((e) => ({ ...e, id: Hist.canonical(data, e.id) })),
    }));
}

const sliceOf = (ex: ExerciseRecord): ExerciseSlice => {
  const { providers: _providers, ...rest } = ex;
  return rest;
};

export async function reviewBasis(db: Db, userId: string, workoutId: string, ctx: { today: string; unit: WeightUnit }): Promise<ReviewBasis> {
  const session = await loadSession(db, userId, workoutId, ctx.today);
  const build = session.build;
  if (!build) throw new NotBuiltError();
  const [slot] = await db
    .select({ planId: plannedWorkouts.planId })
    .from(plannedWorkouts)
    .where(and(eq(plannedWorkouts.id, workoutId), eq(plannedWorkouts.userId, userId)))
    .limit(1);
  if (!slot) throw new SessionNotFoundError();
  const [program] = slot.planId
    ? await db.select({ config: programs.config }).from(programs).where(eq(programs.id, slot.planId)).limit(1)
    : [];
  const parsed = adaptiveConfigSchema.safeParse(program?.config ?? {});
  const weeklyGoal = parsed.success ? parsed.data.weeklyGoal : 4;

  const data = engineDataFor(await activeProfileIds(db, userId), []);
  const history = await loadHistory(db, userId);
  const ids = [...new Set([...build.items.map((i) => i.exerciseId), ...Object.values(build.alternatives).flat().map((a) => a.id)])];
  const records = Records.baseline(data, history, { ids, date: build.date, weeklyGoal });

  let block = slot.planId ? await loadProgramState(db, slot.planId) : null;
  if (block && build.blockRef && block.id !== build.blockRef) block = null;
  const lifts = block ? Object.values(block.core).filter((id): id is string => !!id && ids.includes(id)) : [];
  const sessions = graduationSessions(data, history, lifts, Hist.TRIM.progressionEntries);
  const exercises: Record<string, ExerciseSlice> = {};
  for (const lift of lifts) {
    const ex = EXERCISES.find((e) => e.id === lift);
    for (const h of ex?.harder ?? []) {
      const harder = EXERCISES.find((e) => e.id === h);
      if (harder && !build.exercises[harder.id]) exercises[harder.id] = sliceOf(harder);
    }
  }

  const prefRows = [];
  for (const batch of chunkIds(ids)) {
    prefRows.push(
      ...(await db
        .select({ exerciseId: exercisePrefs.exerciseId, rating: exercisePrefs.rating, excluded: exercisePrefs.excluded })
        .from(exercisePrefs)
        .where(and(eq(exercisePrefs.userId, userId), inArray(exercisePrefs.exerciseId, batch)))),
    );
  }
  const ratings: Record<string, number> = {};
  const excluded: string[] = [];
  for (const r of prefRows) {
    if (r.rating) ratings[r.exerciseId] = r.rating;
    if (r.excluded) excluded.push(r.exerciseId);
  }

  return {
    workoutId,
    buildId: build.buildId,
    records,
    graduation: { block, sessions, unit: ctx.unit },
    prefs: { ratings, excluded: excluded.sort() },
    exercises,
  };
}
