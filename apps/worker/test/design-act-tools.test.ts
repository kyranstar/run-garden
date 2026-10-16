/**
 * THE COACH DESIGNER'S ACT TOOLS (Stage 3 Task 5; spec §4 "Act", §5, §7, §8, §9; principles §6.1, §6.2, §6.7): what each
 * one does, and every way each one refuses. Called directly with the loop's context (design-tools/types.ts); the loop
 * around them is design-act-loop.test.ts, the registry and the budgets design-act-budget.test.ts.
 *
 * Synthetic data only: the made-up athlete of design-read-fixture.ts, on its fixed clock.
 */
import { beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import { and, eq, like } from "drizzle-orm";
import { schema } from "@rg/database";
import { newId, NO_EQUIPMENT_PLACE, workoutDocSchema } from "@rg/domain";
import { EXERCISES } from "@rg/exercise-library";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { readingsOfDay } from "../src/services/condition-views.js";
import { buildDesignContext } from "../src/services/design-context.js";
import { ACT_TOOLS } from "../src/services/design-tools/index.js";
import { docValidateCtx, readDocAthlete, unwrapUntrusted, WORKOUT_DOC_JSON_SCHEMA } from "../src/services/design-tools/act-common.js";
import { searchLibraryTool } from "../src/services/design-tools/read-library.js";
import { RESULT_BUDGET_BYTES } from "../src/services/design-tools/read-common.js";
import { defaultPlace } from "../src/services/default-place.js";
import { listLibrary } from "../src/services/library-view.js";
import { designProposalId, type DocWorkoutOp } from "../src/services/design-tools/propose.js";
import { markedDoc } from "../src/services/design-tools/read-workouts.js";
import { recallMemory } from "../src/services/design-tools/read-memory.js";
import { readAnswers } from "../src/services/design-tools/read-answers.js";
import { askedAnswerRows } from "../src/services/design-tools/record-answer.js";
import { isToolErr, type DesignReview, type DesignTool, type ReviewHooks, type ReviewStart, type ToolContext, type ToolErr, type ToolOk, type ToolRole } from "../src/services/design-tools/types.js";
import { docDayContext } from "../src/services/doc-workouts.js";
import { at, day, NOW, seedRichAthlete, studioDoc, TODAY } from "./design-read-fixture.js";
import { calmDoc, landingsDoc } from "./doc-workout-fixture.js";
import { isWrite, makeTestDb, makeTestUser } from "./helpers.js";

const ENV = {} as Env;

let db: Db;
const statements: string[] = [];
let rich: Awaited<ReturnType<typeof seedRichAthlete>>;
/** The same athlete, with a pre-check of 7 at 08:30 today: jumps are closed today (TMJ: calm is 2 or less). */
let high: Awaited<ReturnType<typeof seedRichAthlete>>;

beforeAll(async () => {
  db = makeTestDb({ boundVariableCap: 100, onStatement: (s) => statements.push(s) });
  rich = await seedRichAthlete(db);
  high = await seedRichAthlete(db);
  await db.insert(schema.conditionChecks).values([
    { id: newId(), userId: high.userId, profileId: "tmj", kind: "pre", value: 7, localDate: TODAY, at: at(TODAY, "08:30") },
    // Later, but no answer: never the day's reading.
    { id: newId(), userId: high.userId, profileId: "tmj", kind: "daily", value: null, feelingOff: false, localDate: TODAY, at: at(TODAY, "09:00") },
  ]);
});

const tool = (name: string): DesignTool => ACT_TOOLS.find((t) => t.name === name)!;

let runSeq = 0;
/** A run row of the athlete's (the tools read the request and the run's tree from it). */
async function run(
  o: { userId?: string; role?: ToolRole; request?: string | null; scope?: ToolContext["run"]["scope"]; parentId?: string | null; rehearsal?: boolean } = {},
): Promise<ToolContext["run"] & { userId: string }> {
  const id = `run-${++runSeq}-${newId().slice(0, 8)}`;
  const userId = o.userId ?? rich.userId;
  const role = o.role ?? "main";
  const scope = o.scope ?? { kind: "now" };
  await db.insert(schema.coachRuns).values({
    id, userId, parentId: o.parentId ?? null, role, scope: { ...scope }, request: o.request === undefined ? "a short session at home" : o.request,
    status: "active", state: null, steps: 0, costUsd: 0, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
  });
  return { id, role, scope, parentId: o.parentId ?? null, rehearsal: o.rehearsal === true, userId };
}

let useSeq = 0;
function ctxOf(r: Awaited<ReturnType<typeof run>>, extra: Partial<ToolContext> = {}): ToolContext {
  const { userId, ...runPart } = r;
  return { db, env: ENV, userId, run: runPart, now: NOW, toolUseId: `toolu_${++useSeq}`, ...extra };
}

async function call(name: string, c: ToolContext, input: unknown): Promise<{ result: ToolOk | ToolErr; writes: string[]; count: number }> {
  statements.length = 0;
  const result = await tool(name).run(c, input);
  return { result, writes: statements.filter(isWrite), count: statements.length };
}

const ok = (r: ToolOk | ToolErr): ToolOk => {
  if (isToolErr(r)) throw new Error(`refused: ${r.error} — ${r.why}`);
  return r;
};
const err = (r: ToolOk | ToolErr): ToolErr => {
  if (!isToolErr(r)) throw new Error(`expected a refusal, got ${JSON.stringify(r.data).slice(0, 300)}`);
  return r;
};
const data = (r: ToolOk | ToolErr): any => ok(r).data;

const item = (libraryId: string, dose: Record<string, unknown> = { sets: 2, reps: 8, restSec: 45 }) => ({ kind: "exercise", libraryId, dose });
function docOf(items: unknown[], over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    title: "Coach test",
    intent: { summary: "Wake the hips, then load the legs.", goals: ["strength"], focus: [], effort: "maintain" },
    parts: [{ purpose: "main", format: "straight", items }],
    source: { kind: "coach" },
    ...over,
  };
}

async function proposal(mainRunId: string) {
  const [p] = await db.select().from(schema.coachProposals).where(eq(schema.coachProposals.id, designProposalId(mainRunId)));
  return p ? { ...p, ops: p.ops as DocWorkoutOp[] } : undefined;
}

// ── The day a document is checked for ───────────────────────────────────────────────────────────────────────────────

describe("the day's reading — one rule for the opening context and the validator", () => {
  it("readingsOfDay is the latest answered check per profile; a later unanswered one never counts", () => {
    const rows = [
      { id: "a", profileId: "tmj", at: "2026-05-13T14:40:00Z", value: 2, feelingOff: false },
      { id: "b", profileId: "tmj", at: "2026-05-13T15:30:00Z", value: 7, feelingOff: false },
      { id: "c", profileId: "tmj", at: "2026-05-13T16:00:00Z", value: null, feelingOff: false },
      { id: "d", profileId: "other", at: "2026-05-13T17:00:00Z", value: 1, feelingOff: false },
    ];
    expect(readingsOfDay(rows, ["tmj"]).get("tmj")?.id).toBe("b");
    expect([...readingsOfDay(rows, ["tmj"]).keys()]).toEqual(["tmj"]);
    expect(readingsOfDay([{ ...rows[2]! }], ["tmj"]).has("tmj")).toBe(false);
  });

  it("the header says 7 at 08:30, and the validator's day reads 7: a jump is refused today, as the header's rule says", async () => {
    const r = await run({ userId: high.userId });
    const context = await buildDesignContext(db, ENV, high.userId, { id: r.id, role: "main", scope: { kind: "now" }, request: null, parentId: null }, NOW);
    expect(context.header).toContain("Today's: 7 at 08:30.");
    const a = await readDocAthlete(ctxOf(r), {});
    if ("error" in a) throw new Error(a.why);
    const vctx = await docValidateCtx(ctxOf(r), a, TODAY);
    expect(vctx.day?.readings.tmj).toEqual({ pre: 7, post: null, feelingOff: false });
    const v = data((await call("validate_workout", ctxOf(r), { doc: landingsDoc(), date: TODAY })).result);
    expect(v.valid).toBe(false);
    expect(v.errors.map((e: { path: string; code: string }) => `${e.path} ${e.code}`)).toContain("parts[0].items[0].libraryId condition_gate");
    // The calm athlete (2 at 07:40): the same jump is allowed today.
    const calm = await run();
    expect(data((await call("validate_workout", ctxOf(calm), { doc: landingsDoc(), date: TODAY })).result).valid).toBe(true);
  });

  it("an athlete whose last session was weeks ago: the last session is still the create path's, and the week is empty", async () => {
    const userId = (await makeTestUser(db, { timezone: "America/Los_Angeles" })).userId;
    for (const n of [40, 20]) {
      await db.insert(schema.performedSessions).values({
        id: newId(), userId, source: "app", localDate: day(n), startedAt: at(day(n), "07:00"), seconds: 900, minutes: 15, completed: true,
        movesDone: [{ exerciseId: "catCow", seconds: 120 }], payloadHash: `old-${n}`, createdAt: at(day(n)), updatedAt: at(day(n)),
      });
    }
    const r = await run({ userId });
    const a = await readDocAthlete(ctxOf(r), {});
    if ("error" in a) throw new Error(a.why);
    const mine = await docValidateCtx(ctxOf(r), a, TODAY);
    const theirs = await docDayContext(db, userId, { date: TODAY, today: TODAY, workoutId: "none" });
    expect(mine.day!.recent!.last?.date).toBe(day(20));
    expect(JSON.stringify(mine.day!.recent)).toBe(JSON.stringify(theirs.day!.recent));
    expect(mine.day!.recent!.week).toEqual([]);
  });

  it("done and recent are the create path's own (docDayContext): the same moves done cleanly, the same last session and week", async () => {
    const r = await run();
    const a = await readDocAthlete(ctxOf(r), {});
    if ("error" in a) throw new Error(a.why);
    const mine = await docValidateCtx(ctxOf(r), a, TODAY);
    const theirs = await docDayContext(db, rich.userId, { date: TODAY, today: TODAY, workoutId: "none" });
    expect([...(mine.day!.done ?? [])].sort()).toEqual([...(theirs.day!.done ?? [])].sort());
    expect(mine.day!.done!.size).toBeGreaterThan(0);
    expect(JSON.stringify(mine.day!.recent)).toBe(JSON.stringify(theirs.day!.recent));
    expect(mine.day!.recent!.week.length).toBeGreaterThan(1);
    expect(mine.excluded).toEqual(["splitSquat"]);
  });
});

// ── validate_workout ────────────────────────────────────────────────────────────────────────────────────────────────

describe("validate_workout", () => {
  it("a sound draft: no errors, its derived minutes and balance, provenance — and it writes nothing", async () => {
    const r = await run();
    const { result, writes } = await call("validate_workout", ctxOf(r), { doc: calmDoc(), date: TODAY });
    const v = data(result);
    expect(writes).toEqual([]);
    expect(v).toMatchObject({ date: TODAY, valid: true, errors: [] });
    expect(v.derived.minutes).toBeGreaterThan(0);
    expect(v.derived.discipline).toBeTruthy();
    expect(Object.keys(v.derived.balance).length).toBeGreaterThan(0);
    expect(ok(result).provenance?.source).toMatch(/validator/);
    expect(ok(result).summary).toMatch(/no errors/i);
  });

  it("is idempotent: the same call answers the same", async () => {
    const r = await run();
    const one = data((await call("validate_workout", ctxOf(r), { doc: landingsDoc(), date: day(-2) })).result);
    const two = data((await call("validate_workout", ctxOf(r), { doc: landingsDoc(), date: day(-2) })).result);
    expect(two).toEqual(one);
  });

  it("an unknown exercise is an error with a fix; a set-aside move and missing gear are advisory", async () => {
    const r = await run();
    const kettle = EXERCISES.find((e) => e.equipment.all.length === 1 && e.equipment.all[0] === "kettlebell")!;
    const v = data(
      (await call("validate_workout", ctxOf(r), { doc: docOf([item("Goblet Squatt"), item("splitSquat", { sets: 2, reps: 8, perSide: true }), item(kettle.id)]), date: day(-1) })).result,
    );
    expect(v.valid).toBe(false);
    expect(v.errors).toContainEqual(expect.objectContaining({ path: "parts[0].items[0].libraryId", code: "unknown_exercise" }));
    expect(v.warnings).toContainEqual(expect.objectContaining({ path: "parts[0].items[1].libraryId", code: "excluded_by_athlete" }));
    // The default place (the Garage) has no kettlebell…
    expect(v.warnings).toContainEqual(expect.objectContaining({ path: "parts[0].items[2].libraryId", code: "equipment_unavailable" }));
    expect(v.place).toMatchObject({ id: rich.placeId, default: true });
    // …the gym does.
    const gym = data(
      (await call("validate_workout", ctxOf(r), { doc: docOf([item(kettle.id)], { setting: { placeId: rich.gymId } }), date: day(-1) })).result,
    );
    expect(gym.warnings.filter((w: { code: string }) => w.code === "equipment_unavailable")).toEqual([]);
    expect(gym.place).toMatchObject({ id: rich.gymId });
  });

  it("a place that isn't the athlete's (or a preset) is refused, teachably; a preset is checked as itself", async () => {
    const r = await run();
    const e = err((await call("validate_workout", ctxOf(r), { doc: docOf([item("bridge")], { setting: { placeId: "nowhere" } }), date: TODAY })).result);
    expect(e.error).toBe("unknown_place");
    expect(e.fix).toMatch(/read_profile/);
    const preset = data((await call("validate_workout", ctxOf(r), { doc: docOf([item("bridge")], { setting: { placeId: "gym" } }), date: TODAY })).result);
    expect(preset.place).toMatchObject({ id: "gym" });
    // The Studio's "No equipment" place: no gear at all, as the create path checks it.
    const kettle = EXERCISES.find((e) => e.equipment.all.length === 1 && e.equipment.all[0] === "kettlebell")!;
    const bare = data((await call("validate_workout", ctxOf(r), { doc: docOf([item(kettle.id)], { setting: { placeId: NO_EQUIPMENT_PLACE } }), date: TODAY })).result);
    expect(bare.place).toEqual({ id: NO_EQUIPMENT_PLACE, default: false });
    expect(bare.warnings).toContainEqual(expect.objectContaining({ path: "parts[0].items[0].libraryId", code: "equipment_unavailable" }));
  });

  it("a day gone is refused; a document that isn't one comes back as its schema errors, never a throw", async () => {
    const r = await run();
    expect(err((await call("validate_workout", ctxOf(r), { doc: calmDoc(), date: day(1) })).result).error).toBe("past_date");
    const bad = data((await call("validate_workout", ctxOf(r), { doc: { title: "" }, date: TODAY })).result);
    expect(bad.valid).toBe(false);
    expect(bad.errors.every((e: { code: string }) => e.code === "bounds")).toBe(true);
    expect(bad.derived).toBeNull();
    expect(err((await call("validate_workout", ctxOf(r), { doc: calmDoc() })).result).error).toBe("invalid_input");
  });

  it("a document copied back from get_workout — every text marked untrusted — reads as its own text", async () => {
    const r = await run();
    const marked = markedDoc(studioDoc());
    expect(JSON.stringify(marked)).toContain('"untrusted":true');
    const v = data((await call("validate_workout", ctxOf(r), { doc: marked, date: TODAY })).result);
    expect(v.errors).toEqual([]);
    expect(unwrapUntrusted(marked)).toMatchObject({ title: "Strong hips, easy back", intent: { summary: expect.any(String) } });
    // Only the marker's exact shape is unwrapped.
    expect(unwrapUntrusted({ untrusted: true, text: "x", more: 1 })).toEqual({ untrusted: true, text: "x", more: 1 });
    expect(unwrapUntrusted([{ untrusted: true, text: "a" }, "b"])).toEqual(["a", "b"]);
  });
});

// ── ask_athlete ─────────────────────────────────────────────────────────────────────────────────────────────────────

describe("ask_athlete", () => {
  const q = (over: Record<string, unknown> = {}) => ({ text: "How long do you have — and at home or the gym?", chips: ["20 min, home", "40 min, gym"], why: "Time and place decide the design.", ...over });

  it("puts one or two questions, each with chips, free text always allowed, and why — the payload the run view shows", async () => {
    const r = await run();
    expect(tool("ask_athlete").control).toBe("ask");
    const { result, count } = await call("ask_athlete", ctxOf(r), { questions: [q(), q({ text: "How are your calves after Sunday?", chips: ["fine", "a bit sore", "very sore"] })] });
    expect(count).toBe(0);
    expect(data(result)).toEqual({
      questions: [
        { text: q().text, chips: q().chips, allowFreeText: true, why: q().why },
        { text: "How are your calves after Sunday?", chips: ["fine", "a bit sore", "very sore"], allowFreeText: true, why: q().why },
      ],
    });
    expect(ok(result).summary).toBe(`${q().text} · How are your calves after Sunday?`);
  });

  it("refuses three questions, seven chips, a long question, a chip twice, no chips, or free text switched off", async () => {
    const r = await run();
    const refused = async (input: unknown) => err((await call("ask_athlete", ctxOf(r), input)).result);
    expect((await refused({ questions: [q(), q(), q()] })).why).toMatch(/2/);
    expect((await refused({ questions: [q({ chips: ["1", "2", "3", "4", "5", "6", "7"] })] })).why).toMatch(/6/);
    expect((await refused({ questions: [q({ text: "x".repeat(201) })] })).error).toBe("invalid_input");
    expect((await refused({ questions: [q({ chips: ["same", "same"] })] })).why).toMatch(/twice/);
    expect((await refused({ questions: [q({ chips: [] })] })).error).toBe("invalid_input");
    expect((await refused({ questions: [q({ allowFreeText: false })] })).error).toBe("invalid_input");
    expect((await refused({ questions: [] })).error).toBe("invalid_input");
  });
});

// ── record_answer ───────────────────────────────────────────────────────────────────────────────────────────────────

describe("record_answer", () => {
  const REQUEST = "My calves are wrecked after the hills, an 8, and my hamstrings are a bit sore, maybe 3. Energy is low today, a 3.";

  it("keeps what the request states as check-in answers (source request), by area, with an undo handle and a receipt", async () => {
    // A focus area of the athlete's own that is no library region.
    const [profile] = await db.select().from(schema.athleteProfiles).where(eq(schema.athleteProfiles.userId, rich.userId));
    await db
      .update(schema.athleteProfiles)
      .set({ focusAreas: [...(profile!.focusAreas as unknown[]), { id: "desk-neck", label: "Desk neck", refs: ["neck"] }] })
      .where(eq(schema.athleteProfiles.userId, rich.userId));
    const r = await run({ request: REQUEST });
    const c = ctxOf(r);
    const { result } = await call("record_answer", c, {
      answers: [
        { question: "soreness", area: "calves", value: 8, quote: "My calves are wrecked after the hills, an 8" },
        { question: "soreness", area: "hamstrings", value: 3, quote: "my hamstrings are a bit sore, maybe 3" },
        { question: "energy", value: 3, quote: "Energy is low today, a 3" },
        { question: "tightness", area: "desk-neck", quote: "my hamstrings are a bit sore" },
      ],
    });
    const out = ok(result);
    const handle = `ra:${r.id}:${c.toolUseId}`;
    expect(out.receipt).toMatchObject({ undo: { handle } });
    expect(out.summary).toBe("Noted from your request: soreness — calves 8, hamstrings 3 · energy 3 · tightness — Desk neck");
    const rows = await db.select().from(schema.athleteAnswers).where(like(schema.athleteAnswers.id, `${handle}:%`));
    expect(rows).toHaveLength(4);
    expect(rows.every((row) => row.source === "request" && row.localDate === TODAY && row.userId === rich.userId)).toBe(true);
    const calves = rows.find((row) => row.subjectId === "calves")!;
    expect(calves).toMatchObject({ questionId: "soreness", subjectKind: "region", valueNum: 8, text: "My calves are wrecked after the hills, an 8", expiresAt: day(-2) });
    expect(rows.find((row) => row.questionId === "energy")).toMatchObject({ subjectKind: null, subjectId: null, valueNum: 3 });
    // A focus area of the athlete's is its own kind of subject.
    expect(rows.find((row) => row.questionId === "tightness")).toMatchObject({ subjectKind: "focus_area", subjectId: "desk-neck", valueNum: null });
    // A library region wins over a focus area of the same id ("calves" is both here).
    expect(calves.subjectKind).toBe("region");
    // The next design reads it.
    const read = data(await readAnswers.run(c, { question: "soreness", area: "calves", since: TODAY }));
    expect(read.answers[0]).toMatchObject({ value: 8, source: "request", text: { untrusted: true } });
  });

  it("a replayed call (the same tool-use id) writes no second set of rows", async () => {
    const r = await run({ request: REQUEST });
    const c = ctxOf(r);
    const input = { answers: [{ question: "soreness", area: "calves", quote: "calves are wrecked" }] };
    await call("record_answer", c, input);
    await call("record_answer", c, input);
    expect(await db.select().from(schema.athleteAnswers).where(like(schema.athleteAnswers.id, `ra:${r.id}:%`))).toHaveLength(1);
  });

  it("refuses words the request doesn't hold, energy by area, soreness with no area, an unknown area, a value off the scale", async () => {
    const r = await run({ request: REQUEST });
    const refused = async (a: Record<string, unknown>) => err((await call("record_answer", ctxOf(r), { answers: [a] })).result);
    const invented = await refused({ question: "soreness", area: "quads", value: 6, quote: "my quads are sore" });
    expect(invented.error).toBe("not_in_request");
    expect(invented.fix).toMatch(/remember/);
    expect((await refused({ question: "energy", area: "calves", quote: "Energy is low today" })).error).toBe("bad_area");
    const noArea = await refused({ question: "soreness", quote: "calves are wrecked" });
    expect(noArea.error).toBe("bad_area");
    expect(noArea.why).toMatch(/recorded by area/);
    expect((await refused({ question: "soreness", area: "elbowz", quote: "calves are wrecked" })).error).toBe("bad_area");
    expect((await refused({ question: "soreness", area: "calves", value: 11, quote: "calves are wrecked" })).error).toBe("invalid_input");
    expect((await refused({ question: "mood", value: 3, quote: "Energy is low today." })).error).toBe("invalid_input");
    // No request at all: nothing to record.
    const tapped = await run({ request: null });
    expect(err((await call("record_answer", ctxOf(tapped), { answers: [{ question: "energy", value: 3, quote: "low" }] })).result).error).toBe("not_in_request");
    expect(await db.select().from(schema.athleteAnswers).where(like(schema.athleteAnswers.id, `ra:${r.id}:%`))).toHaveLength(0);
  });

  it("is the main coach's alone (a designer has a brief, not the request)", () => {
    expect(tool("record_answer").roles).toEqual(["main"]);
  });
});

// ── remember ────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("remember", () => {
  it("writes memory v2 — kind, confidence, evidence, where it came from — and marks the body as data", async () => {
    const r = await run();
    const c = ctxOf(r);
    const { result } = await call("remember", c, {
      kind: "observation",
      body: "Activation before goblet squats: no clenched sets in 3 of 3 sessions",
      confidence: "inferred",
      evidence: ["3 sessions since day 9, none flagged"],
    });
    const out = ok(result);
    const id = (out.receipt as { memoryId: string }).memoryId;
    const [row] = await db.select().from(schema.coachMemory).where(eq(schema.coachMemory.id, id));
    expect(row).toMatchObject({ userId: rich.userId, kind: "observation", confidence: "inferred", active: true, pinned: false, supersededBy: null });
    expect(JSON.parse(row!.evidence!)).toEqual(["3 sessions since day 9, none flagged"]);
    expect(row!.provenance).toMatchObject({ source: "coach_inference", runId: r.id, role: "main", at: NOW.toISOString() });
    expect((row!.provenance as Record<string, unknown>).rehearsal).toBeUndefined();
    expect(out.data).toMatchObject({ remembered: { id, confidence: "inferred", body: { untrusted: true } } });
    expect(out.summary).toMatch(/^Remembered \(inferred\)/);
    // recall_memory finds it, marked as the coach's inference.
    const recalled = data(await recallMemory.run(c, { query: "Activation before goblet", kind: "observation" }));
    expect(recalled.memories[0]).toMatchObject({ id, confidence: "inferred" });
  });

  it("names a smuggled field first, however much else is wrong with the call", async () => {
    const r = await run();
    const e = err((await call("remember", ctxOf(r), { evidence: [], expires: "soon", replaces: "", confirmedByAthlete: true })).result);
    expect(e.error).toBe("invalid_input");
    expect(e.why.startsWith('unknown field "confirmedByAthlete"')).toBe(true);
  });

  it("never writes confirmed: only the athlete confirms", async () => {
    const r = await run();
    const e = err((await call("remember", ctxOf(r), { kind: "fact", body: "Has a pull-up bar", confidence: "confirmed" })).result);
    expect(e.error).toBe("not_yours_to_confirm");
    expect(e.fix).toMatch(/stated|inferred/);
  });

  it("a stated fact is the athlete's words: source athlete_words", async () => {
    const r = await run();
    const out = ok((await call("remember", ctxOf(r), { kind: "fact", body: "Trains in a garage", confidence: "stated" })).result);
    const [row] = await db.select().from(schema.coachMemory).where(eq(schema.coachMemory.id, (out.receipt as { memoryId: string }).memoryId));
    expect(row!.confidence).toBe("stated");
    expect(row!.provenance).toMatchObject({ source: "athlete_words" });
  });

  it("a rehearsal run's memory is marked as one (provenance.rehearsal), and recall never shows it", async () => {
    const r = await run({ rehearsal: true });
    const out = ok((await call("remember", ctxOf(r), { kind: "note", body: "REHEARSAL-ONLY note", confidence: "stated", expires: day(-10) })).result);
    const [row] = await db.select().from(schema.coachMemory).where(eq(schema.coachMemory.id, (out.receipt as { memoryId: string }).memoryId));
    expect((row!.provenance as Record<string, unknown>).rehearsal).toBe(true);
    expect(JSON.stringify(data(await recallMemory.run(ctxOf(r), { query: "REHEARSAL-ONLY" })))).not.toContain("REHEARSAL-ONLY");
  });

  it("a note needs an expiry ahead; an observation needs evidence; evidence is bounded", async () => {
    const r = await run();
    const refused = async (input: unknown) => err((await call("remember", ctxOf(r), input)).result);
    expect((await refused({ kind: "note", body: "Trip next week", confidence: "stated" })).error).toBe("needs_expiry");
    expect((await refused({ kind: "note", body: "Trip next week", confidence: "stated", expires: TODAY })).error).toBe("needs_expiry");
    expect((await refused({ kind: "observation", body: "Squats go better late", confidence: "inferred" })).error).toBe("needs_evidence");
    expect((await refused({ kind: "observation", body: "x", confidence: "inferred", evidence: Array.from({ length: 6 }, () => "e") })).error).toBe("invalid_input");
    expect((await refused({ kind: "observation", body: "x", confidence: "inferred", evidence: ["e".repeat(201)] })).error).toBe("invalid_input");
    expect((await refused({ kind: "fact", body: "x".repeat(301), confidence: "stated" })).error).toBe("invalid_input");
  });

  it("replaces an item by its id — the old one superseded, history kept — but an inference never replaces what the athlete confirmed", async () => {
    const r = await run();
    const old = newId();
    const confirmed = newId();
    const base = { userId: rich.userId, provenance: { source: "message", at: at(day(9)) }, learnedAt: at(day(9)), active: true, pinned: false, updatedAt: null };
    await db.insert(schema.coachMemory).values([
      { ...base, id: old, kind: "rule", body: "Trains mornings", confidence: "stated" },
      { ...base, id: confirmed, kind: "fact", body: "Has a bench", confidence: "confirmed" },
    ]);
    const out = ok((await call("remember", ctxOf(r), { kind: "rule", body: "Trains evenings now", confidence: "stated", replaces: old })).result);
    const id = (out.receipt as { memoryId: string }).memoryId;
    const [prior] = await db.select().from(schema.coachMemory).where(eq(schema.coachMemory.id, old));
    expect(prior).toMatchObject({ supersededBy: id, body: "Trains mornings" });
    expect(out.data).toMatchObject({ replaced: old });
    expect(err((await call("remember", ctxOf(r), { kind: "fact", body: "No bench", confidence: "inferred", replaces: confirmed })).result).error).toBe("confirmed_by_athlete");
    expect(err((await call("remember", ctxOf(r), { kind: "rule", body: "Again", confidence: "stated", replaces: old })).result).error).toBe("not_found");
  });

  it("at most five per run, counted over the run's whole tree; a replay of one call writes once", async () => {
    const main = await run();
    const designer = await run({ role: "designer", parentId: main.id, scope: { kind: "week" } });
    const c = ctxOf(main);
    for (let n = 0; n < 3; n++) ok((await call("remember", { ...c, toolUseId: `toolu_m${n}-${main.id}` }, { kind: "fact", body: `Fact ${n}`, confidence: "stated" })).result);
    // A replay of the last: no sixth row, and no count used.
    ok((await call("remember", { ...c, toolUseId: `toolu_m2-${main.id}` }, { kind: "fact", body: "Fact 2", confidence: "stated" })).result);
    for (let n = 3; n < 5; n++) ok((await call("remember", ctxOf(designer), { kind: "fact", body: `Fact ${n}`, confidence: "stated" })).result);
    const capped = err((await call("remember", ctxOf(designer), { kind: "fact", body: "One too many", confidence: "stated" })).result);
    expect(capped.error).toBe("memory_cap");
    // A replay of a call that was written is its answer again, cap or no cap.
    const again = ok((await call("remember", { ...c, toolUseId: `toolu_m0-${main.id}` }, { kind: "fact", body: "Fact 0", confidence: "stated" })).result);
    expect(again.receipt).toMatchObject({ memoryId: `mem:${main.id}:toolu_m0-${main.id}` });
    const rows = await db.select().from(schema.coachMemory).where(and(eq(schema.coachMemory.userId, rich.userId), like(schema.coachMemory.body, "Fact %")));
    expect(rows.filter((m) => (m.provenance as { runId?: string }).runId === main.id)).toHaveLength(5);
  });
});

// ── propose_workout ─────────────────────────────────────────────────────────────────────────────────────────────────

describe("propose_workout", () => {
  it("main, for now: stores the draft as a doc_workout op of the run's one proposal — unreviewed, never pending", async () => {
    const r = await run();
    const c = ctxOf(r);
    const { result } = await call("propose_workout", c, { doc: calmDoc({ title: "Hips and back" }), target: { kind: "new", date: TODAY, time: "17:30" }, changeNote: "First draft." });
    const out = ok(result);
    expect(out.data).toMatchObject({ stored: true, proposalId: designProposalId(r.id), review: null, note: "not reviewed yet" });
    expect(out.receipt).toMatchObject({ proposalId: designProposalId(r.id), title: "Hips and back", date: TODAY });
    expect(out.summary).toMatch(/^Draft — "Hips and back": \d+ min/);
    const p = (await proposal(r.id))!;
    expect(p).toMatchObject({ userId: rich.userId, status: "unreviewed", title: "Hips and back", expiresAt: TODAY });
    expect(p.ops).toHaveLength(1);
    const op = p.ops[0]!;
    expect(op).toMatchObject({
      kind: "doc_workout",
      target: { kind: "new", date: TODAY, time: "17:30" },
      date: TODAY,
      time: "17:30",
      changeNote: "First draft.",
      review: null,
      toolUseId: c.toolUseId,
      by: { runId: r.id, role: "main" },
    });
    // The coach wrote it, whatever the draft said.
    expect(op.doc.source).toEqual({ kind: "coach", ref: `run:${r.id}` });
    expect(workoutDocSchema.safeParse(op.doc).success).toBe(true);
    expect(op.derived).toMatchObject({ minutes: expect.any(Number), discipline: expect.any(String) });
    expect(Array.isArray(op.issues)).toBe(true);
  });

  it("a second draft from the same run replaces its op (a revision round); a replayed call adds nothing and answers the same", async () => {
    const r = await run();
    const c = ctxOf(r);
    const first = ok((await call("propose_workout", c, { doc: calmDoc({ title: "One" }), target: { kind: "new", date: TODAY } })).result);
    const replay = ok((await call("propose_workout", c, { doc: calmDoc({ title: "One" }), target: { kind: "new", date: TODAY } })).result);
    expect(replay.data).toEqual(first.data);
    expect((await proposal(r.id))!.ops).toHaveLength(1);
    const { result, writes } = await call("propose_workout", ctxOf(r), { doc: calmDoc({ title: "Two" }), target: { kind: "new", date: TODAY }, changeNote: "Swapped the order." });
    expect(ok(result).data).toMatchObject({ stored: true, replaced: true });
    expect(writes).toHaveLength(1);
    const p = (await proposal(r.id))!;
    expect(p.ops.map((o) => o.doc.title)).toEqual(["Two"]);
    expect(p.title).toBe("Two");
  });

  it("revises a Studio workout at its current revision; the copy get_workout returned (marked) is accepted as its text", async () => {
    const r = await run();
    const marked = markedDoc(studioDoc({ title: "Strong hips, easy back" }));
    const out = ok((await call("propose_workout", ctxOf(r), { doc: marked, target: { kind: "revise", workoutId: rich.todayDocId, baseRev: 2 } })).result);
    expect(out.data).toMatchObject({ stored: true });
    const op = (await proposal(r.id))!.ops[0]!;
    expect(op).toMatchObject({ target: { kind: "revise", workoutId: rich.todayDocId, baseRev: 2 }, date: TODAY, time: "18:00" });
    expect(op.doc.title).toBe("Strong hips, easy back");
    expect(JSON.stringify(op.doc)).not.toContain("untrusted");
  });

  describe("refuses, teachably", () => {
    const refused = async (r: Awaited<ReturnType<typeof run>>, input: unknown) => {
      const { result, writes } = await call("propose_workout", ctxOf(r), input);
      expect(writes).toEqual([]);
      return err(result);
    };

    it("main for a week or the next few (designers propose those); the reviewer never", async () => {
      const week = await run({ scope: { kind: "week" } });
      const e = await refused(week, { doc: calmDoc(), target: { kind: "new", date: TODAY } });
      expect(e.error).toBe("not_for_scope");
      expect(e.fix).toMatch(/plan_set/);
      expect((await refused(await run({ scope: { kind: "next_n", n: 3 } }), { doc: calmDoc(), target: { kind: "new", date: TODAY } })).error).toBe("not_for_scope");
      expect(tool("propose_workout").roles).toEqual(["main", "designer"]);
    });

    it("a day gone, in the athlete's own zone — a new workout's, or a revised one's still left to do", async () => {
      const r = await run();
      const e = await refused(r, { doc: calmDoc(), target: { kind: "new", date: day(1) } });
      expect(e.error).toBe("past_date");
      expect(e.why).toContain(TODAY);
      const missed = newId();
      await db.insert(schema.plannedWorkouts).values({
        id: missed, userId: rich.userId, planId: `studio-${rich.userId}`, sourceWorkoutId: missed, title: "Left to do", category: "strength", sport: "strength",
        originalPlanDate: day(2), lastVerifiedCorosDate: day(2), effectiveDate: day(2), effectiveTime: "12:00", sourceContentFingerprint: "studio",
        calendarBlockDurationSeconds: 1800, completionState: "scheduled", origin: "studio", contentState: "outline", workoutDoc: JSON.stringify(studioDoc()),
        workoutDocRev: 1, createdAt: at(day(3)), updatedAt: at(day(3)),
      });
      const gone = await refused(r, { doc: studioDoc(), target: { kind: "revise", workoutId: missed, baseRev: 1 } });
      expect(gone.error).toBe("past_date");
      expect(gone.why).toContain(day(2));
    });

    it("a stale base revision, saying the current one", async () => {
      const e = await refused(await run(), { doc: studioDoc(), target: { kind: "revise", workoutId: rich.todayDocId, baseRev: 1 } });
      expect(e.error).toBe("stale_base");
      expect(e.why).toMatch(/revision 2/);
      expect(e.fix).toMatch(/get_workout/);
    });

    it("a programme's session, a resolved workout, one under way, an archived or unknown one", async () => {
      const r = await run();
      const programme = await refused(r, { doc: studioDoc(), target: { kind: "revise", workoutId: rich.outlineToday, baseRev: 0 } });
      expect(programme.error).toBe("not_editable");
      expect(programme.why).toMatch(/programme/);
      const done = await refused(r, { doc: studioDoc(), target: { kind: "revise", workoutId: rich.pastDocId, baseRev: 1 } });
      expect(done.error).toBe("not_editable");
      expect(done.why).toMatch(/completed/);
      const underWay = newId();
      await db.insert(schema.plannedWorkouts).values({
        id: underWay, userId: rich.userId, planId: `studio-${rich.userId}`, sourceWorkoutId: underWay, title: "Under way", category: "strength", sport: "strength",
        originalPlanDate: TODAY, lastVerifiedCorosDate: TODAY, effectiveDate: TODAY, effectiveTime: "12:00", sourceContentFingerprint: "studio",
        calendarBlockDurationSeconds: 1800,
        completionState: "scheduled", origin: "studio", contentState: "started", workoutDoc: JSON.stringify(studioDoc()), workoutDocRev: 1,
        createdAt: at(day(1)), updatedAt: at(day(1)),
      });
      expect((await refused(r, { doc: studioDoc(), target: { kind: "revise", workoutId: underWay, baseRev: 1 } })).why).toMatch(/under way/);
      expect((await refused(r, { doc: studioDoc(), target: { kind: "revise", workoutId: rich.archivedDocId, baseRev: 1 } })).error).toBe("not_found");
      expect((await refused(r, { doc: studioDoc(), target: { kind: "revise", workoutId: "no-such", baseRev: 1 } })).error).toBe("not_found");
      // Another athlete's workout is not found either.
      expect((await refused(await run({ userId: high.userId }), { doc: studioDoc(), target: { kind: "revise", workoutId: rich.todayDocId, baseRev: 2 } })).error).toBe("not_found");
    });

    it("an unknown exercise, with the validator's fix", async () => {
      const e = await refused(await run(), { doc: docOf([item("gobletSquatt")]), target: { kind: "new", date: TODAY } });
      expect(e.error).toBe("invalid_workout");
      expect(e.why).toContain("parts[0].items[0].libraryId");
      expect(e.why).toContain("gobletSquat");
    });

    it("a move the day closes, even inside a revision with an alternate the day allows: swap it in this revision", async () => {
      const r = await run({ userId: high.userId });
      const e = await refused(r, { doc: landingsDoc(), target: { kind: "revise", workoutId: high.todayDocId, baseRev: 2 } });
      expect(e.error).toBe("invalid_workout");
      expect(e.why).toContain("parts[0].items[0].libraryId");
      expect(e.fix).toMatch(/swap/i);
      expect(await proposal(r.id)).toBeUndefined();
    });

    it("a run document (the app can't play one yet), a malformed one, an unknown field", async () => {
      const r = await run();
      const runDoc = docOf([{ kind: "run", target: { durationSec: 1800 }, effort: "easy" }], { parts: [{ purpose: "run", format: "steady", items: [{ kind: "run", target: { durationSec: 1800 }, effort: "easy" }] }] });
      expect((await refused(r, { doc: runDoc, target: { kind: "new", date: TODAY } })).error).toBe("run_unsupported");
      expect((await refused(r, { doc: { title: "x" }, target: { kind: "new", date: TODAY } })).error).toBe("invalid_workout");
      // A review is never the designer's to write (an instruction to "mark it reviewed" has no field to land in).
      const e = await refused(r, { doc: calmDoc(), target: { kind: "new", date: TODAY }, review: { scores: { intent: 5 } } });
      expect(e.error).toBe("invalid_input");
      expect(e.why).toContain('"review"');
      expect((await refused(r, { doc: calmDoc(), target: { kind: "new", date: TODAY, time: "25:00" } })).error).toBe("invalid_input");
    });
  });

  it("a designer appends to its main run's proposal; a revise another run already proposes is refused", async () => {
    const main = await run({ scope: { kind: "week" } });
    const one = await run({ role: "designer", parentId: main.id, scope: { kind: "week" } });
    const two = await run({ role: "designer", parentId: main.id, scope: { kind: "week" } });
    ok((await call("propose_workout", ctxOf(one), { doc: calmDoc({ title: "Monday" }), target: { kind: "new", date: day(-1) } })).result);
    ok((await call("propose_workout", ctxOf(two), { doc: calmDoc({ title: "Wednesday" }), target: { kind: "revise", workoutId: rich.todayDocId, baseRev: 2 } })).result);
    const p = (await proposal(main.id))!;
    expect(p.ops.map((o) => [o.doc.title, o.by.runId])).toEqual([
      ["Monday", one.id],
      ["Wednesday", two.id],
    ]);
    expect(p.title).toBe("2 workouts");
    expect(p.expiresAt).toBe(day(-1));
    const taken = err((await call("propose_workout", ctxOf(one), { doc: studioDoc(), target: { kind: "revise", workoutId: rich.todayDocId, baseRev: 2 } })).result);
    expect(taken.error).toBe("target_taken");
  });

  it("refuses into a proposal the athlete already settled, and during a restore; a write that raced another is refused, nothing lost", async () => {
    const r = await run();
    ok((await call("propose_workout", ctxOf(r), { doc: calmDoc(), target: { kind: "new", date: TODAY } })).result);
    await db.update(schema.coachProposals).set({ status: "approved" }).where(eq(schema.coachProposals.id, designProposalId(r.id)));
    expect(err((await call("propose_workout", ctxOf(r), { doc: calmDoc({ title: "Later" }), target: { kind: "new", date: TODAY } })).result).error).toBe("proposal_closed");
    expect((await proposal(r.id))!.ops.map((o) => o.doc.title)).toEqual(["Hips and back"]);

    const restoring = await seedRichAthlete(db);
    await db.insert(schema.accountState).values({ userId: restoring.userId, restoreId: "restore-1", updatedAt: NOW.toISOString() });
    const rr = await run({ userId: restoring.userId });
    expect(err((await call("propose_workout", ctxOf(rr), { doc: calmDoc(), target: { kind: "new", date: TODAY } })).result).error).toBe("restoring");
    expect(await proposal(rr.id)).toBeUndefined();

    // Another designer's draft lands between this call's read and its write: just before the write reaches the database.
    const main = await run({ scope: { kind: "week" } });
    const one = await run({ role: "designer", parentId: main.id, scope: { kind: "week" } });
    const two = await run({ role: "designer", parentId: main.id, scope: { kind: "week" } });
    let raced = false;
    const racingDb = new Proxy(db, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (prop !== "all" || typeof value !== "function") return value;
        return async (q: { queryChunks?: Array<{ value?: unknown }> }) => {
          const text = (q.queryChunks ?? []).map((c) => (Array.isArray(c?.value) ? c.value.join("") : "")).join("");
          if (!raced && text.includes("INSERT INTO coach_proposals")) {
            raced = true;
            await tool("propose_workout").run(ctxOf(two), { doc: calmDoc({ title: "Two's" }), target: { kind: "new", date: day(-2) } });
          }
          return (value as (q: unknown) => Promise<unknown>).call(target, q);
        };
      },
    });
    const racing = { ...ctxOf(one), db: racingDb };
    const lost = err((await tool("propose_workout").run(racing, { doc: calmDoc({ title: "One's" }), target: { kind: "new", date: day(-1) } })));
    expect(raced).toBe(true);
    expect(lost.error).toBe("proposal_changed");
    expect((await proposal(main.id))!.ops.map((o) => o.doc.title)).toEqual(["Two's"]);
  });

  it("a reviewer that can't be started leaves the draft stored, unreviewed — and the next call starts afresh, the round not counted", async () => {
    const r = await run();
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    onTestFinished(() => quiet.mockRestore());
    const down: ReviewHooks = { start: async () => { throw new Error("reviewer down"); }, ended: () => null };
    const refused = err((await call("propose_workout", ctxOf(r, { review: down }), { doc: calmDoc(), target: { kind: "new", date: TODAY } })).result);
    expect(refused).toMatchObject({ error: "review_unavailable" });
    const stored = (await proposal(r.id))!;
    expect(stored.status).toBe("unreviewed");
    expect(stored.ops[0]!.review).toBeNull();
    const started: ReviewStart[] = [];
    const up: ReviewHooks = { start: async (req) => (started.push(req), true), ended: () => null };
    const again = ok((await call("propose_workout", ctxOf(r, { review: up }), { doc: calmDoc({ title: "Again" }), target: { kind: "new", date: TODAY } })).result);
    expect(again.control).toBe("review");
    expect(started.map((x) => x.round)).toEqual([1]);
    // The round that never got its reviewer was dropped at once: it counts against nothing.
    expect((await proposal(r.id))!.ops[0]!.reviewLog!.map((x) => [x.round, x.status])).toEqual([
      [1, "dropped"],
      [1, "reviewing"],
    ]);
  });

  it("a rehearsal run's proposal is stored as a rehearsal", async () => {
    const r = await run({ rehearsal: true });
    ok((await call("propose_workout", ctxOf(r), { doc: calmDoc(), target: { kind: "new", date: TODAY } })).result);
    expect((await proposal(r.id))!.status).toBe("rehearsal");
  });

  it("with the loop's review hooks: the draft is stored unreviewed, its reviewer started with the draft, and the call pauses for the review", async () => {
    const r = await run();
    const started: ReviewStart[] = [];
    const hooks: ReviewHooks = { start: async (req) => (started.push(req), true), ended: () => null };
    const c = ctxOf(r, { review: hooks });
    const out = ok((await call("propose_workout", c, { doc: calmDoc({ title: "Reviewed" }), target: { kind: "new", date: TODAY } })).result);
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({
      reviewRunId: `rv-${r.id}-${c.toolUseId}`,
      proposalId: designProposalId(r.id),
      round: 1,
      toolUseId: c.toolUseId,
      draft: { proposalId: designProposalId(r.id), date: TODAY, doc: { title: "Reviewed" }, target: { kind: "new", date: TODAY } },
    });
    expect(out.control).toBe("review");
    expect(out.data).toMatchObject({ stored: true, proposalId: designProposalId(r.id), round: 1, reviewRunId: `rv-${r.id}-${c.toolUseId}`, reviewing: true });
    expect(out.summary).toMatch(/^Draft — "Reviewed": \d+ min — sent for review$/);
    const p = (await proposal(r.id))!;
    expect(p.ops[0]).toMatchObject({ review: null, round: 1, reviewRunId: `rv-${r.id}-${c.toolUseId}`, reviewLog: [{ round: 1, status: "reviewing", toolUseId: c.toolUseId }] });
    // Reviewed or not, propose never makes a proposal pending: the main run's finish does, once every op is reviewed.
    expect(p.status).toBe("unreviewed");
    // Replayed when its reviewer was never started (the step died between the write and the start): started now, once —
    // the round is the same — and the run waits again.
    const again = ok((await call("propose_workout", { ...c, review: { start: async (req) => (started.push(req), true), ended: () => null } }, { doc: calmDoc({ title: "Reviewed" }), target: { kind: "new", date: TODAY } })).result);
    expect(again.control).toBe("review");
    expect((await proposal(r.id))!.ops[0]!.reviewLog).toHaveLength(1);
    // Replayed once its reviewer used all its turns without a review: the validator's view stands, written now.
    const capped: ReviewHooks = { start: async () => false, ended: () => ({ status: "stopped_cap", error: "step_cap" }) };
    const over = ok((await call("propose_workout", { ...c, review: capped }, { doc: calmDoc({ title: "Reviewed" }), target: { kind: "new", date: TODAY } })).result);
    expect(over.control).toBeUndefined();
    expect(over.data).toMatchObject({ review: null, round: 1, roundsLeft: 2 });
    expect((await proposal(r.id))!.ops[0]!.review).toMatchObject({ rounds: 1, note: expect.stringContaining("the validator's view stands") });

    // …but one whose reviewer crashed gave no review at all: the round is dropped, the draft stays unreviewed.
    const r2 = await run();
    const c2 = ctxOf(r2, { review: { start: async () => true, ended: () => null } });
    ok((await call("propose_workout", c2, { doc: calmDoc(), target: { kind: "new", date: TODAY } })).result);
    const crashed: ReviewHooks = { start: async () => false, ended: () => ({ status: "failed", error: "internal" }) };
    const lost = ok((await call("propose_workout", { ...c2, review: crashed }, { doc: calmDoc(), target: { kind: "new", date: TODAY } })).result);
    expect(lost.data).toMatchObject({ review: null, unavailable: true, roundsLeft: 3, note: expect.stringContaining("something went wrong in the reviewer") });
    const op2 = (await proposal(r2.id))!.ops[0]!;
    expect(op2.review).toBeNull();
    expect(op2.reviewLog!.map((x) => x.status)).toEqual(["dropped"]);
  });
});

// ── finish ──────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("finish", () => {
  it("ends with one plain line; with an unreviewed proposal it names it and says it is kept back", async () => {
    expect(tool("finish").control).toBe("finish");
    const r = await run();
    ok((await call("propose_workout", ctxOf(r), { doc: calmDoc(), target: { kind: "new", date: TODAY } })).result);
    const out = ok((await call("finish", ctxOf(r), { summary: "A calm half hour for the hips, before tonight's run." })).result);
    expect(out.data).toMatchObject({ proposalId: designProposalId(r.id), unreviewed: true });
    expect(out.summary).toBe("A calm half hour for the hips, before tonight's run. (Not reviewed yet — kept back until it is.)");
    expect(out.receipt).toMatchObject({ final: true, proposal: { id: designProposalId(r.id), status: "unreviewed", workouts: 1 } });
    expect((await proposal(r.id))!.status).toBe("unreviewed");
  });

  it("a proposal whose every workout is reviewed is not said to be kept back (the run's finish makes it pending)", async () => {
    const r = await run();
    const review: DesignReview = { scores: { intent: 4 }, notes: { intent: "Clear." }, mustFix: [], improvements: [] };
    // Reviewed as the review loop leaves it (design-review.test.ts drives the loop itself).
    const reviewed = async (mainRunId: string) => {
      const p = (await proposal(mainRunId))!;
      const ops = p.ops.map((o) => ({ ...o, review: { ...review, rounds: 1, changes: [] } }));
      await db.update(schema.coachProposals).set({ ops }).where(eq(schema.coachProposals.id, designProposalId(mainRunId)));
    };
    ok((await call("propose_workout", ctxOf(r), { doc: calmDoc(), target: { kind: "new", date: TODAY } })).result);
    await reviewed(r.id);
    const out = ok((await call("finish", ctxOf(r), { summary: "A calm half hour." })).result);
    expect(out.summary).toBe("A calm half hour.");
    expect(out.data).toEqual({ proposalId: designProposalId(r.id) });
    // The receipt says what the proposal is once this finish lands: pending (the loop promotes it, N1).
    expect(out.receipt).toMatchObject({ proposal: { status: "pending" } });
    // A designer's finish promotes nothing: its receipt says unreviewed.
    const main = await run({ scope: { kind: "week" } });
    const designer = await run({ role: "designer", parentId: main.id, scope: { kind: "week" } });
    ok((await call("propose_workout", ctxOf(designer), { doc: calmDoc(), target: { kind: "new", date: TODAY } })).result);
    await reviewed(main.id);
    expect(ok((await call("finish", ctxOf(designer), { summary: "Done." })).result).receipt).toMatchObject({ proposal: { status: "unreviewed" } });
  });

  it("without a proposal: the line alone; a designer names its main run's proposal only when it added to it", async () => {
    const r = await run();
    const out = ok((await call("finish", ctxOf(r), { summary: "Rest is the right call today." })).result);
    expect(out.data).toEqual({});
    expect(out.summary).toBe("Rest is the right call today.");
    const main = await run({ scope: { kind: "week" } });
    const designer = await run({ role: "designer", parentId: main.id, scope: { kind: "week" } });
    const sibling = await run({ role: "designer", parentId: main.id, scope: { kind: "week" } });
    ok((await call("propose_workout", ctxOf(sibling), { doc: calmDoc({ title: "Sibling's" }), target: { kind: "new", date: day(-2) } })).result);
    expect(ok((await call("finish", ctxOf(designer), { summary: "Couldn't fit it." })).result).data).toEqual({});
    ok((await call("propose_workout", ctxOf(designer), { doc: calmDoc(), target: { kind: "new", date: TODAY } })).result);
    expect(ok((await call("finish", ctxOf(designer), { summary: "Done." })).result).data).toMatchObject({ proposalId: designProposalId(main.id) });
  });

  it("refuses an empty or long line", async () => {
    const r = await run();
    expect(err((await call("finish", ctxOf(r), { summary: "  " })).result).error).toBe("invalid_input");
    expect(err((await call("finish", ctxOf(r), { summary: "x".repeat(301) })).result).error).toBe("invalid_input");
    expect(tool("finish").roles).toEqual(["main", "designer"]);
  });
});

// ── Fix round 1 ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** A Studio workout today whose document carries a free-text move (an import's own name, kept by the athlete). */
async function withFreeMove(userId: string, name = "Farmer carry, heavy"): Promise<string> {
  const id = newId();
  const doc = docOf([item("bridge", { sets: 2, reps: 12 }), { kind: "free_exercise", name, dose: { sets: 2, holdSec: 30 } }], { title: "Kept from an import" });
  await db.insert(schema.plannedWorkouts).values({
    id, userId, planId: `studio-${userId}`, sourceWorkoutId: id, title: "Kept from an import", category: "strength", sport: "strength",
    originalPlanDate: TODAY, lastVerifiedCorosDate: TODAY, effectiveDate: TODAY, effectiveTime: "19:00", sourceContentFingerprint: "studio",
    calendarBlockDurationSeconds: 1800, completionState: "scheduled", origin: "studio", contentState: "outline", workoutDoc: JSON.stringify(doc),
    workoutDocRev: 1, createdAt: at(day(1)), updatedAt: at(day(1)),
  });
  return id;
}

describe("fix round 1 — a free-text move is no way past the hard rules", () => {
  const free = (name: string) => ({ kind: "free_exercise", name, dose: { sets: 3, reps: 5 } });

  it("the document's schema offers no free-text move; validate_workout and propose_workout refuse one, teachably", async () => {
    const items = (WORKOUT_DOC_JSON_SCHEMA as any).properties.parts.items.properties.items.items.anyOf as Array<{ properties: { kind: { const: string } } }>;
    expect(items.map((i) => i.properties.kind.const)).toEqual(["exercise", "run", "rest"]);
    const r = await run({ userId: high.userId });
    for (const name of ["validate_workout", "propose_workout"]) {
      const doc = docOf([item("bridge"), free("Box jumps")]);
      const input = name === "validate_workout" ? { doc, date: TODAY } : { doc, target: { kind: "new", date: TODAY } };
      const { result, writes } = await call(name, ctxOf(r), input);
      const e = err(result);
      expect(e.error, name).toBe("free_text_move");
      expect(e.why, name).toContain('parts[0].items[1] ("Box jumps")');
      expect(e.fix, name).toMatch(/search_library/);
      expect(writes, name).toEqual([]);
    }
  });

  it("a revision may keep a free-text move its base document already has, unchanged — never a new or changed one", async () => {
    const r = await run();
    const workoutId = await withFreeMove(rich.userId);
    const [row] = await db.select().from(schema.plannedWorkouts).where(eq(schema.plannedWorkouts.id, workoutId));
    const base = JSON.parse(row!.workoutDoc!) as Record<string, any>;
    const kept: Record<string, any> = { ...base, title: "Kept, with a cue" };
    // validate_workout, told which workout it revises, judges it as propose will.
    expect(data((await call("validate_workout", ctxOf(r), { doc: kept, date: TODAY, workoutId })).result).valid).toBe(true);
    expect(err((await call("validate_workout", ctxOf(r), { doc: kept, date: TODAY })).result).error).toBe("free_text_move");
    expect(err((await call("validate_workout", ctxOf(r), { doc: kept, date: TODAY, workoutId: rich.todayDocId })).result).error).toBe("free_text_move");
    // Copied back from get_workout, marked: still the same move.
    ok((await call("propose_workout", ctxOf(r), { doc: markedDoc(kept as never), target: { kind: "revise", workoutId, baseRev: 1 } })).result);
    const renamed = structuredClone(kept);
    renamed.parts[0].items[1].name = "Box jumps";
    const r2 = await run();
    expect(err((await call("propose_workout", ctxOf(r2), { doc: renamed, target: { kind: "revise", workoutId, baseRev: 1 } })).result).error).toBe("free_text_move");
    const redosed = structuredClone(kept);
    redosed.parts[0].items[1].dose = { sets: 5, holdSec: 60 };
    expect(err((await call("propose_workout", ctxOf(r2), { doc: redosed, target: { kind: "revise", workoutId, baseRev: 1 } })).result).error).toBe("free_text_move");
  });
});

describe("fix round 1 — a rehearsal run never changes the athlete's records", () => {
  it("remember writes its marked row and supersedes nothing", async () => {
    const r = await run({ rehearsal: true });
    const old = newId();
    await db.insert(schema.coachMemory).values({
      id: old, userId: rich.userId, kind: "rule", body: "Trains mornings (rehearsal test)", provenance: { source: "message", at: at(day(9)) }, learnedAt: at(day(9)),
      active: true, pinned: false, confidence: "stated", updatedAt: null,
    });
    const out = ok((await call("remember", ctxOf(r), { kind: "rule", body: "Trains evenings now", confidence: "stated", replaces: old })).result);
    expect(out.data).toMatchObject({ rehearsal: true });
    const [prior] = await db.select().from(schema.coachMemory).where(eq(schema.coachMemory.id, old));
    expect(prior!.supersededBy).toBeNull();
    const [mine] = await db.select().from(schema.coachMemory).where(eq(schema.coachMemory.id, (out.receipt as { memoryId: string }).memoryId));
    expect((mine!.provenance as Record<string, unknown>).rehearsal).toBe(true);
  });

  it("record_answer writes nothing, and answers as it would with the same receipt", async () => {
    const r = await run({ rehearsal: true, request: "My calves are sore after the hills." });
    const c = ctxOf(r);
    const out = ok((await call("record_answer", c, { answers: [{ question: "soreness", area: "calves", quote: "calves are sore" }] })).result);
    expect(out.data).toEqual({ recorded: 1, rehearsal: true });
    expect(out.receipt).toMatchObject({ undo: { handle: `ra:${r.id}:${c.toolUseId}` }, recorded: [{ question: "soreness", area: "calves" }] });
    expect(await db.select().from(schema.athleteAnswers).where(like(schema.athleteAnswers.id, `ra:${r.id}:%`))).toEqual([]);
  });
});

describe("fix round 1 — record_answer keeps only what was said", () => {
  it("a quote must be words of the request, whole words: punctuation alone or part of a word is not", async () => {
    const r = await run({ request: "My calf is sore, and energy is a 4 today." });
    const refused = async (a: Record<string, unknown>) => err((await call("record_answer", ctxOf(r), { answers: [a] })).result);
    expect((await refused({ question: "soreness", area: "calves", quote: "!!!" })).error).toBe("bad_quote");
    expect((await refused({ question: "soreness", area: "calves", quote: "alf" })).error).toBe("not_in_request");
    ok((await call("record_answer", ctxOf(r), { answers: [{ question: "soreness", area: "calves", quote: "calf is sore" }] })).result);
  });

  it("a value is recorded only when the athlete gave that number; an area that isn't one is answered with the ids", async () => {
    const r = await run({ request: "Calves are wrecked. Hamstrings maybe a 6, energy six out of ten." });
    const refused = async (a: Record<string, unknown>) => err((await call("record_answer", ctxOf(r), { answers: [a] })).result);
    const invented = await refused({ question: "soreness", area: "calves", value: 8, quote: "Calves are wrecked" });
    expect(invented.error).toBe("value_not_stated");
    expect(invented.fix).toMatch(/leave value out/i);
    ok((await call("record_answer", ctxOf(r), { answers: [{ question: "soreness", area: "hamstrings", value: 6, quote: "Hamstrings maybe a 6" }] })).result);
    ok((await call("record_answer", ctxOf(r), { answers: [{ question: "energy", value: 6, quote: "energy six out of ten" }] })).result);
    ok((await call("record_answer", ctxOf(r), { answers: [{ question: "soreness", area: "calves", quote: "Calves are wrecked" }] })).result);
    const unknown = await refused({ question: "soreness", area: "shins", quote: "Calves are wrecked" });
    expect(unknown.error).toBe("bad_area");
    expect(unknown.fix).toContain("calves");
    expect(unknown.fix).toContain("upper-back");
    expect(tool("record_answer").description).toMatch(/only a number the athlete gave/);
  });
});

describe("fix round 1 — remember's rules, consistent", () => {
  it("only a note expires, and never on a day gone", async () => {
    const r = await run();
    expect(err((await call("remember", ctxOf(r), { kind: "fact", body: "Has a bench", confidence: "stated", expires: day(-5) })).result).error).toBe("only_notes_expire");
    expect(err((await call("remember", ctxOf(r), { kind: "note", body: "Trip", confidence: "stated", expires: day(3) })).result).error).toBe("needs_expiry");
  });

  it("what the athlete confirmed is replaced by what they state only with their words from the request", async () => {
    const r = await run({ request: "I sold the bench last week, so no bench now." });
    const confirmed = newId();
    await db.insert(schema.coachMemory).values({
      id: confirmed, userId: rich.userId, kind: "fact", body: "Has a bench (confirmed test)", provenance: { source: "message", at: at(day(9)) }, learnedAt: at(day(9)),
      active: true, pinned: false, confidence: "confirmed", updatedAt: null,
    });
    const bare = err((await call("remember", ctxOf(r), { kind: "fact", body: "No bench", confidence: "stated", replaces: confirmed })).result);
    expect(bare.error).toBe("confirmed_by_athlete");
    expect(bare.fix).toMatch(/quote/);
    expect(err((await call("remember", ctxOf(r), { kind: "fact", body: "No bench", confidence: "stated", replaces: confirmed, quote: "bench is broken" })).result).error).toBe("not_in_request");
    const out = ok((await call("remember", ctxOf(r), { kind: "fact", body: "No bench", confidence: "stated", replaces: confirmed, quote: "no bench now" })).result);
    const [prior] = await db.select().from(schema.coachMemory).where(eq(schema.coachMemory.id, confirmed));
    expect(prior!.supersededBy).toBe((out.receipt as { memoryId: string }).memoryId);
  });
});

describe("fix round 1 — propose_workout: a replay of a call a later draft replaced does nothing", () => {
  it("writes nothing and says a later draft replaced it", async () => {
    const r = await run();
    const first = { ...ctxOf(r), toolUseId: `toolu_first_${r.id}` };
    ok((await call("propose_workout", first, { doc: calmDoc({ title: "First" }), target: { kind: "new", date: TODAY } })).result);
    ok((await call("propose_workout", ctxOf(r), { doc: calmDoc({ title: "Second" }), target: { kind: "new", date: TODAY } })).result);
    const { result, writes } = await call("propose_workout", first, { doc: calmDoc({ title: "First" }), target: { kind: "new", date: TODAY } });
    expect(writes).toEqual([]);
    expect(ok(result).data).toMatchObject({ stored: true, superseded: true });
    const p = (await proposal(r.id))!;
    expect(p.ops.map((o) => o.doc.title)).toEqual(["Second"]);
    expect(p.ops[0]!.replaces).toEqual([`toolu_first_${r.id}`]);
  });
});

describe("fix round 1 — one default place", () => {
  it("the profile's choice, else the place marked default, else the first made, else the Home preset", async () => {
    const userId = (await makeTestUser(db, { timezone: "America/Los_Angeles" })).userId;
    const place = (id: string, created: number, isDefault: boolean, equipment: string[]) => ({
      id, userId, name: id, equipment, implements: {}, isDefault, createdAt: at(day(created)), updatedAt: at(day(created)),
    });
    const [p1, p2, p3] = [`${userId}-first`, `${userId}-marked`, `${userId}-chosen`];
    const placeOf = async () => data((await call("validate_workout", ctxOf(await run({ userId })), { doc: calmDoc(), date: TODAY })).result).place;
    expect(await placeOf()).toEqual({ id: "home", default: true });
    expect(await defaultPlace(db, userId)).toMatchObject({ id: "home" });
    await db.insert(schema.locations).values([place(p1, 30, false, ["mat"]), place(p3, 10, false, ["band"])]);
    expect(await placeOf()).toEqual({ id: p1, default: true });
    await db.insert(schema.locations).values(place(p2, 20, true, ["bench"]));
    expect(await placeOf()).toEqual({ id: p2, default: true });
    await db.insert(schema.athleteProfiles).values({ id: userId, userId, preferences: { defaultPlaceId: p3 }, updatedAt: at(day(1)) });
    expect(await placeOf()).toEqual({ id: p3, default: true });
    expect(await defaultPlace(db, userId)).toMatchObject({ id: p3, equipment: ["band"] });
    // The Studio's library judges its gear at the same place.
    expect((await listLibrary(db, userId, { limit: 1 })).place).toMatchObject({ id: p3 });
  });

  it("search_library's place filter and validate_workout judge a place's gear the same way: the athlete's, a preset, or none at all", async () => {
    const r = await run();
    const kettle = EXERCISES.find((e) => e.equipment.all.length === 1 && e.equipment.all[0] === "kettlebell")!;
    for (const place of [rich.placeId, rich.gymId, "gym", "mat", NO_EQUIPMENT_PLACE]) {
      const found = data(await searchLibraryTool.run(ctxOf(r), { query: kettle.name, filters: { place }, limit: 30 }));
      const offered = (found.moves as Array<{ id: string }>).some((m) => m.id === kettle.id);
      const v = data((await call("validate_workout", ctxOf(r), { doc: docOf([item(kettle.id)], { setting: { placeId: place } }), date: TODAY })).result);
      const lacking = (v.warnings as Array<{ code: string }>).some((w) => w.code === "equipment_unavailable");
      expect(offered, String(place)).toBe(!lacking);
    }
  });
});

// ── Follow-up minors (re-review N2, N3, N6) ─────────────────────────────────────────────────────────────────────────

describe("follow-up — a kept free-text move is kept, never multiplied, and only from the athlete's own live workout", () => {
  it("a draft can't hold the base's free-text move twice (N2)", async () => {
    const r = await run();
    const workoutId = await withFreeMove(rich.userId, "Sandbag carry");
    const [row] = await db.select().from(schema.plannedWorkouts).where(eq(schema.plannedWorkouts.id, workoutId));
    const base = JSON.parse(row!.workoutDoc!) as Record<string, any>;
    const twice: Record<string, any> = structuredClone(base);
    twice.parts[0].items.push(structuredClone(base.parts[0].items[1]));
    const e = err((await call("validate_workout", ctxOf(r), { doc: twice, date: TODAY, workoutId })).result);
    expect(e.error).toBe("free_text_move");
    expect(e.why).toContain("parts[0].items[2]");
    expect(err((await call("propose_workout", ctxOf(r), { doc: twice, target: { kind: "revise", workoutId, baseRev: 1 } })).result).error).toBe("free_text_move");
    // Once, as it was: kept.
    expect(data((await call("validate_workout", ctxOf(r), { doc: base, date: TODAY, workoutId })).result).valid).toBe(true);
  });

  it("validate_workout's base is the athlete's own workout, not archived (N3)", async () => {
    const r = await run();
    const theirs = await withFreeMove(high.userId, "Sled push");
    const [row] = await db.select().from(schema.plannedWorkouts).where(eq(schema.plannedWorkouts.id, theirs));
    const doc = JSON.parse(row!.workoutDoc!) as Record<string, any>;
    // Another athlete's workout holding the same free move lends it nothing.
    expect(err((await call("validate_workout", ctxOf(r), { doc, date: TODAY, workoutId: theirs })).result).error).toBe("free_text_move");
    // An archived workout of the athlete's own lends it nothing either.
    const mine = await withFreeMove(rich.userId, "Sled push");
    await db.update(schema.plannedWorkouts).set({ archivedAt: at(day(1)) }).where(eq(schema.plannedWorkouts.id, mine));
    expect(err((await call("validate_workout", ctxOf(r), { doc, date: TODAY, workoutId: mine })).result).error).toBe("free_text_move");
  });
});

describe("follow-up — remember's quote is for one thing only (N6)", () => {
  it("is refused without replaces, or when the item it replaces isn't one the athlete confirmed", async () => {
    const r = await run({ request: "I train evenings now." });
    const stated = newId();
    await db.insert(schema.coachMemory).values({
      id: stated, userId: rich.userId, kind: "rule", body: "Trains mornings (quote test)", provenance: { source: "message", at: at(day(9)) }, learnedAt: at(day(9)),
      active: true, pinned: false, confidence: "stated", updatedAt: null,
    });
    const alone = err((await call("remember", ctxOf(r), { kind: "rule", body: "Trains evenings", confidence: "stated", quote: "I train evenings now" })).result);
    expect(alone.error).toBe("quote_unused");
    expect(alone.fix).toMatch(/confirmed/);
    expect(err((await call("remember", ctxOf(r), { kind: "rule", body: "Trains evenings", confidence: "stated", replaces: stated, quote: "I train evenings now" })).result).error).toBe("quote_unused");
    expect((tool("remember").inputSchema as any).properties.quote.description).toMatch(/only when replacing an item the athlete confirmed/i);
  });
});

// ── Batch 3A end fix wave, part B (audit-3a-agent-design.md) ────────────────────────────────────────────────────────

describe("3A-B — the act tools say what the code holds", () => {
  const runDoc = () =>
    docOf([], { parts: [{ purpose: "run", format: "steady", items: [{ kind: "run", target: { durationSec: 1800 }, effort: "easy" }] }] });
  const powerDoc = (libraryId: string, extra: Record<string, unknown> = {}) =>
    docOf([], { parts: [{ purpose: "power", format: "straight", items: [{ ...item(libraryId, { sets: 2, reps: 5 }), ...extra }] }] });

  it("B2: validate_workout refuses a run document as propose_workout does — the same error, why and fix", async () => {
    const r = await run();
    const v = err((await call("validate_workout", ctxOf(r), { doc: runDoc(), date: TODAY })).result);
    const p = err((await call("propose_workout", ctxOf(r), { doc: runDoc(), target: { kind: "new", date: TODAY } })).result);
    expect(v.error).toBe("run_unsupported");
    expect(v).toEqual(p);
    expect(v.fix).toMatch(/strength, mobility or care/);
  });

  it("correctness M5: a propose against a proposal already with the athlete is refused, and it stays pending", async () => {
    const r = await run();
    ok((await call("propose_workout", ctxOf(r), { doc: calmDoc({ title: "Kept" }), target: { kind: "new", date: TODAY } })).result);
    await db.update(schema.coachProposals).set({ status: "pending" }).where(eq(schema.coachProposals.id, designProposalId(r.id)));
    const { result, writes } = await call("propose_workout", ctxOf(r), { doc: calmDoc({ title: "Later" }), target: { kind: "new", date: TODAY } });
    const e = err(result);
    expect(e.error).toBe("proposal_pending");
    expect(`${e.why} ${e.fix}`).toBe("Your proposal is already with the athlete. Call finish.");
    expect(writes).toEqual([]);
    expect(await proposal(r.id)).toMatchObject({ status: "pending", ops: [expect.objectContaining({ doc: expect.objectContaining({ title: "Kept" }) })] });
  });

  it("correctness M5: the upsert itself never moves a pending proposal back to unreviewed (made pending between the read and the write)", async () => {
    const r = await run();
    ok((await call("propose_workout", ctxOf(r), { doc: calmDoc({ title: "Kept" }), target: { kind: "new", date: TODAY } })).result);
    let raced = false;
    const racingDb = new Proxy(db, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (prop !== "all" || typeof value !== "function") return value;
        return async (q: { queryChunks?: Array<{ value?: unknown }> }) => {
          const text = (q.queryChunks ?? []).map((c) => (Array.isArray(c?.value) ? c.value.join("") : "")).join("");
          if (!raced && text.includes("INSERT INTO coach_proposals")) {
            raced = true;
            await db.update(schema.coachProposals).set({ status: "pending" }).where(eq(schema.coachProposals.id, designProposalId(r.id)));
          }
          return (value as (q: unknown) => Promise<unknown>).call(target, q);
        };
      },
    });
    const e = err(await tool("propose_workout").run({ ...ctxOf(r), db: racingDb }, { doc: calmDoc({ title: "Later" }), target: { kind: "new", date: TODAY } }));
    expect(raced).toBe(true);
    expect(e.error).toBe("proposal_changed");
    expect(await proposal(r.id)).toMatchObject({ status: "pending", ops: [expect.objectContaining({ doc: expect.objectContaining({ title: "Kept" }) })] });
  });

  it("M6: an unknown move's fix points at search_library, with or without a near guess", async () => {
    const r = await run();
    const v = data((await call("validate_workout", ctxOf(r), { doc: docOf([item("zzzzqqq"), item("Goblet squats")]), date: TODAY })).result);
    const unknown = v.errors.filter((e: { code: string }) => e.code === "unknown_exercise");
    expect(unknown).toHaveLength(2);
    for (const e of unknown) expect(e.fix).toMatch(/search_library/);
    // A near guess is still offered first.
    expect(unknown[1].fix).toMatch(/^"gobletSquat"/);
    // The refusal at propose carries the same fix.
    expect(err((await call("propose_workout", ctxOf(r), { doc: docOf([item("zzzzqqq")]), target: { kind: "new", date: TODAY } })).result).why).toMatch(/search_library/);
  });

  it("M6: a gated move on a day ahead is never offered a stand-in from another family — the same family when one passes, else none", async () => {
    const r = await run();
    const byId = new Map(EXERCISES.map((e) => [e.id, e]));
    const plyo = EXERCISES.filter((e) => e.contraction.includes("plyometric"));
    expect(plyo.length).toBeGreaterThan(3);
    for (const rec of plyo) {
      const v = data((await call("validate_workout", ctxOf(r), { doc: powerDoc(rec.id), date: day(-2) })).result);
      const gate = [...v.errors, ...v.warnings].find((i: { code: string; path: string }) => i.code === "condition_gate_pending" && i.path === "parts[0].items[0].libraryId");
      expect(gate, rec.id).toBeDefined();
      if (gate.fix === undefined) expect(gate.message, rec.id).toMatch(/search_library/);
      else expect(byId.get(gate.fix)?.family, `${rec.id} → ${gate.fix}`).toBe(rec.family);
    }
    // Pogo hops were offered a box squat (another family, another quality): nothing of their family passes, so none.
    const pogo = data((await call("validate_workout", ctxOf(r), { doc: powerDoc("pogoHop"), date: day(-2) })).result);
    expect(pogo.errors.find((i: { code: string }) => i.code === "condition_gate_pending")?.fix).toBeUndefined();
    // A designer's own alternate that passes is still the warning's swap.
    const own = data((await call("validate_workout", ctxOf(r), { doc: powerDoc("pogoHop", { alternates: [{ libraryId: "calfRaise" }] }), date: day(-2) })).result);
    expect(own.warnings.find((i: { code: string }) => i.code === "condition_gate_pending")?.fix).toBe("calfRaise");
  });

  it("M7: an objective or key result id the athlete doesn't have is refused — at validate and at propose — and their own ids pass", async () => {
    const r = await run();
    const [kr] = await db.select({ id: schema.keyResults.id }).from(schema.keyResults).where(eq(schema.keyResults.objectiveId, `${rich.userId}-obj-hold`));
    const withIds = (objectiveIds: string[], keyResultId?: string) => {
      const sit = { ...item("wallSit", { holdSec: 30, max: true }), ...(keyResultId ? { test: { keyResultId } } : {}) };
      return docOf([sit], { intent: { summary: "Test the wall sit.", goals: ["strength"], focus: [], effort: "maintain", objectiveIds }, parts: [{ purpose: "main", format: "holds", items: [sit] }] });
    };
    const good = withIds([`${rich.userId}-obj-hold`], kr!.id);
    expect(data((await call("validate_workout", ctxOf(r), { doc: good, date: TODAY })).result).valid).toBe(true);
    for (const bad of [withIds(["obj-invented"]), withIds([`${rich.userId}-obj-dropped`]), withIds([`${rich.userId}-obj-hold`], "kr-invented")]) {
      const v = err((await call("validate_workout", ctxOf(r), { doc: bad, date: TODAY })).result);
      expect(v.error).toBe("unknown_objective");
      expect(v.fix).toMatch(/read_objectives/);
      expect(err((await call("propose_workout", ctxOf(r), { doc: bad, target: { kind: "new", date: TODAY } })).result).error).toBe("unknown_objective");
    }
    // Another athlete's objective is none of this one's.
    const other = await seedRichAthlete(db);
    expect(err((await call("validate_workout", ctxOf(r), { doc: withIds([`${other.userId}-obj-hold`]), date: TODAY })).result).error).toBe("unknown_objective");
    ok((await call("propose_workout", ctxOf(r), { doc: good, target: { kind: "new", date: TODAY } })).result);
  });

  it("M7: the ids are read in the statement the tools already run — validate's and propose's costs are unchanged", async () => {
    const r = await run();
    const doc = docOf([item("bridge")], { intent: { summary: "x", goals: [], focus: [], effort: "maintain", objectiveIds: [`${rich.userId}-obj-hold`] } });
    expect((await call("validate_workout", ctxOf(r), { doc, date: TODAY })).count).toBeLessThanOrEqual(tool("validate_workout").statementCost);
    expect(tool("validate_workout").statementCost).toBe(6);
    expect(tool("propose_workout").statementCost).toBe(9);
  });

  it("M16: a focus-area id from the profile stands for its refs — no unknown_focus, and the proposal keeps the library ids", async () => {
    const r = await run();
    // "upper-back" is a library region and also a focus area's id (refs upper-back and thoracic): the library's id stays.
    const doc = docOf([item("bandRow", { sets: 2, reps: 12 })], { intent: { summary: "Mid-back.", goals: ["posture"], focus: ["mid-back", "upper-back", "glutes"], effort: "maintain" } });
    const v = data((await call("validate_workout", ctxOf(r), { doc, date: TODAY })).result);
    expect(v.warnings.filter((w: { code: string }) => w.code === "unknown_focus")).toEqual([]);
    ok((await call("propose_workout", ctxOf(r), { doc, target: { kind: "new", date: TODAY } })).result);
    expect((await proposal(r.id))!.ops[0]!.doc.intent.focus).toEqual(["upper-back", "rhomboids", "glutes"]);
    // Neither a library id nor a focus area: still the validator's warning.
    const odd = data((await call("validate_workout", ctxOf(r), { doc: docOf([item("bandRow")], { intent: { summary: "x", goals: [], focus: ["elbows-ish"], effort: "maintain" } }), date: TODAY })).result);
    expect(odd.warnings.map((w: { code: string }) => w.code)).toContain("unknown_focus");
    expect((WORKOUT_DOC_JSON_SCHEMA as any).properties.intent.properties.focus.items.description).toMatch(/focus-area id/);
  });

  it("M4: the document's place fields say what they mean — the presets named, a bare room's props, equipment as what the workout uses", () => {
    const setting = (WORKOUT_DOC_JSON_SCHEMA as any).properties.setting.properties;
    expect(setting.placeId.description).toMatch(/home, gym or mat/);
    expect(setting.placeId.description).toContain('"none": a bare room — wall, chair, mat, towel');
    expect(setting.equipment.description).toMatch(/the gear this workout uses/i);
    expect(setting.equipment.description).toMatch(/placeId decides/);
    expect((searchLibraryTool.inputSchema as any).properties.filters.properties.place.description).toContain('"none": a bare room — wall, chair, mat, towel');
  });

  it("M5 and M15: propose's description keeps the best version; role-limited tools name their roles", () => {
    expect(tool("propose_workout").description).not.toMatch(/replace yours/);
    expect(tool("propose_workout").description).toMatch(/better-scoring/);
    expect(tool("propose_workout").description).toMatch(/main coach.*designers/);
    expect(tool("record_answer").description).toMatch(/main coach only/);
    expect(tool("finish").description).toMatch(/main coach and designers/);
    expect(tool("remember").description).toMatch(/main coach and designers/);
  });

  it("M8: words typed to a check-in question with chips stay the run's answer — never kept as the check-in's", () => {
    const energy = { text: "How is your energy?", why: "It sets the effort.", checkin: { question: "energy" }, chips: [{ label: "low", value: 3 }, { label: "good", value: 7 }] };
    const sore = { text: "Calves?", why: "Load.", checkin: { question: "soreness", area: "calves" }, chips: [{ label: "fine", value: 0 }, { label: "sore", value: 5 }] };
    const both = askedAnswerRows({ userId: "u", mainRunId: "m", toolUseId: "t", questions: [energy, sore], answers: ["running on fumes", "SORE"], localDate: TODAY, at: NOW.toISOString() });
    expect(both.rows.map((x) => [x.questionId, x.valueNum, x.valueChoice, x.text])).toEqual([["soreness", 5, "sore", null]]);
    expect(askedAnswerRows({ userId: "u", mainRunId: "m", toolUseId: "t", questions: [sore], answers: ["a bit, after the hills"], localDate: TODAY, at: NOW.toISOString() }).rows).toEqual([]);
  });
});

describe("3A-B — a set's designers and reviewers read the set so far (B8, M13)", () => {
  async function setOfTwo() {
    const main = await run({ scope: { kind: "week" } });
    const one = await run({ role: "designer", parentId: main.id, scope: { kind: "week" } });
    const two = await run({ role: "designer", parentId: main.id, scope: { kind: "week" } });
    ok((await call("propose_workout", ctxOf(one), { doc: calmDoc({ title: "Monday hips" }), target: { kind: "new", date: day(-1) } })).result);
    return { main, one, two };
  }

  it("a designer sees its siblings — date, title, minutes, parts and moves — before it drafts, in one statement", async () => {
    const { two } = await setOfTwo();
    const { result, count } = await call("read_set", ctxOf(two), {});
    expect(count).toBeLessThanOrEqual(1);
    expect(tool("read_set").statementCost).toBe(1);
    const d = data(result);
    expect(d.workouts).toHaveLength(1);
    const [w] = d.workouts;
    expect(w).toMatchObject({ date: day(-1), title: { untrusted: true, text: "Monday hips" }, minutes: expect.any(Number), parts: ["main"], moves: calmDoc().parts[0]!.items.map((i) => (i as { libraryId: string }).libraryId) });
    expect(w.yours).toBe(false);
    // Keys are the main coach's (its plan's rounds): a designer's view leaves them out.
    expect(w).not.toHaveProperty("key");
    expect(ok(result).missing).toEqual([]);
  });

  it("its own workout is marked once proposed, and the moves repeated on the next day are named", async () => {
    const { two } = await setOfTwo();
    ok((await call("propose_workout", ctxOf(two), { doc: calmDoc({ title: "Tuesday hips" }), target: { kind: "new", date: day(-2) } })).result);
    const d = data((await call("read_set", ctxOf(two), {})).result);
    expect(d.workouts.map((w: { date: string; yours: boolean }) => [w.date, w.yours])).toEqual([[day(-1), false], [day(-2), true]]);
    expect(d.movesRepeatedOnConsecutiveDays).toEqual([{ days: [day(-1), day(-2)], moves: expect.arrayContaining(["bridge"]) }]);
  });

  it("a reviewer reads the set of the draft it reviews, the workout under review marked as such — never `yours` (round 2, B-M5)", async () => {
    const { main, two } = await setOfTwo();
    ok((await call("propose_workout", ctxOf(two), { doc: calmDoc({ title: "Tuesday hips" }), target: { kind: "new", date: day(-2) } })).result);
    const reviewer = await run({ role: "reviewer", parentId: two.id, scope: { kind: "week" } });
    const reviewOf = { proposalId: designProposalId(main.id), designerRunId: two.id, toolUseId: "t", round: 1 };
    const { result, count } = await call("read_set", ctxOf(reviewer, { reviewOf }), {});
    expect(count).toBeLessThanOrEqual(1);
    const workouts = data(result).workouts as Array<{ title: { text: string }; underReview: boolean }>;
    expect(workouts.map((w) => [w.title.text, w.underReview])).toEqual([["Monday hips", false], ["Tuesday hips", true]]);
    for (const w of workouts) expect(w).not.toHaveProperty("yours");
  });

  it("a revision's reviewer sees the revision under review — not the version the proposal holds (round 2, B-M5)", async () => {
    const main = await run({ scope: { kind: "week" } });
    const designer = await run({ role: "designer", parentId: main.id, scope: { kind: "week" } });
    const reviewer = await run({ role: "reviewer", parentId: designer.id, scope: { kind: "week" } });
    const held = calmDoc({ title: "Tuesday hips" });
    const revised = calmDoc({ title: "Tuesday hips, shorter rests" });
    const op = {
      kind: "doc_workout", target: { kind: "new", date: day(-2) }, date: day(-2), doc: held,
      review: { scores: { intent: 3 }, notes: { intent: "Rests too long." }, mustFix: ["Shorter rests."], improvements: [], rounds: 1, changes: [] },
      issues: [], derived: { minutes: 30 }, by: { runId: designer.id, role: "designer" }, toolUseId: "t1", at: NOW.toISOString(),
      candidate: { round: 2, toolUseId: "t2", reviewRunId: reviewer.id, target: { kind: "new", date: day(-2), time: "18:00" }, date: day(-2), time: "18:00", doc: revised, issues: [], derived: { minutes: 25 }, at: NOW.toISOString() },
    };
    await db.insert(schema.coachProposals).values({
      id: designProposalId(main.id), userId: rich.userId, planId: null, title: "Tuesday hips", evidence: "", rationale: "", flags: [], ops: [op], status: "unreviewed", createdAt: NOW.toISOString(), expiresAt: day(-2),
    });
    const reviewOf = { proposalId: designProposalId(main.id), designerRunId: designer.id, toolUseId: "t2", round: 2 };
    const { result, count } = await call("read_set", ctxOf(reviewer, { reviewOf }), {});
    expect(count).toBe(1);
    const [w] = data(result).workouts as Array<Record<string, unknown>>;
    expect(w).toMatchObject({ underReview: true, title: { untrusted: true, text: "Tuesday hips, shorter rests" }, time: "18:00", minutes: 25, review: null });
    // Only the reviewer of that draft sees it: one whose draft is the version held sees the version held.
    const held1 = { ...reviewOf, toolUseId: "t1", round: 1 };
    const first = data((await call("read_set", ctxOf(reviewer, { reviewOf: held1 }), {})).result).workouts[0] as Record<string, unknown>;
    expect(first).toMatchObject({ underReview: true, title: { untrusted: true, text: "Tuesday hips" }, minutes: 30 });
    expect(first).not.toHaveProperty("time");
    // The designer, by contrast, reads the version its proposal holds, with its review.
    const mine = data((await call("read_set", ctxOf(designer), {})).result).workouts[0] as Record<string, unknown>;
    expect(mine).toMatchObject({ yours: true, title: { untrusted: true, text: "Tuesday hips" }, minutes: 30, review: { mustFixCount: 1 } });
  });

  it("a redo's reviewer sees the first version marked `replacedBy`, and the set judged with the redo in its place: a redo that removes a hard pair isn't flagged for it (round-2 minors)", async () => {
    const main = await run({ scope: { kind: "week" } });
    const one = await run({ role: "designer", parentId: main.id, scope: { kind: "week" } });
    const two = await run({ role: "designer", parentId: main.id, scope: { kind: "week" } });
    const hard = (title: string) => ({ ...calmDoc({ title }), intent: { ...calmDoc().intent, effort: "develop" } });
    ok((await call("propose_workout", ctxOf(one), { doc: hard("Monday power"), target: { kind: "new", date: day(-1) } })).result);
    ok((await call("propose_workout", ctxOf(two), { doc: hard("Tuesday power"), target: { kind: "new", date: day(-2) } })).result);
    // Two hard days in a row; the main coach asks for Tuesday again.
    const redo = await run({ role: "designer", parentId: main.id, scope: { kind: "week" } });
    await db.update(schema.coachRuns).set({ state: JSON.stringify({ replaces: two.id }) }).where(eq(schema.coachRuns.id, redo.id));
    ok((await call("propose_workout", ctxOf(redo, { replaces: two.id, toolUseId: "t-redo" }), { doc: docOf([item("bandRow")], { title: "Tuesday, easier" }), target: { kind: "new", date: day(-2) } })).result);
    const reviewer = await run({ role: "reviewer", parentId: redo.id, scope: { kind: "week" } });
    const reviewOf = { proposalId: designProposalId(main.id), designerRunId: redo.id, toolUseId: "t-redo", round: 1 };
    const { result, count } = await call("read_set", ctxOf(reviewer, { reviewOf }), {});
    expect(count).toBe(1);
    const d = data(result);
    const marks = (d.workouts as Array<Record<string, unknown> & { title: { text: string } }>).map((w) => [w.title.text, w.underReview, w.replacedBy ?? null]);
    expect(marks).toEqual([
      ["Monday power", false, null],
      ["Tuesday power", false, redo.id],
      ["Tuesday, easier", true, null],
    ]);
    // Judged with the redo in its place: no hard pair, and none of Monday's moves repeated — the redo uses others (the first
    // version, which repeats them, is the one it replaces).
    expect(d.hardDaysInARow.count).toBe(0);
    expect(d.movesRepeatedOnConsecutiveDays).toEqual([]);
    expect(d.combined.minutes).toBe((d.workouts as Array<{ minutes: number }>).filter((_, i) => i !== 1).reduce((s, w) => s + w.minutes, 0));
    // The reviewer of a first design (no redo) sees nothing replaced: both of Tuesday's count, and so does the hard pair.
    const plain = data((await call("read_set", ctxOf(reviewer, { reviewOf: { ...reviewOf, designerRunId: one.id } }), {})).result);
    for (const w of plain.workouts as Array<Record<string, unknown>>) expect(w).not.toHaveProperty("replacedBy");
    expect(plain.hardDaysInARow.count).toBe(1);
    expect(plain.movesRepeatedOnConsecutiveDays).toEqual([{ days: [day(-1), day(-2)], moves: expect.arrayContaining(["bridge"]) }]);
  });

  it("read_set's description names its marks: yours, firstVersion, underReview, replacedBy (round-2 minors)", () => {
    const text = tool("read_set").description;
    for (const mark of ["yours", "firstVersion", "underReview", "replacedBy"]) expect(text, mark).toContain(mark);
    expect(text.length).toBeLessThanOrEqual(400);
  });

  it("a redo's designer sees the first version it redoes marked `firstVersion` (round 2, B-M5)", async () => {
    const { main, one } = await setOfTwo();
    const redo = await run({ role: "designer", parentId: main.id, scope: { kind: "week" } });
    const d = data((await call("read_set", ctxOf(redo, { replaces: one.id }), {})).result);
    expect(d.workouts).toHaveLength(1);
    expect(d.workouts[0]).toMatchObject({ title: { text: "Monday hips" }, yours: false, firstVersion: true });
    // A designer that redoes nothing sees no first version.
    const plain = data((await call("read_set", ctxOf(redo), {})).result);
    expect(plain.workouts[0]).not.toHaveProperty("firstVersion");
  });

  it("before any sibling is proposed: says so, never 'call plan_set' (that is the main coach's)", async () => {
    const main = await run({ scope: { kind: "week" } });
    const first = await run({ role: "designer", parentId: main.id, scope: { kind: "week" } });
    const r = ok((await call("read_set", ctxOf(first), {})).result);
    expect((r.data as { workouts: unknown[] }).workouts).toEqual([]);
    expect(r.missing).toEqual(["no workout of the set is proposed yet"]);
  });

  it("a set too big to show whole gives way in order — the intents, then the parts, then the moves — and fits its budget", async () => {
    const main = await run({ scope: { kind: "week" } });
    const designer = await run({ role: "designer", parentId: main.id, scope: { kind: "week" } });
    const moves = EXERCISES.slice(0, 40).map((e) => e.id);
    const ops = [0, 1, 2, 3, 4, 5, 6].map((i) => {
      const doc = calmDoc({ title: `Day ${i} ${"t".repeat(70)}` });
      return {
        kind: "doc_workout", target: { kind: "new", date: day(-i) }, date: day(-i),
        doc: { ...doc, intent: { ...doc.intent, summary: "s".repeat(200) }, parts: Array.from({ length: 12 }, (_, p) => ({ purpose: p % 2 ? "accessory" : "conditioning", format: "straight", items: [{ kind: "exercise", libraryId: moves[(i * 3 + p) % moves.length]!, dose: { sets: 1, reps: 5 } }] })) },
        review: { scores: {}, notes: {}, mustFix: ["m".repeat(80), "n".repeat(80)], improvements: [], rounds: 1, changes: [] },
        issues: [], derived: { minutes: 30, regions: { glutes: 1, core: 1, hips: 1 } }, by: { runId: `d${i}`, role: "designer" }, toolUseId: `u${i}`, at: NOW.toISOString(),
      };
    });
    await db.insert(schema.coachProposals).values({
      id: designProposalId(main.id), userId: rich.userId, planId: null, title: "7 workouts", evidence: "", rationale: "", flags: [], ops, status: "unreviewed", createdAt: NOW.toISOString(), expiresAt: day(-6),
    });
    const r = ok((await call("read_set", ctxOf(designer), {})).result);
    const { summary: _s, ...forModel } = r;
    expect(new TextEncoder().encode(JSON.stringify(forModel)).length).toBeLessThanOrEqual(RESULT_BUDGET_BYTES);
    const workouts = (r.data as { workouts: Array<Record<string, unknown> & { review: Record<string, unknown> }> }).workouts;
    expect(workouts).toHaveLength(7);
    // This set stops at the moves: they are gone, the must-fix wording (the next to give way) is still there…
    for (const w of workouts) {
      expect(w.moves).toBeUndefined();
      expect(w.review.mustFix).toBeDefined();
      // …and what gives way before the moves is gone with them.
      expect(w.parts).toBeUndefined();
      expect(w.intent).toBeUndefined();
    }
  });

  it("is every role's now; its description names the repeated-moves field", () => {
    expect(tool("read_set").roles).toEqual(["main", "designer", "reviewer"]);
    expect(tool("read_set").description).toMatch(/moves repeated on consecutive days/);
    expect(tool("read_set").description).toMatch(/designers and reviewers/);
  });
});

// ── Batch 3A end fix wave, round 2 (part B's re-review) ─────────────────────────────────────────────────────────────

describe("3A round 2 — the act tools' gates and tests", () => {
  const powerDoc = (libraryId: string) => docOf([], { parts: [{ purpose: "power", format: "straight", items: [item(libraryId, { sets: 2, reps: 5 })] }] });
  const GATES = ["condition_gate", "condition_pattern"];
  // The call as ask_athlete takes it: copied literally, it is never refused (round-2 minors: `why` is required).
  const ASK = 'if no check is logged today, the main coach may ask_athlete({ check: "condition", why })';
  const gateOf = (v: { errors: Array<{ code: string; path: string; message: string; fix?: string }> }) =>
    v.errors.find((i) => GATES.includes(i.code) && i.path === "parts[0].items[0].libraryId");
  /** The same athlete with no condition check today at all. */
  async function unchecked() {
    const a = await seedRichAthlete(db);
    await db.delete(schema.conditionChecks).where(eq(schema.conditionChecks.userId, a.userId));
    return a;
  }

  it("B-M7: a move today's check closes is offered a stand-in only from its own family — none from another", async () => {
    const r = await run({ userId: high.userId });
    const byId = new Map(EXERCISES.map((e) => [e.id, e]));
    let gated = 0;
    for (const rec of EXERCISES.filter((e) => e.contraction.includes("plyometric"))) {
      const gate = gateOf(data((await call("validate_workout", ctxOf(r), { doc: powerDoc(rec.id), date: TODAY })).result));
      if (!gate) continue;
      gated += 1;
      if (gate.fix === undefined) expect(gate.message, rec.id).toMatch(/No stand-in of its own family is offered: choose one yourself with search_library/);
      else expect(byId.get(gate.fix)?.family, `${rec.id} → ${gate.fix}`).toBe(rec.family);
    }
    expect(gated).toBeGreaterThan(3);
    // Pogo hops: nothing of their family passes today, so no stand-in — never a squat of another quality.
    expect(gateOf(data((await call("validate_workout", ctxOf(r), { doc: powerDoc("pogoHop"), date: TODAY })).result))?.fix).toBeUndefined();
  });

  it("B-M8: with no check logged today, a gate's refusal says the main coach may ask for it — at validate and at propose; with one logged, it doesn't", async () => {
    const none = await run({ userId: (await unchecked()).userId });
    const gate = gateOf(data((await call("validate_workout", ctxOf(none), { doc: powerDoc("pogoHop"), date: TODAY })).result))!;
    expect(gate.message).toContain(ASK);
    const refused = err((await call("propose_workout", ctxOf(none), { doc: powerDoc("pogoHop"), target: { kind: "new", date: TODAY } })).result);
    expect(refused.error).toBe("invalid_workout");
    expect(refused.fix).toContain(ASK);
    // A check is logged (7, a closed gate): asking again opens nothing.
    const logged = await run({ userId: high.userId });
    expect(gateOf(data((await call("validate_workout", ctxOf(logged), { doc: powerDoc("pogoHop"), date: TODAY })).result))!.message).not.toContain("ask_athlete");
    expect(err((await call("propose_workout", ctxOf(logged), { doc: powerDoc("pogoHop"), target: { kind: "new", date: TODAY } })).result).fix).not.toContain("ask_athlete");
  });

  it("B-M10: a test whose move its key result's measure doesn't read is an advisory note — at validate and in the draft's costs — read in the statement already run", async () => {
    const r = await run();
    const krs = await db.select({ id: schema.keyResults.id, label: schema.keyResults.label }).from(schema.keyResults).where(like(schema.keyResults.objectiveId, `${rich.userId}-obj-%`));
    const wallSit = krs.find((k) => k.label === "Wall sit hold")!.id;
    const fiveK = krs.find((k) => k.label === "5K time")!.id;
    const testOf = (libraryId: string, keyResultId: string) => {
      const t = { ...item(libraryId, { holdSec: 30, max: true }), test: { keyResultId } };
      return docOf([t], { parts: [{ purpose: "main", format: "holds", items: [t] }] });
    };
    const noteOf = (v: { warnings: Array<{ code: string; path: string; message: string; fix?: string }> }) => v.warnings.find((w) => w.code === "test_unmeasured");
    // The move the measure reads: no note.
    expect(noteOf(data((await call("validate_workout", ctxOf(r), { doc: testOf("wallSit", wallSit), date: TODAY })).result))).toBeUndefined();
    // Another move: the note names the measure, and offers the move it reads.
    const side = await call("validate_workout", ctxOf(r), { doc: testOf("sidePlank", wallSit), date: TODAY });
    expect(side.count).toBeLessThanOrEqual(tool("validate_workout").statementCost);
    const note = noteOf(data(side.result))!;
    expect(note).toMatchObject({ path: "parts[0].items[0].libraryId", fix: "wallSit" });
    expect(note.message).toContain("longest hold of wallSit");
    expect(data(side.result).valid).toBe(true);
    // A key result no move's test measures (a run's): the note, and no move to offer.
    const run5k = noteOf(data((await call("validate_workout", ctxOf(r), { doc: testOf("wallSit", fiveK), date: TODAY })).result))!;
    expect(run5k.fix).toBeUndefined();
    expect(run5k.message).toContain("fastest 5000 m");
    // The draft carries it as a cost, for the reviewer and the athlete.
    ok((await call("propose_workout", ctxOf(r), { doc: testOf("sidePlank", wallSit), target: { kind: "new", date: TODAY } })).result);
    expect((await proposal(r.id))!.ops[0]!.issues.map((i) => i.code)).toContain("test_unmeasured");
  });
});
