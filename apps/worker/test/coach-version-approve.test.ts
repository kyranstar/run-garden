/**
 * EXPLICIT OPERATION AND VERSION APPROVAL FROM THE PHONE (R1; DESIGN-3 §3.4.4, §3.5 pairs 16 and 18; §5.3; the lead's v0.20
 * rulings), and the receipts an approve writes.
 *
 * Pinned: the proposal read carries `version`, `complete`, the typed `opsSummary` (exactly its keys, never a title or the
 * coach's words), `receipts` and `takeBackable`; a phone's approve without its version is 403 at the gate and one with a
 * stale version 409 `proposal_changed` with the fresh one, nothing written; with its ops and the version it applies, answers
 * the version it leaves and a receipt per op — written in the op's own batch (a receipt that can't be written leaves no
 * workout) — and the op is then taken back through the receipt; the laptop's approve is as it was (no version needed); a
 * phone never approves or declines the thread coach's proposals. Synthetic data only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/services/calendar-sync.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/calendar-sync.js")>()),
  syncCalendar: vi.fn(async () => ({})),
}));

import { DateTime } from "luxon";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, newId, nowInstant } from "@rg/domain";
import { coachRoutes } from "../src/routes/coach.js";
import { nativeTakeBackRoutes } from "../src/routes/native-take-back.js";
import type { DesignedOp } from "../src/services/design-approve.js";
import { designProposalId, proposeWorkout, type DocWorkoutTarget } from "../src/services/design-tools/propose.js";
import { isToolErr, type OpReview, type ToolContext } from "../src/services/design-tools/types.js";
import { proposalVersion } from "../src/services/proposal-version.js";
import { receiptIdOf } from "../src/services/take-back.js";
import { calmDoc } from "./doc-workout-fixture.js";
import { nativeWorld, seedDevice, type NativeWorld } from "./native-fixture.js";

const { coachProposals, coachRuns, plannedWorkouts, takeBackReceipts } = schema;

const LA = "America/Los_Angeles";
const T = "2026-11-16";
const at = (date: string, hhmm: string) => DateTime.fromISO(`${date}T${hhmm}`, { zone: LA }).toUTC().toISO()!;
const REVIEW: OpReview = { scores: { intent: 4, sequencing: 4 }, notes: { intent: "Clear." }, mustFix: [], improvements: [], rounds: 1, changes: [] };
const SUMMARY_KEYS = new Set(["opId", "op", "workoutId", "day", "start", "minutesBefore", "minutesAfter", "category", "outcome"]);

let w: NativeWorld;
let v5: { token: string; id: string };

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(at(T, "09:00")));
  vi.stubGlobal("fetch", (async () => new Response("{}", { status: 404 })) as typeof fetch);
  w = await nativeWorld(
    [
      ["/api/coach", coachRoutes],
      ["/api/native", nativeTakeBackRoutes],
    ],
    { env: { COACH_DESIGNER: "1" } },
  );
  v5 = await seedDevice(w.db, w.userId, { scope: "training-v5", lastUsedAt: nowInstant(), expiresAt: "2099-01-01T00:00:00.000Z" });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** A reviewed, pending proposal of `drafts`, its main run ended as `ended` (a finish: `finished`). */
async function designed(drafts: Array<{ doc: object; target: DocWorkoutTarget }>, ended = "finished"): Promise<{ id: string; opIds: string[]; runId: string }> {
  const run = async (role: "main" | "designer", parentId: string | null) => {
    const id = `run-${newId()}`;
    await w.db.insert(coachRuns).values({ id, userId: w.userId, parentId, role, scope: { kind: "week" }, request: null, status: "active", state: null, steps: 0, costUsd: 0, createdAt: nowInstant(), updatedAt: nowInstant() });
    return { id, role, scope: { kind: "week" as const }, parentId, rehearsal: false };
  };
  const main = await run("main", null);
  const opIds: string[] = [];
  for (const d of drafts) {
    const designer = await run("designer", main.id);
    const ctx: ToolContext = { db: w.db, env: w.env, userId: w.userId, run: designer, now: new Date(), toolUseId: `toolu_${newId()}` };
    const res = await proposeWorkout.run(ctx, d);
    if (isToolErr(res)) throw new Error(`propose refused: ${res.error} — ${res.why}`);
    opIds.push(designer.id);
  }
  const id = designProposalId(main.id);
  const [p] = await w.db.select().from(coachProposals).where(eq(coachProposals.id, id));
  await w.db.update(coachProposals).set({ status: "pending", ops: (p!.ops as DesignedOp[]).map((o) => ({ ...o, review: REVIEW })) }).where(eq(coachProposals.id, id));
  // A finished run ended through its finish tool, as a real one does (`state.endedBy`, review B-1).
  await w.db.update(coachRuns).set({ status: ended, ...(ended === "stopped_cap" ? { error: "step_cap" } : {}), ...(ended === "finished" ? { state: JSON.stringify({ v: 1, settings: { ceilingMicros: 1_500_000, maxCalls: 12 }, system: null, messages: [], endedBy: "finish" }) } : {}) }).where(eq(coachRuns.id, main.id));
  return { id, opIds, runId: main.id };
}

/** With the phone's token unless `bearer` is null (the laptop's cookie). */
const read = (id: string, bearer: string | null = v5.token) => w.call("GET", `/api/coach/proposals/${id}`, bearer ? { bearer } : {});
const approve = (id: string, body: unknown, bearer: string | null = v5.token) => w.call("POST", `/api/coach/proposals/${id}/approve`, { ...(bearer ? { bearer } : {}), body });
const rows = () => w.db.select().from(plannedWorkouts);

describe("the proposal read: version, completeness, the typed ops, receipts", () => {
  it("carries a version, complete, and every op as typed fields only — never its title or the coach's words", async () => {
    const day = addDays(T, 2);
    const { id, opIds } = await designed([{ doc: calmDoc({ title: "Jaw care flow" }), target: { kind: "new", date: day, time: "18:00" } }]);
    const a = await read(id);
    expect(a.status, a.text).toBe(200);
    const p = (await w.db.select().from(coachProposals).where(eq(coachProposals.id, id)))[0]!;
    expect(a.json.version).toBe(await proposalVersion(p));
    expect([a.json.complete, a.json.missing]).toEqual([true, undefined]);
    expect(a.json.opsSummary, JSON.stringify(a.json.opsSummary)).toEqual([{ opId: opIds[0], op: "add", day, start: "18:00", minutesAfter: expect.any(Number), category: expect.any(String) }]);
    for (const o of a.json.opsSummary) for (const k of Object.keys(o)) expect(SUMMARY_KEYS.has(k), k).toBe(true);
    expect(JSON.stringify(a.json.opsSummary)).not.toContain("Jaw care flow");
    expect([a.json.receipts, a.json.takeBackable]).toEqual([[], []]);
  });
});

describe("a phone's approve names its ops and the version it was shown", () => {
  it("no version is 403 at the gate, a bare {} too; a stale version is 409 proposal_changed with the fresh one; nothing written", async () => {
    const { id, opIds } = await designed([{ doc: calmDoc(), target: { kind: "new", date: addDays(T, 2), time: "18:00" } }]);
    const version = (await read(id)).json.version as string;
    for (const body of [{ opIds }, {}, { version }]) expect((await approve(id, body)).json).toEqual({ error: "out_of_scope" });
    const stale = await approve(id, { opIds, version: "f".repeat(64) });
    expect([stale.status, stale.json]).toEqual([409, { error: "proposal_changed", version }]);
    expect(await rows()).toEqual([]);
    expect(await w.db.select().from(takeBackReceipts)).toEqual([]);
  });

  it("with its ops and version: applied, the version it leaves, a receipt per op — and the op taken back through it", async () => {
    const day = addDays(T, 2);
    const { id, opIds } = await designed([
      { doc: calmDoc({ title: "One" }), target: { kind: "new", date: day, time: "07:00" } },
      { doc: calmDoc({ title: "Two" }), target: { kind: "new", date: addDays(T, 3), time: "07:00" } },
    ]);
    const version = (await read(id)).json.version as string;
    const a = await approve(id, { opIds: [opIds[0]], version });
    expect(a.status, a.text).toBe(200);
    expect(a.json.applied.map((x: { opId: string }) => x.opId)).toEqual([opIds[0]]);
    const receiptId = await receiptIdOf(w.userId, "coach_approve", `${id}:${opIds[0]}`);
    expect(a.json.receipts).toEqual([{ opId: opIds[0], receiptId }]);
    // The version it answers is the proposal's now: the next round names it, and the old one is stale.
    const after = await read(id);
    expect(a.json.version).toBe(after.json.version);
    expect(after.json.version).not.toBe(version);
    expect(after.json.receipts).toEqual([{ opId: opIds[0], receiptId }]);
    expect(after.json.takeBackable).toEqual([opIds[0]]);
    expect((await approve(id, { opIds: [opIds[1]], version })).json.error).toBe("proposal_changed");
    // The receipt was written with the workout, by the phone, and takes it back.
    const [r] = await w.db.select().from(takeBackReceipts);
    expect(r).toMatchObject({ source: "coach_approve", sourceKey: `${id}:${opIds[0]}`, op: "create", madeBy: `device:${v5.id}`, status: "open" });
    const back = await w.call("POST", "/api/native/take-back", { bearer: v5.token, body: { receiptIds: [receiptId], requestId: "req-1" } });
    expect(back.json.outcomes[0].outcome, back.text).toBe("taken_back");
    expect((await rows()).find((x) => x.id === r!.workoutId)!.archiveReason).toBe("taken_back");
    expect((await read(id)).json.takeBackable).toEqual([]);
  });

  it("the receipt is in the op's own batch: a receipt that can't be written leaves no workout", async () => {
    const { id, opIds } = await designed([{ doc: calmDoc(), target: { kind: "new", date: addDays(T, 2), time: "07:00" } }]);
    const version = (await read(id)).json.version as string;
    const receiptId = await receiptIdOf(w.userId, "coach_approve", `${id}:${opIds[0]}`);
    await w.db.insert(takeBackReceipts).values({ id: receiptId, userId: w.userId, source: "place", sourceKey: "clash", madeBy: "session", workoutId: "w-x", op: "create", groupId: "g", postState: "{}", createdAt: nowInstant(), expiresAt: nowInstant() });
    const a = await approve(id, { opIds, version });
    expect(a.status).toBe(500);
    expect(await rows()).toEqual([]);
  });

  it("the laptop's approve is as it was: no version needed; a stale one it sends is refused the same", async () => {
    const { id, opIds } = await designed([{ doc: calmDoc(), target: { kind: "new", date: addDays(T, 2), time: "07:00" } }]);
    expect((await approve(id, { opIds, version: "e".repeat(64) }, null)).json.error).toBe("proposal_changed");
    const a = await approve(id, {}, null);
    expect([a.status, a.json.applied?.length], a.text).toEqual([200, 1]);
    expect((await w.db.select().from(takeBackReceipts))[0]!.madeBy).toBe("session");
  });

  it("the thread coach's proposals are the laptop's: a phone's approve and decline are 409 not_designed, nothing written", async () => {
    await w.db.insert(coachProposals).values({ id: "thread-1", userId: w.userId, planId: null, title: "Lighter week", evidence: "", rationale: "", flags: [], ops: [{ kind: "skip", workoutId: "w-1" }], status: "pending", createdAt: nowInstant(), expiresAt: addDays(T, 3) } as never);
    const a = await approve("thread-1", { opIds: ["x"], version: "a".repeat(64) });
    expect([a.status, a.json]).toEqual([409, { error: "not_designed" }]);
    const d = await w.call("POST", "/api/coach/proposals/thread-1/decline", { bearer: v5.token, body: {} });
    expect([d.status, d.json]).toEqual([409, { error: "not_designed" }]);
    expect((await w.db.select().from(coachProposals).where(eq(coachProposals.id, "thread-1")))[0]!.status).toBe("pending");
  });
});
