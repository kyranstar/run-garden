/**
 * WHAT REVIEW B FOUND SOUND, KEPT (its RB-9, RB-10, RB-11 on the fixed head):
 *  - a receipt whose row is gone (a restore-like reset) is refused changed_since, touching nothing;
 *  - state equality, not history: a place edited away on the laptop and back is taken back;
 *  - each op's single take-back stays within its declared cost — the request's fixed part, the op's preflight and its
 *    write — and within the request's 45 statements, on a busy day too.
 * Synthetic data only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/services/calendar-sync.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/calendar-sync.js")>()),
  syncCalendar: vi.fn(async () => ({})),
}));

import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays } from "@rg/domain";
import { TAKE_BACK_BUDGET, TAKE_BACK_COST, TAKE_BACK_FIXED, TAKE_BACK_PREFLIGHT } from "../src/services/take-back.js";
import { landingsDoc } from "./doc-workout-fixture.js";
import { closeKit, T, takeBackKit, type Kit } from "./take-back-kit.js";

let k: Kit;
beforeEach(async () => {
  k = await takeBackKit();
});
afterEach(closeKit);

describe("review B's sound cases, on the fixed head", () => {
  it("RB-9: a receipt whose row is gone is refused, touching nothing", async () => {
    const { workoutId, receiptId } = await k.place(addDays(T, 1), "07:00", "c-gone");
    await k.w.db.delete(schema.plannedWorkouts).where(eq(schema.plannedWorkouts.id, workoutId));
    const res = await k.takeBack([receiptId]);
    expect([res.json.outcomes[0].outcome, res.json.outcomes[0].error, res.json.outcomes[0].now]).toEqual(["refused", "changed_since", null]);
    expect(res.writes).toEqual([]);
  });

  it("RB-10: edited away on the laptop and back is taken back (state equality, not history)", async () => {
    const { workoutId, receiptId } = await k.place(addDays(T, 2), "18:00", "c-aba");
    k.tick();
    expect((await k.w.call("POST", `/api/plan/workouts/${workoutId}/move`, { body: { toDate: addDays(T, 4), toTime: "07:00" } })).status).toBe(200);
    k.tick();
    expect((await k.w.call("POST", `/api/plan/workouts/${workoutId}/move`, { body: { toDate: addDays(T, 2), toTime: "18:00" } })).status).toBe(200);
    k.tick();
    expect((await k.takeBack([receiptId])).json.outcomes[0].outcome).toBe("taken_back");
  });

  it("RB-11: each op's take-back within its declared cost and the request's budget, on a busy day", async () => {
    const spent: Record<string, number> = {};
    const a = await k.onPlan(addDays(T, 1), "07:00");
    for (let i = 0; i < 4; i++) await k.onPlan(addDays(T, 1), `1${i}:00`);
    k.tick();
    const rev = await k.approvedRevise(a, landingsDoc({ alternates: false, title: "Longer one" }));
    k.tick();
    spent.revise = (await k.takeBack([rev])).statements.length;
    const b = await k.onPlan(addDays(T, 2), "07:00");
    k.tick();
    const mv = await k.approvedMove(b, addDays(T, 3), "18:00");
    k.tick();
    spent.move = (await k.takeBack([mv])).statements.length;
    const c = await k.onPlan(addDays(T, 2), "12:00");
    k.tick();
    const sk = await k.approvedSkip(c);
    k.tick();
    spent.skip = (await k.takeBack([sk])).statements.length;
    const p = await k.place(addDays(T, 4), "07:00", "c-cost");
    k.tick();
    spent.create = (await k.takeBack([p.receiptId])).statements.length;
    for (const [op, n] of Object.entries(spent)) {
      const declared = TAKE_BACK_FIXED + TAKE_BACK_PREFLIGHT[op as keyof typeof TAKE_BACK_COST] + TAKE_BACK_COST[op as keyof typeof TAKE_BACK_COST];
      expect([op, n <= declared, n <= TAKE_BACK_BUDGET], `${op}: ${n} statements, declared ${declared}`).toEqual([op, true, true]);
    }
  });
});
