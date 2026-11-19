/**
 * The take-back suites' world (R1 review fixes; scaffolding as take-back.test.ts and Review B's attacks): a v5 phone, a saved
 * workout to place, and receipts written as the writers write them — a place through its route; an approve's move, skip
 * and revision through run-garden's own writers with the receipt in the write's batch, as design-approve.ts writes them,
 * made by the phone (`device:<id>`) unless a test says otherwise. Synthetic data only.
 */
import { expect, vi } from "vitest";
import { DateTime } from "luxon";
import { eq, sql } from "drizzle-orm";
import { schema } from "@rg/database";
import { newId, nowInstant } from "@rg/domain";
import { nativeLibraryRoutes } from "../src/routes/native-library.js";
import { nativeTakeBackRoutes } from "../src/routes/native-take-back.js";
import { planRoutes } from "../src/routes/plan.js";
import { workoutRoutes } from "../src/routes/workouts.js";
import { loadPreferences } from "../src/services/calendar-sync.js";
import { createDocWorkout, reviseDocWorkout } from "../src/services/doc-workouts.js";
import { applyMove } from "../src/services/jobs.js";
import { skipWorkout } from "../src/services/plan-mutations.js";
import { receiptExpiry, receiptIdOf, receiptInsert, type ReceiptSpec } from "../src/services/take-back.js";
import { calmDoc } from "./doc-workout-fixture.js";
import { nativeWorld, seedDevice, type NativeWorld } from "./native-fixture.js";

const { plannedWorkouts, takeBackReceipts, workoutTemplates } = schema;

export const LA = "America/Los_Angeles";
export const T = "2026-11-16"; // a Monday
export const at = (date: string, hhmm: string) => DateTime.fromISO(`${date}T${hhmm}`, { zone: LA }).toUTC().toISO()!;

export interface Kit {
  w: NativeWorld;
  v5: { token: string; id: string };
  place(date: string, time: string | null, clientId: string): Promise<{ workoutId: string; receiptId: string; time: string }>;
  takeBack(receiptIds: string[], requestId?: string, bearer?: string): Promise<{ status: number; json: any; text: string; statements: string[] }>;
  rowOf(id: string): Promise<typeof plannedWorkouts.$inferSelect>;
  receiptOf(id: string): Promise<typeof takeBackReceipts.$inferSelect>;
  onPlan(date: string, time?: string, doc?: object): Promise<string>;
  approvedMove(workoutId: string, toDate: string, toTime: string, over?: Partial<ReceiptSpec>): Promise<string>;
  approvedSkip(workoutId: string, over?: Partial<ReceiptSpec>): Promise<string>;
  approvedRevise(workoutId: string, doc: object, over?: Partial<ReceiptSpec>): Promise<string>;
  tick(ms?: number): void;
}

/** The world, at 09:00 on T in Los Angeles (fake Date), the fetches stubbed. Call in `beforeEach`. */
export async function takeBackKit(): Promise<Kit> {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(at(T, "09:00")));
  vi.stubGlobal("fetch", (async () => new Response("{}", { status: 404 })) as typeof fetch);
  const w = await nativeWorld([
    ["/api/native", nativeLibraryRoutes],
    ["/api/native", nativeTakeBackRoutes],
    ["/api/plan", planRoutes],
    ["/api/workouts", workoutRoutes],
  ]);
  const v5 = await seedDevice(w.db, w.userId, { scope: "training-v5", lastUsedAt: nowInstant(), expiresAt: "2099-01-01T00:00:00.000Z" });
  await w.db.insert(workoutTemplates).values({
    id: "t-hips", userId: w.userId, name: "Hip reset", doc: JSON.stringify(calmDoc()), pinned: false, uses: 0, lastUsedAt: null, createdAt: at("2026-11-01", "09:00"), updatedAt: at("2026-11-01", "09:00"),
  });
  const rowOf = async (id: string) => (await w.db.select().from(plannedWorkouts).where(eq(plannedWorkouts.id, id)))[0]!;
  const ctx = async () => ({ today: DateTime.fromJSDate(new Date(), { zone: LA }).toISODate()!, now: nowInstant(), prefs: await loadPreferences(w.db, w.userId) });
  const approveSpec = async (key: string, op: ReceiptSpec["op"], date: string, over: Partial<ReceiptSpec> = {}): Promise<ReceiptSpec> => ({
    id: await receiptIdOf(w.userId, "coach_approve", key),
    userId: w.userId,
    source: "coach_approve",
    sourceKey: key,
    madeBy: `device:${v5.id}`,
    op,
    groupId: over.groupId ?? `g-${key}`,
    dependsOn: [],
    preState: null,
    effects: [],
    expiresAt: receiptExpiry(nowInstant(), date, LA),
    ...over,
  });
  return {
    w,
    v5,
    async place(date, time, clientId) {
      const a = await w.call("POST", "/api/native/templates/t-hips/place", { bearer: v5.token, body: { date, clientId, ...(time ? { time } : {}) } });
      expect(a.status, a.text).toBe(201);
      return a.json as { workoutId: string; receiptId: string; time: string };
    },
    takeBack: (receiptIds, requestId = `req-${newId()}`, bearer = v5.token) => w.call("POST", "/api/native/take-back", { bearer, body: { receiptIds, requestId } }),
    rowOf,
    receiptOf: async (id) => (await w.db.select().from(takeBackReceipts).where(eq(takeBackReceipts.id, id)))[0]!,
    async onPlan(date, time = "07:00", doc = calmDoc()) {
      return (await createDocWorkout(w.db, w.userId, { date, time, doc, clientId: `seed-${newId()}` }, await ctx())).workout.id;
    },
    async approvedMove(workoutId, toDate, toTime, over = {}) {
      const row = await rowOf(workoutId);
      const spec = await approveSpec(`p:move-${newId()}`, "move", toDate, { preState: { date: row.effectiveDate, time: row.effectiveTime }, ...over });
      await applyMove(w.db, { userId: w.userId, workoutId, toDate, toTime, source: "app", corosWritesEnabled: false, onlyIf: sql`1 = 1`, alsoInBatch: receiptInsert(w.db, spec) });
      return spec.id;
    },
    async approvedSkip(workoutId, over = {}) {
      const row = await rowOf(workoutId);
      const spec = await approveSpec(`p:skip-${newId()}`, "skip", row.effectiveDate, { preState: { date: row.effectiveDate }, ...over });
      const c = await ctx();
      const out = await skipWorkout(w.db, w.userId, workoutId, { now: c.now, today: c.today, source: "coach", sanctionedBy: "coach", prefs: c.prefs, onlyIf: sql`1 = 1`, alsoInBatch: receiptInsert(w.db, spec) });
      expect(out.skipped).toBe(true);
      return spec.id;
    },
    async approvedRevise(workoutId, doc, over = {}) {
      const row = await rowOf(workoutId);
      const spec = await approveSpec(`p:rev-${newId()}`, "revise", row.effectiveDate, { preState: { rev: row.workoutDocRev }, ...over });
      await reviseDocWorkout(w.db, w.userId, workoutId, { doc, baseRev: row.workoutDocRev! }, await ctx(), { sourceKind: "coach" }, { alsoInBatch: receiptInsert(w.db, spec) });
      return spec.id;
    },
    tick: (ms = 5) => vi.setSystemTime(new Date(Date.now() + ms)),
  };
}

export function closeKit(): void {
  vi.useRealTimers();
  vi.unstubAllGlobals();
}
