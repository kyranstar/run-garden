/**
 * AN ADOPTING REVISE WRITES NO RECEIPT (R1 review B-10): a revise that takes over a coach or imported session (its stage rows
 * deleted, its origin and its watch copy the Studio's) can't be taken back whole — taking it back would restore the
 * document, never the session it took over — so it writes no receipt, and the approve names none for it. A revise of a
 * Studio workout still writes its receipt. Synthetic data only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/services/calendar-sync.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/calendar-sync.js")>()),
  syncCalendar: vi.fn(async () => ({})),
}));

import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, newId, nowInstant } from "@rg/domain";
import { calmDoc } from "./doc-workout-fixture.js";
import { closeKit, T, takeBackKit, type Kit } from "./take-back-kit.js";

let k: Kit;
beforeEach(async () => {
  k = await takeBackKit();
});
afterEach(closeKit);

/** A session of the coach's own plan as coach-apply.ts writes one (origin NULL, a stage row its truth, a document copy at 1). */
async function coachSession(date: string): Promise<string> {
  const id = `cw-${newId().slice(0, 10)}`;
  await k.w.db.insert(schema.plannedWorkouts).values({
    id, userId: k.w.userId, planId: "coach-plan-invented", sourceWorkoutId: id, title: "Coach legs, invented", category: "strength", sport: "strength",
    originalPlanDate: date, lastVerifiedCorosDate: "", effectiveDate: date, effectiveTime: "07:00", sourceContentFingerprint: "coach-invented-fp",
    calendarBlockDurationSeconds: 1800, stageSummary: "Bridge 2×12", completionState: "scheduled", origin: null, workoutDoc: JSON.stringify(calmDoc({ title: "Coach legs, invented" })),
    workoutDocRev: 1, createdAt: nowInstant(), updatedAt: nowInstant(),
  });
  await k.w.db.insert(schema.plannedWorkoutStages).values({ id: `${id}:0`, workoutId: id, parentStageId: null, ord: 0, kind: "work", repeatCount: 2, durationType: "none", label: "Bridge", reps: 12 });
  return id;
}

describe("an adopting revise (B-10)", () => {
  it("writes no receipt: nothing to take back; the session is adopted as before", async () => {
    const id = await coachSession(addDays(T, 1));
    k.tick();
    const receiptId = await k.approvedRevise(id, calmDoc({ title: "Coach calm" }));
    expect(await k.w.db.select().from(schema.takeBackReceipts).where(eq(schema.takeBackReceipts.id, receiptId))).toEqual([]);
    const row = await k.rowOf(id);
    expect([row.origin, row.title]).toEqual(["studio", "Coach calm"]);
    expect((await k.takeBack([receiptId])).json.outcomes[0].outcome).toBe("not_found");
  });

  it("a Studio workout's revise still writes its receipt", async () => {
    const id = await k.onPlan(addDays(T, 1));
    k.tick();
    const receiptId = await k.approvedRevise(id, calmDoc({ title: "Coach calm" }));
    expect((await k.receiptOf(receiptId)).status).toBe("open");
  });
});
