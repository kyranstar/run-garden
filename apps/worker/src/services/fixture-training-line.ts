/**
 * Fixture mode only (training lines, the end-to-end journey): what a coach that built a running plan in two phases
 * leaves in an account — two abutting run blocks, "Base" (this week and next) and "Build" (the two weeks after),
 * each with a few sessions — and a one-off the coach put on the calendar last Wednesday, outside both. Written by the
 * coach's own appliers (`applyStructuralChunk`'s createPlan, `applyOps`' add), so each row is what the app writes, and
 * the one-off lands in the loose `adhoc-run-…` bucket by the app's own rule. No watch writes, no model call, nothing
 * sent anywhere. Synthetic titles. Applied again it does nothing twice, and answers the same: every id is the
 * proposal's, and the one-off is read back by its own (`cw-<proposal>-<op>-<n>`, the applier's).
 *
 * It answers what a "Stop this plan" would take off the calendar (`stopCount`): the phases' sessions still scheduled,
 * dated today or later — the count the journey's confirm must say.
 */
import { and, eq, gte, inArray, isNull, ne, sql } from "drizzle-orm";
import { plannedWorkouts } from "@rg/database";
import { addDays, startOfIsoWeek, todayInZone, type CoachOp, type CoachSession, type LocalDate, type UserPreferences } from "@rg/domain";
import { applyOps, applyStructuralChunk, type StructuralProgress } from "./coach-apply.js";
import type { Db } from "./db.js";

export interface TrainingLineSeeded {
  /** The ids of the two phases, in order. */
  phases: string[];
  /** The one-off's session id. */
  oneOff: string;
  /** The one-off's title and day. */
  oneOffTitle: string;
  oneOffDate: LocalDate;
  /** The sessions "Stop this plan" takes off: the phases' still scheduled, today or later (not a rest day). */
  stopCount: number;
}

const run = (title: string, minutes: number, category: "easy" | "long"): CoachSession =>
  ({ category, title, durationMinutes: minutes, run: { blocks: [{ kind: "duration", value: minutes, intensity: "easy" }] } }) as CoachSession;

export async function seedTrainingLine(db: Db, userId: string, prefs: UserPreferences, now: Date): Promise<TrainingLineSeeded> {
  // Quiet: the watch is never written to, whatever the account has on.
  const quiet: UserPreferences = { ...prefs, corosWritesEnabled: false };
  const today = todayInZone(prefs.timezone, now);
  const monday = startOfIsoWeek(today);
  const key = userId.slice(0, 8);
  const phases: string[] = [];
  const phase = async (tag: string, name: string, from: LocalDate) => {
    const proposalId = `fxline-${key}-${tag}`;
    const op: CoachOp = {
      kind: "createPlan",
      discipline: "run",
      name,
      startDate: from,
      endDate: addDays(from, 13),
      firmSessions: [1, 3, 5, 8, 10, 12].map((d, i) => ({ date: addDays(from, d), session: run(`${name} run ${i + 1}`, 30 + 5 * i, i % 3 === 2 ? "long" : "easy") })),
      shapeWeeks: [],
    } as CoachOp;
    let progress: StructuralProgress | null = null;
    for (let i = 0; i < 50; i++) {
      const r = await applyStructuralChunk(db, { userId, proposalId, opIndex: 0, op, progress, budget: 40, now, prefs: quiet });
      if (r.status === "refused") throw new Error(`the fixture's phase was refused: ${r.reason}`);
      if (r.status === "done") break;
      progress = r.progress;
    }
    phases.push(`cp-${proposalId}-0`);
  };
  await phase("a", "Base", monday);
  await phase("b", "Build", addDays(monday, 14));

  const oneOffDate = addDays(monday, -5);
  const oneOffTitle = "Shake-out jog";
  const proposalId = `fxline-${key}-one`;
  await applyOps(db, userId, quiet, proposalId, [{ kind: "add", date: oneOffDate, session: run(oneOffTitle, 25, "easy") } as CoachOp]);
  // Read back by its own id (op 0, its first date), so a second call answers it too.
  const [oneOff] = await db
    .select({ id: plannedWorkouts.id })
    .from(plannedWorkouts)
    .where(and(eq(plannedWorkouts.userId, userId), eq(plannedWorkouts.id, `cw-${proposalId}-0-0`)))
    .limit(1);
  if (!oneOff) throw new Error("the fixture's one-off was not written");

  const [ahead] = await db
    .select({ n: sql<number>`count(*)` })
    .from(plannedWorkouts)
    .where(
      and(
        eq(plannedWorkouts.userId, userId),
        inArray(plannedWorkouts.planId, phases),
        gte(plannedWorkouts.effectiveDate, today),
        isNull(plannedWorkouts.archivedAt),
        eq(plannedWorkouts.completionState, "scheduled"),
        ne(plannedWorkouts.category, "rest"),
      ),
    );
  return { phases, oneOff: oneOff.id, oneOffTitle, oneOffDate, stopCount: Number(ahead?.n ?? 0) };
}
