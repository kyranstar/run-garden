/**
 * THE ACT TOOLS' REGISTRY AND BUDGETS (Stage 3 Task 5; spec §2, §4; principles §6.11). The registry offers every tool
 * the prompt names, except the two later tasks add (each named in `PENDING_TOOL_NAMES` until it lands). Each act tool's
 * declared statement cost is the most it runs — measured over every path the rich fixture, an empty account and the
 * refusals reach, as strict as D1 about binds — and propose_workout, the heaviest (the validator's reads, then its one
 * write), fits a model step's tool room with room to spare. Behaviour is design-act-tools.test.ts.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { schema } from "@rg/database";
import { BASED_ON_KINDS, EFFORT_LEVELS, GOAL_IDS, newId, PART_FORMATS, PART_PURPOSES, RUN_EFFORTS, workoutDocSchema } from "@rg/domain";
import { EQUIPMENT_IDS } from "@rg/exercise-library";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { MAX_TOOL_STATEMENT_COST, MODEL_STEP_FIXED, ROUTE_OVERHEAD, STEP_BUDGET, TOOL_RESULT_MAX_BYTES } from "../src/services/coach-runs.js";
import { PROMPT_TOOL_NAMES } from "../src/services/design-prompt.js";
import { WORKOUT_DOC_JSON_SCHEMA } from "../src/services/design-tools/act-common.js";
import { ACT_TOOLS, allTools, PENDING_TOOL_NAMES, READ_TOOLS } from "../src/services/design-tools/index.js";
import { isToolErr, type DesignTool, type ToolContext, type ToolErr, type ToolOk, type ToolRole } from "../src/services/design-tools/types.js";
import { at, day, NOW, seedRichAthlete, studioDoc, TODAY } from "./design-read-fixture.js";
import { calmDoc, landingsDoc } from "./doc-workout-fixture.js";
import { makeTestDb, makeTestUser } from "./helpers.js";

const ENV = {} as Env;
const ACT_NAMES = ["validate_workout", "ask_athlete", "record_answer", "remember", "propose_workout", "finish"];

let db: Db;
let counting = false;
let count = 0;
let rich: Awaited<ReturnType<typeof seedRichAthlete>>;
let empty: string;

beforeAll(async () => {
  db = makeTestDb({ boundVariableCap: 100, onStatement: () => counting && (count += 1) });
  rich = await seedRichAthlete(db);
  empty = (await makeTestUser(db, { timezone: "America/Los_Angeles" })).userId;
});

let seq = 0;
async function runRow(userId: string, o: { role?: ToolRole; parentId?: string; request?: string; scope?: string } = {}): Promise<ToolContext["run"]> {
  const id = `budget-${++seq}-${newId().slice(0, 6)}`;
  const scope = { kind: o.scope ?? "now" } as ToolContext["run"]["scope"];
  await db.insert(schema.coachRuns).values({
    id, userId, parentId: o.parentId ?? null, role: o.role ?? "main", scope: { ...scope }, request: o.request ?? "Calves sore after the hills; energy is low.",
    status: "active", state: null, steps: 0, costUsd: 0, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
  });
  return { id, role: o.role ?? "main", scope, parentId: o.parentId ?? null, rehearsal: false };
}

const tool = (name: string): DesignTool => ACT_TOOLS.find((t) => t.name === name)!;

async function measured(name: string, input: unknown, userId: string, r: ToolContext["run"], toolUseId = `toolu_${++seq}`): Promise<{ result: ToolOk | ToolErr; count: number }> {
  count = 0;
  counting = true;
  try {
    const result = await tool(name).run({ db, env: ENV, userId, run: r, now: NOW, toolUseId }, input);
    return { result, count };
  } finally {
    counting = false;
  }
}

describe("the registry", () => {
  it("offers the read tools, then the act tools; with the two still to come, exactly the tools the prompt names", () => {
    expect(ACT_TOOLS.map((t) => t.name)).toEqual(ACT_NAMES);
    expect(allTools().map((t) => t.name)).toEqual([...READ_TOOLS, ...ACT_TOOLS].map((t) => t.name));
    expect([...PENDING_TOOL_NAMES]).toEqual(["submit_review", "plan_set"]);
    const offered = [...allTools().map((t) => t.name), ...PENDING_TOOL_NAMES];
    expect(new Set(offered).size).toBe(offered.length);
    expect([...offered].sort()).toEqual([...PROMPT_TOOL_NAMES].sort());
  });

  it("each act tool: its roles, its control, a strict object schema, a short description", () => {
    const roles = Object.fromEntries(ACT_TOOLS.map((t) => [t.name, t.roles]));
    expect(roles).toEqual({
      validate_workout: ["main", "designer", "reviewer"],
      ask_athlete: ["main", "designer"],
      record_answer: ["main"],
      remember: ["main", "designer"],
      propose_workout: ["main", "designer"],
      finish: ["main", "designer"],
    });
    expect(ACT_TOOLS.filter((t) => t.control).map((t) => [t.name, t.control])).toEqual([
      ["ask_athlete", "ask"],
      ["finish", "finish"],
    ]);
    for (const t of ACT_TOOLS) {
      expect(t.inputSchema, t.name).toMatchObject({ type: "object", additionalProperties: false });
      expect(t.description.length, t.name).toBeGreaterThan(20);
      expect(t.description.length, t.name).toBeLessThanOrEqual(400);
    }
  });

  it("a field the schema does not list is refused by every act tool, naming it", async () => {
    const r = await runRow(rich.userId);
    for (const t of ACT_TOOLS) {
      const { result } = await measured(t.name, { zzz: 1 }, rich.userId, r);
      expect(isToolErr(result), t.name).toBe(true);
      expect((result as ToolErr).why, t.name).toContain('"zzz"');
    }
  });
});

describe("each act tool's declared statement cost is the most it runs", () => {
  async function most(name: string, cases: Array<{ input: unknown; userId?: string; run?: ToolContext["run"]; toolUseId?: string }>): Promise<number> {
    let max = 0;
    for (const c of cases) {
      const userId = c.userId ?? rich.userId;
      const { count: n } = await measured(name, c.input, userId, c.run ?? (await runRow(userId)), c.toolUseId);
      max = Math.max(max, n);
    }
    return max;
  }

  it("validate_workout: the athlete with the gear and history ids, the moves done cleanly, the week's sessions", async () => {
    const n = await most("validate_workout", [
      { input: { doc: calmDoc(), date: TODAY } },
      { input: { doc: landingsDoc(), date: day(-3) } },
      { input: { doc: { ...calmDoc(), setting: { placeId: rich.gymId } }, date: TODAY } },
      { input: { doc: { ...calmDoc(), setting: { placeId: "nowhere" } }, date: TODAY } },
      { input: { doc: calmDoc(), date: day(2) } },
      { input: { doc: { title: "" }, date: TODAY } },
      { input: { doc: calmDoc(), date: TODAY }, userId: empty },
      { input: {} },
    ]);
    expect(n).toBe(tool("validate_workout").statementCost);
    expect(n).toBe(6);
  });

  it("propose_workout: validate's reads (with the target row and the proposal in the first), then one write", async () => {
    const main = await runRow(rich.userId);
    const sameUse = `toolu_same_${seq}`;
    const n = await most("propose_workout", [
      { input: { doc: calmDoc(), target: { kind: "new", date: TODAY } } },
      { input: { doc: studioDoc(), target: { kind: "revise", workoutId: rich.todayDocId, baseRev: 2 } } },
      { input: { doc: calmDoc(), target: { kind: "new", date: TODAY } }, run: main, toolUseId: sameUse },
      // A replay: answered from what the first stored.
      { input: { doc: calmDoc(), target: { kind: "new", date: TODAY } }, run: main, toolUseId: sameUse },
      { input: { doc: calmDoc(), target: { kind: "revise", workoutId: rich.todayDocId, baseRev: 1 } } },
      { input: { doc: calmDoc(), target: { kind: "revise", workoutId: rich.outlineToday, baseRev: 0 } } },
      { input: { doc: calmDoc(), target: { kind: "new", date: day(3) } } },
      { input: { doc: { ...calmDoc(), parts: [{ purpose: "main", format: "straight", items: [{ kind: "exercise", libraryId: "nope", dose: { reps: 5 } }] }] }, target: { kind: "new", date: TODAY } } },
      { input: { doc: calmDoc(), target: { kind: "new", date: TODAY } }, userId: empty },
      { input: { doc: calmDoc(), target: { kind: "new", date: TODAY } }, run: await runRow(rich.userId, { scope: "week" }) },
    ]);
    expect(n).toBe(tool("propose_workout").statementCost);
    expect(n).toBe(7);
  });

  it("record_answer: the athlete with the request and focus areas, then one insert", async () => {
    const n = await most("record_answer", [
      { input: { answers: [{ question: "soreness", area: "calves", value: 6, quote: "Calves sore" }, { question: "energy", value: 3, quote: "energy is low" }] } },
      { input: { answers: [{ question: "soreness", area: "calves", value: 6, quote: "not in it" }] } },
      { input: { answers: [] } },
    ]);
    expect(n).toBe(tool("record_answer").statementCost);
    expect(n).toBe(2);
  });

  it("remember: the athlete with the run's count and the replaced item, then the insert and the supersede", async () => {
    const old = newId();
    await db.insert(schema.coachMemory).values({
      id: old, userId: rich.userId, kind: "rule", body: "Old rule", provenance: { source: "message", at: at(day(3)) }, learnedAt: at(day(3)), active: true, confidence: "stated",
    });
    const n = await most("remember", [
      { input: { kind: "fact", body: "A fact", confidence: "stated" } },
      { input: { kind: "rule", body: "New rule", confidence: "stated", replaces: old } },
      { input: { kind: "fact", body: "x", confidence: "confirmed" } },
      { input: { kind: "note", body: "x", confidence: "stated" } },
    ]);
    expect(n).toBe(tool("remember").statementCost);
    expect(n).toBe(3);
  });

  it("ask_athlete runs none (the loop writes its question); finish reads the run's proposal once", async () => {
    expect(await most("ask_athlete", [{ input: { questions: [{ text: "How long do you have?", chips: ["20 min", "40 min"], why: "Time decides the design." }] } }])).toBe(0);
    expect(tool("ask_athlete").statementCost).toBe(0);
    const main = await runRow(rich.userId);
    await measured("propose_workout", { doc: calmDoc(), target: { kind: "new", date: TODAY } }, rich.userId, main);
    expect(await most("finish", [{ input: { summary: "Done." }, run: main }, { input: { summary: "Done." } }, { input: { summary: "" } }])).toBe(1);
    expect(tool("finish").statementCost).toBe(1);
  });

  it("propose_workout fits a model step's tool room four times over, and every act tool fits the loop's per-tool cap", () => {
    const room = STEP_BUDGET - ROUTE_OVERHEAD - MODEL_STEP_FIXED;
    expect(room).toBe(30);
    expect(tool("propose_workout").statementCost * 4).toBeLessThanOrEqual(room);
    for (const t of ACT_TOOLS) expect(t.statementCost, t.name).toBeLessThanOrEqual(MAX_TOOL_STATEMENT_COST);
  });
});

describe("results stay small", () => {
  it("a draft with every item wrong answers within the loop's cut, its issues capped and counted", async () => {
    const items = Array.from({ length: 60 }, (_, i) => ({ kind: "exercise", libraryId: `nope${i}`, dose: { sets: 2, reps: 5 }, alternates: [{ libraryId: `alsoNope${i}` }] }));
    const doc = { ...calmDoc(), parts: Array.from({ length: 4 }, () => ({ purpose: "main", format: "circuit", items })) };
    const { result } = await measured("validate_workout", { doc, date: TODAY }, rich.userId, await runRow(rich.userId));
    const text = JSON.stringify((({ summary: _s, receipt: _r, ...rest }) => rest)(result as ToolOk));
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(6_500);
    expect(TOOL_RESULT_MAX_BYTES).toBe(8_000);
    const d = (result as ToolOk).data as { errors: unknown[]; moreErrors: number };
    expect(d.errors.length).toBeLessThanOrEqual(20);
    expect(d.moreErrors).toBeGreaterThan(0);
    const refused = await measured("propose_workout", { doc, target: { kind: "new", date: TODAY } }, rich.userId, await runRow(rich.userId));
    expect(JSON.stringify(refused.result).length).toBeLessThanOrEqual(4_000);
  });
});

describe("the document's JSON schema the model is given is the domain's", () => {
  const S = WORKOUT_DOC_JSON_SCHEMA as any;
  const part = S.properties.parts.items;
  const exercise = part.properties.items.items.anyOf[0];
  const dose = exercise.properties.dose;

  it("every vocabulary is the domain's own", () => {
    expect(S.properties.intent.properties.goals.items.enum).toEqual([...GOAL_IDS]);
    expect(S.properties.intent.properties.effort.enum).toEqual([...EFFORT_LEVELS]);
    expect(part.properties.purpose.enum).toEqual([...PART_PURPOSES]);
    expect(part.properties.format.enum).toEqual([...PART_FORMATS]);
    expect(part.properties.items.items.anyOf[2].properties.effort.enum).toEqual([...RUN_EFFORTS]);
    expect(S.properties.basedOn.properties.kind.enum).toEqual([...BASED_ON_KINDS]);
    expect(S.properties.setting.properties.equipment.items.enum).toEqual([...EQUIPMENT_IDS]);
    expect(part.properties.items.items.anyOf.map((i: any) => i.properties.kind.const)).toEqual(["exercise", "free_exercise", "run", "rest"]);
  });

  it("each bound it states is the zod schema's: the value at it passes, one past it fails", () => {
    const base = () => structuredClone(calmDoc()) as any;
    const probes: Array<{ name: string; bound: number; set: (d: any, v: unknown) => void; past: (n: number) => unknown; at: (n: number) => unknown }> = [];
    const text = (name: string, bound: number, set: (d: any, v: unknown) => void) =>
      probes.push({ name, bound, set, at: (n) => "x".repeat(n), past: (n) => "x".repeat(n + 1) });
    const count = (name: string, bound: number, set: (d: any, v: unknown) => void) => probes.push({ name, bound, set, at: (n) => n, past: (n) => n + 1 });
    text("title", S.properties.title.maxLength, (d, v) => (d.title = v));
    text("intent.summary", S.properties.intent.properties.summary.maxLength, (d, v) => (d.intent.summary = v));
    text("notes", S.properties.notes.maxLength, (d, v) => (d.notes = v));
    text("part why", part.properties.why.maxLength, (d, v) => (d.parts[0].why = v));
    text("item why", exercise.properties.why.maxLength, (d, v) => (d.parts[0].items[0].why = v));
    text("item cue", exercise.properties.cue.maxLength, (d, v) => (d.parts[0].items[0].cue = v));
    text("item progression", exercise.properties.progression.maxLength, (d, v) => (d.parts[0].items[0].progression = v));
    text("libraryId", exercise.properties.libraryId.maxLength, (d, v) => (d.parts[0].items[0].libraryId = v));
    count("sets", dose.properties.sets.maximum, (d, v) => (d.parts[0].items[0].dose.sets = v));
    count("restSec", dose.properties.restSec.maximum, (d, v) => (d.parts[0].items[0].dose.restSec = v));
    count("holdSec", dose.properties.holdSec.maximum, (d, v) => (d.parts[0].items[0].dose.holdSec = v));
    count("rounds", part.properties.rounds.maximum, (d, v) => (d.parts[0].rounds = v));
    count("targetMinutes", S.properties.setting.properties.targetMinutes.maximum, (d, v) => (d.setting = { targetMinutes: v }));
    for (const p of probes) {
      const ok = base();
      p.set(ok, p.at(p.bound));
      expect(workoutDocSchema.safeParse(ok).success, `${p.name} at ${p.bound}`).toBe(true);
      const bad = base();
      p.set(bad, p.past(p.bound));
      expect(workoutDocSchema.safeParse(bad).success, `${p.name} past ${p.bound}`).toBe(false);
    }
    const list = (name: string, max: number, set: (d: any, n: number) => void) => {
      const ok = base();
      set(ok, max);
      expect(workoutDocSchema.safeParse(ok).success, `${name} at ${max}`).toBe(true);
      const bad = base();
      set(bad, max + 1);
      expect(workoutDocSchema.safeParse(bad).success, `${name} past ${max}`).toBe(false);
    };
    list("parts", S.properties.parts.maxItems, (d, n) => (d.parts = Array.from({ length: n }, () => structuredClone(d.parts[0]))));
    list("items", part.properties.items.maxItems, (d, n) => (d.parts[0].items = Array.from({ length: n }, () => structuredClone(d.parts[0].items[0]))));
    list("alternates", exercise.properties.alternates.maxItems, (d, n) => (d.parts[0].items[0].alternates = Array.from({ length: n }, () => ({ libraryId: "bridge" }))));
    list("goals", S.properties.intent.properties.goals.maxItems, (d, n) => (d.intent.goals = Array.from({ length: n }, (_, i) => GOAL_IDS[i % GOAL_IDS.length])));
  });
});
