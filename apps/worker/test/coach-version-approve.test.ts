/**
 * EXPLICIT OPERATION AND VERSION APPROVAL FROM THE PHONE (R1; DESIGN-3 §3.4.4, §3.5 pairs 16 and 18; §5.3; the lead's v0.20
 * rulings), and the receipts an approve writes.
 *
 * Pinned: the proposal read carries `version`, `complete`, the typed `opsSummary` (exactly its keys, never a title or the
 * coach's words), `receipts` and `takeBackable`; a phone's approve without its version is 403 at the gate and one with a
 * stale version 409 `proposal_changed` with the fresh one, nothing written; with its ops and the version it applies, answers
 * the version it leaves and a receipt per op — written in the op's own batch (a receipt that can't be written leaves no
 * workout) — and the op is then taken back through the receipt; the laptop's approve is as it was (no version needed); a
 * phone never approves or declines the thread coach's proposals. R1.2: a phone may choose a new workout's day and time with
 * `at` — judged as a place's (`approveTimeOf`: the same refusals and words, nothing recorded), its receipt holding the time
 * chosen; one new workout only (two ops, a revise, a move, the laptop's cookie: 400). Synthetic data only.
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
import { AT_NOT_ALLOWED } from "../src/routes/design-proposals.js";
import { nativeTakeBackRoutes } from "../src/routes/native-take-back.js";
import type { DesignedOp } from "../src/services/design-approve.js";
import { clockIn, NO_TIME_LEFT, pastTime } from "../src/services/design-time.js";
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

describe("choosing the time on a phone's approve (R1.2; DESIGN-3 W3, §4.2: the owner picks the time when approving)", () => {
  const receipts = () => w.db.select().from(takeBackReceipts);
  /** One new workout of the coach's at `time` on `day`: the proposal, its op and the version the phone was shown. */
  async function one(day = addDays(T, 2), time = "18:00") {
    const { id, opIds } = await designed([{ doc: calmDoc(), target: { kind: "new", date: day, time } }]);
    return { id, opIds, version: (await read(id)).json.version as string };
  }

  it("a new workout at the day and time the owner chose: placed there, moved from the coach's, its receipt holding that time", async () => {
    const { id, opIds, version } = await one();
    const a = await approve(id, { opIds, version, at: { date: addDays(T, 3), time: "07:15" } });
    expect(a.status, a.text).toBe(200);
    expect(a.json.applied).toEqual([{ opId: opIds[0], workout: expect.objectContaining({ date: addDays(T, 3), time: "07:15" }), moved: true }]);
    const [row] = await rows();
    expect([row!.effectiveDate, row!.effectiveTime]).toEqual([addDays(T, 3), "07:15"]);
    // The receipt is written as for any approve, and holds the row as the chosen time left it.
    const [r] = await receipts();
    expect(r).toMatchObject({ source: "coach_approve", sourceKey: `${id}:${opIds[0]}`, op: "create", madeBy: `device:${v5.id}`, workoutId: row!.id });
    expect(JSON.parse(r!.postState)).toMatchObject({ effective_date: addDays(T, 3), effective_time: "07:15" });
    expect(a.json.receipts).toEqual([{ opId: opIds[0], receiptId: r!.id }]);
  });

  it("time null is any time: the day's own rule places it, as a place's untimed one — today's never before now", async () => {
    const later = await one(addDays(T, 4), "05:10");
    const a = await approve(later.id, { opIds: later.opIds, version: later.version, at: { date: addDays(T, 4), time: null } });
    expect([a.status, a.json.applied?.[0]?.moved], a.text).toEqual([200, true]);
    const placed = (await rows())[0]!;
    expect([placed.effectiveDate, placed.effectiveTime === "05:10"]).toEqual([addDays(T, 4), false]);
    // Today with no time named: the window, or the next quarter hour once it has gone — never before now (09:00 here).
    const today = await one(addDays(T, 2), "18:00");
    const b = await approve(today.id, { opIds: today.opIds, version: today.version, at: { date: T, time: null } });
    expect(b.status, b.text).toBe(200);
    const row = (await rows()).find((x) => x.effectiveDate === T)!;
    expect(row.effectiveTime >= "09:00", row.effectiveTime).toBe(true);
  });

  it("a time gone, no time left or a day gone: refused in the place's own words, nothing written, the op still open", async () => {
    const { id, opIds, version } = await one();
    // 09:00 now: 08:00 today has gone — the words approveTimeOf gives a place.
    const gone = await approve(id, { opIds, version, at: { date: T, time: "08:00" } });
    expect([gone.status, gone.json]).toEqual([422, { error: "past_time", why: pastTime(T, "08:00", clockIn(LA, new Date()))! }]);
    // A day gone: the Studio's own refusal, as a place's.
    const past = await approve(id, { opIds, version, at: { date: addDays(T, -1), time: "07:00" } });
    expect([past.status, past.json.error]).toEqual([422, "past_date"]);
    // Late in the day, untimed today: no quarter hour left.
    vi.setSystemTime(new Date(at(T, "23:55")));
    const late = await approve(id, { opIds, version, at: { date: T, time: null } });
    expect([late.status, late.json]).toEqual([422, { error: "no_time_today", why: NO_TIME_LEFT }]);
    expect([await rows(), await receipts()]).toEqual([[], []]);
    // Nothing was recorded: the same op, at a time still to come, is approved.
    expect((await approve(id, { opIds, version, at: { date: addDays(T, 1), time: "07:00" } })).status).toBe(200);
    expect((await rows()).map((x) => [x.effectiveDate, x.effectiveTime])).toEqual([[addDays(T, 1), "07:00"]]);
  });

  it("at names one new workout, from a phone: two ops, a revise, a move or the laptop's cookie are 400; a stale version 409", async () => {
    const two = await designed([
      { doc: calmDoc({ title: "One" }), target: { kind: "new", date: addDays(T, 2), time: "07:00" } },
      { doc: calmDoc({ title: "Two" }), target: { kind: "new", date: addDays(T, 3), time: "07:00" } },
    ]);
    const v2 = (await read(two.id)).json.version as string;
    const both = await approve(two.id, { opIds: two.opIds, version: v2, at: { date: addDays(T, 2), time: "08:00" } });
    expect([both.status, both.json.error]).toEqual([400, "bad_request"]);
    // The laptop picks a time through Edit before approve: `at` from its cookie is 400.
    const laptop = await approve(two.id, { opIds: [two.opIds[0]], at: { date: addDays(T, 2), time: "08:00" } }, null);
    expect([laptop.status, laptop.json.error]).toEqual([400, "at_not_allowed"]);
    // A revise of a session already there, or a move: never a time of the phone's choosing.
    const { id, opIds } = await designed([{ doc: calmDoc(), target: { kind: "new", date: addDays(T, 2), time: "07:00" } }]);
    const [p] = await w.db.select().from(coachProposals).where(eq(coachProposals.id, id));
    const revise = (p!.ops as DesignedOp[]).map((o) => ({ ...o, target: { kind: "revise", workoutId: "w-there", baseRev: 1 } }));
    const move = {
      kind: "plan_adjust", id: "adj-1", op: { kind: "move", workoutId: "w-there", toDate: addDays(T, 3) }, why: "Later.", issues: [], date: addDays(T, 2),
      row: { date: addDays(T, 2), time: "07:00", title: "Easy run", minutes: 40, category: "easy", origin: null, onWatch: false }, toolUseId: "t-adj", at: nowInstant(),
    };
    await w.db.update(coachProposals).set({ ops: [...revise, move] as never }).where(eq(coachProposals.id, id));
    const v = (await read(id)).json.version as string;
    for (const opId of [opIds[0]!, "adj-1"]) {
      const a = await approve(id, { opIds: [opId], version: v, at: { date: addDays(T, 3), time: "08:00" } });
      expect([opId, a.status, a.json]).toEqual([opId, 400, { error: "at_not_allowed", why: AT_NOT_ALLOWED }]);
    }
    // The version still decides first: a stale one is 409 with the fresh one.
    const stale = await approve(two.id, { opIds: [two.opIds[0]], version: "f".repeat(64), at: { date: addDays(T, 2), time: "08:00" } });
    expect([stale.status, stale.json]).toEqual([409, { error: "proposal_changed", version: v2 }]);
    // Its shape at the gate: a plain object beside the op list and the version — anything else 403.
    for (const body of [{ opIds: [two.opIds[0]], version: v2, at: "tomorrow" }, { opIds: [two.opIds[0]], version: v2, at: {}, extra: 1 }, { opIds: [two.opIds[0]], at: { date: addDays(T, 2), time: null } }]) {
      expect([JSON.stringify(body), (await approve(two.id, body)).json]).toEqual([JSON.stringify(body), { error: "out_of_scope" }]);
    }
    expect([await rows(), await receipts()]).toEqual([[], []]);
  });
});
