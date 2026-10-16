/**
 * THE ACT TOOLS' REGISTRY AND BUDGETS (Stage 3 Task 5; spec §2, §4; principles §6.11). The registry offers every tool
 * the prompt names, except the one a later task adds (named in `PENDING_TOOL_NAMES` until it lands). Each act tool's
 * declared statement cost is the most it runs — measured over every path the rich fixture, an empty account and the
 * refusals reach, as strict as D1 about binds — and propose_workout, the heaviest (the validator's reads, its one
 * write, and the reviewer it starts: Task 6), fits a model step's tool room with room to spare. Behaviour is
 * design-act-tools.test.ts; the review loop is design-review.test.ts.
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
import { isToolErr, type DesignTool, type ReviewHooks, type ToolContext, type ToolErr, type ToolOk, type ToolRole } from "../src/services/design-tools/types.js";
import { designProposalId } from "../src/services/design-tools/propose.js";
import { REVIEW_DIMENSIONS } from "../src/services/design-prompt.js";
import { at, day, NOW, seedRichAthlete, studioDoc, TODAY } from "./design-read-fixture.js";
import { calmDoc, landingsDoc } from "./doc-workout-fixture.js";
import { makeTestDb, makeTestUser } from "./helpers.js";

const ENV = {} as Env;
const ACT_NAMES = ["validate_workout", "ask_athlete", "record_answer", "remember", "propose_workout", "adjust_plan", "plan_set", "read_set", "drop_workout", "submit_review", "finish"];

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

async function measured(
  name: string,
  input: unknown,
  userId: string,
  r: ToolContext["run"],
  toolUseId = `toolu_${++seq}`,
  extra: Partial<ToolContext> = {},
): Promise<{ result: ToolOk | ToolErr; count: number }> {
  count = 0;
  counting = true;
  try {
    const result = await tool(name).run({ db, env: ENV, userId, run: r, now: NOW, toolUseId, ...extra }, input);
    return { result, count };
  } finally {
    counting = false;
  }
}

describe("the registry", () => {
  it("offers the read tools, then the act tools; with the one still to come, exactly the tools the prompt names", () => {
    expect(ACT_TOOLS.map((t) => t.name)).toEqual(ACT_NAMES);
    expect(allTools().map((t) => t.name)).toEqual([...READ_TOOLS, ...ACT_TOOLS].map((t) => t.name));
    expect([...PENDING_TOOL_NAMES]).toEqual([]);
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
      adjust_plan: ["main"],
      plan_set: ["main"],
      read_set: ["main", "designer", "reviewer"],
      drop_workout: ["main"],
      submit_review: ["reviewer"],
      finish: ["main", "designer"],
    });
    expect(ACT_TOOLS.filter((t) => t.control).map((t) => [t.name, t.control])).toEqual([
      ["ask_athlete", "ask"],
      ["submit_review", "finish"],
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
      // Judged as a revision: the workout's document is read in the first statement.
      { input: { doc: calmDoc(), date: TODAY, workoutId: rich.todayDocId } },
      { input: { doc: calmDoc(), date: TODAY, workoutId: "no-such" } },
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
    // Without a reviewer (the act tools' own tests): the validator's reads and the one write.
    expect(n).toBe(7);
  });

  it("propose_workout with the loop's review hooks: one statement more, the reviewer's insert — and its replays fit too", async () => {
    // The loop's hooks start the reviewer with one insert (keyed on its id: a second start inserts nothing).
    const hooks: ReviewHooks = {
      async start(req) {
        const rows = await db
          .insert(schema.coachRuns)
          .values({ id: req.reviewRunId, userId: rich.userId, parentId: "x", role: "reviewer", scope: { kind: "now" }, request: null, status: "active", state: null, steps: 0, costUsd: 0, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() })
          .onConflictDoNothing()
          .returning({ id: schema.coachRuns.id });
        return rows.length > 0;
      },
      // A reviewer that used its turns: the validator's view is settled on a replay.
      ended: () => ({ status: "stopped_cap", error: "step_cap" }),
    };
    const main = await runRow(rich.userId);
    const use = `toolu_hooked_${seq}`;
    const input = { doc: calmDoc(), target: { kind: "new", date: TODAY } };
    const first = await measured("propose_workout", input, rich.userId, main, use, { review: hooks });
    expect((first.result as ToolOk).control).toBe("review");
    // Replayed while its reviewer is over without a review: the read, the insert that finds it there, the settled op.
    const replay = await measured("propose_workout", input, rich.userId, main, use, { review: hooks });
    expect((replay.result as ToolOk).data).toMatchObject({ review: null, round: 1 });
    const revised = await measured("propose_workout", { ...input, changeNote: "Again." }, rich.userId, main, `toolu_hooked2_${seq}`, { review: hooks });
    expect((revised.result as ToolOk).control).toBe("review");
    // A reviewer that can't be started (its insert finds the id taken): the round dropped at once, one write more.
    const refusedStart = await measured("propose_workout", input, rich.userId, await runRow(rich.userId), `toolu_nostart_${seq}`, {
      review: {
        async start() {
          await db.select({ id: schema.coachRuns.id }).from(schema.coachRuns).limit(1);
          return false;
        },
        ended: () => null,
      },
    });
    expect((refusedStart.result as ToolErr).error).toBe("review_unavailable");
    const n = Math.max(first.count, replay.count, revised.count, refusedStart.count);
    expect(first.count).toBe(8);
    expect(refusedStart.count).toBe(9);
    expect(n).toBe(tool("propose_workout").statementCost);
    expect(n).toBe(9);
  });

  it("submit_review: the proposal, then the op with its review", async () => {
    const main = await runRow(rich.userId);
    const hooks: ReviewHooks = { start: async () => true, ended: () => null };
    const use = `toolu_reviewed_${seq}`;
    await measured("propose_workout", { doc: calmDoc(), target: { kind: "new", date: TODAY } }, rich.userId, main, use, { review: hooks });
    const reviewer = await runRow(rich.userId, { role: "reviewer", parentId: main.id });
    const review = {
      scores: Object.fromEntries(REVIEW_DIMENSIONS.map((d) => [d.id, 4])),
      notes: Object.fromEntries(REVIEW_DIMENSIONS.map((d) => [d.id, "Fine."])),
      mustFix: [],
      improvements: [],
    };
    const of = { reviewOf: { proposalId: designProposalId(main.id), designerRunId: main.id, toolUseId: use, round: 1 } };
    const counts = [
      (await measured("submit_review", { scores: {} }, rich.userId, reviewer, undefined, of)).count,
      (await measured("submit_review", review, rich.userId, reviewer, undefined, of)).count,
      // Settled already: read, nothing to write.
      (await measured("submit_review", review, rich.userId, reviewer, undefined, of)).count,
    ];
    expect(counts).toEqual([0, 2, 1]);
    expect(tool("submit_review").statementCost).toBe(2);
  });

  it("record_answer: the athlete with the request and focus areas, then one insert", async () => {
    const n = await most("record_answer", [
      { input: { answers: [{ question: "soreness", area: "calves", quote: "Calves sore" }, { question: "energy", quote: "energy is low" }] } },
      { input: { answers: [{ question: "soreness", area: "calves", quote: "not in it" }] } },
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

  it("ask_athlete reads the focus areas only for a check-in area the library doesn't hold (the loop writes its question); finish reads the run's proposal once", async () => {
    const q = { text: "How tight is it?", chips: [{ label: "a little", value: 2 }, { label: "a lot", value: 7 }], why: "It sets the range." };
    expect(
      await most("ask_athlete", [
        { input: { questions: [{ text: "How long do you have?", chips: ["20 min", "40 min"], why: "Time decides the design." }] } },
        { input: { questions: [{ ...q, checkin: { question: "tightness", area: "calves" } }] } },
        { input: { questions: [{ ...q, checkin: { question: "tightness", area: "desk-neck" } }] } },
      ]),
    ).toBe(1);
    expect(tool("ask_athlete").statementCost).toBe(1);
    const main = await runRow(rich.userId);
    await measured("propose_workout", { doc: calmDoc(), target: { kind: "new", date: TODAY } }, rich.userId, main);
    expect(await most("finish", [{ input: { summary: "Done." }, run: main }, { input: { summary: "Done." } }, { input: { summary: "" } }])).toBe(1);
    // Its own read; it declares one more — the loop's, once its proposal is made pending: the older plans' days it
    // covers superseded (Task 7).
    expect(tool("finish").statementCost).toBe(2);
  });

  it("adjust_plan: the athlete with the session, the proposal and the restore marker in one read, then one write — refusals and replays read only", async () => {
    const main = await runRow(rich.userId);
    const change = { workoutId: rich.outlineToday, change: { kind: "skip", reason: "Rest." }, why: "A flare day." };
    const n = await most("adjust_plan", [
      { input: change, run: main, toolUseId: "toolu_adj_budget_1" },
      // A second change of the same session replaces the first; a replay writes nothing.
      { input: { ...change, change: { kind: "move", toDate: day(-1) } }, run: main, toolUseId: "toolu_adj_budget_2" },
      { input: change, run: main, toolUseId: "toolu_adj_budget_1" },
      // Refused: a programme session re-timed, a session that isn't there, a move into the past, an empty account.
      { input: { ...change, change: { kind: "adjust", durationMinutes: 20 } } },
      { input: { ...change, workoutId: "nope" } },
      { input: { ...change, change: { kind: "move", toDate: day(2) } } },
      { input: change, userId: empty, run: await runRow(empty) },
    ]);
    expect(n).toBe(2);
    expect(tool("adjust_plan").statementCost).toBe(2);
    const refused = await measured("adjust_plan", { ...change, workoutId: "nope" }, rich.userId, await runRow(rich.userId));
    expect(refused.count).toBe(1);
  });

  it("propose_workout fits a model step's tool room three times over, and every act tool fits the loop's per-tool cap", () => {
    const room = STEP_BUDGET - ROUTE_OVERHEAD - MODEL_STEP_FIXED;
    // 28 since fix wave 3A round 2 (A-M3): a stop's proposal reserves its read and write twice over.
    expect(room).toBe(28);
    // With its reviewer (Task 6) a draft pauses the run: no call after it runs in the same step.
    expect(tool("propose_workout").statementCost * 3).toBeLessThanOrEqual(room);
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
    expect(part.properties.items.items.anyOf[1].properties.effort.enum).toEqual([...RUN_EFFORTS]);
    expect(S.properties.basedOn.properties.kind.enum).toEqual([...BASED_ON_KINDS]);
    expect(S.properties.setting.properties.equipment.items.enum).toEqual([...EQUIPMENT_IDS]);
    expect(part.properties.items.items.anyOf.map((i: any) => i.properties.kind.const)).toEqual(["exercise", "run", "rest"]);
  });

  /**
   * A document holding every field the schema names (each union by every branch it has), at values well inside every
   * bound — and where two fields must keep an order (a pace's fast ≤ slow, a heart-rate range, a range of reps), each
   * at the far end of its own, so that moving one to its own bound never crosses the other.
   */
  function fullDoc(): any {
    const everyDose = {
      sets: 3, reps: { min: 1, max: 200 }, holdSec: 30, breaths: 5, carryM: 20, perSide: true, max: true,
      tempo: { eccentricSec: 3, pauseSec: 1, concentricSec: 1 }, load: { typed: "35 lb", kg: 16 }, restSec: 60,
    };
    return {
      version: 1,
      title: "Every field",
      intent: { summary: "Every field the schema names.", goals: ["strength"], focus: ["glutes"], effort: "develop", objectiveIds: ["obj-1"] },
      setting: { placeId: "home", equipment: ["mat"], targetMinutes: 40 },
      parts: [
        {
          purpose: "main", why: "Load.", format: "straight", rounds: 2, restBetweenRoundsSec: 60,
          items: [
            { kind: "exercise", libraryId: "bridge", dose: everyDose, side: "left", why: "Why.", progression: "Up one.", cue: "Cue.", alternates: [{ libraryId: "deadBug", why: "Why." }], test: { keyResultId: "kr-1" } },
            { kind: "exercise", libraryId: "deadBug", dose: { reps: 8, load: "bodyweight" } },
            {
              kind: "run", effort: "easy", why: "Easy.", cue: "Relax.",
              target: { durationSec: 600, distanceM: 2000, typed: "2 km", open: true, pace: { fastSecPerKm: 120, slowSecPerKm: 1800 }, hr: { low: 30, high: 230 }, zone: { kind: "hr", index: 2 } },
            },
            { kind: "rest", seconds: 60 },
          ],
        },
      ],
      basedOn: { kind: "workout", id: "w-1", rev: 2 },
      // Not in the schema the model is given: the tool sets it.
      source: { kind: "coach" },
      notes: "Notes.",
    };
  }

  type Path = Array<string | number>;
  const getAt = (o: any, path: Path): any => path.reduce((v, k) => (v === undefined || v === null ? undefined : v[k]), o);
  function setAt(o: any, path: Path, value: unknown): any {
    const copy = structuredClone(o);
    const parent = getAt(copy, path.slice(0, -1));
    parent[path[path.length - 1]!] = value;
    return copy;
  }
  /** The branch of a union a value takes: by its `kind`, its constant, or its type. */
  const takes = (branch: any, v: unknown): boolean => {
    if (branch.const !== undefined) return v === branch.const;
    if (branch.type === "object") {
      const kind = branch.properties?.kind?.const;
      return !!v && typeof v === "object" && !Array.isArray(v) && (kind === undefined || (v as { kind?: unknown }).kind === kind);
    }
    if (branch.type === "integer" || branch.type === "number") return typeof v === "number";
    return typeof v === branch.type;
  };

  interface Probe { name: string; path: Path; ok: unknown; bad: unknown }
  /** Every bound the schema states, walked alongside the full document: the value at the bound, and one past it. */
  function probesOf(schema: any, path: Path, doc: any, out: Probe[]): Probe[] {
    const here = getAt(doc, path);
    const name = path.join(".");
    if (schema.anyOf) {
      for (const branch of schema.anyOf) if (takes(branch, here)) probesOf(branch, path, doc, out);
      return out;
    }
    if (schema.type === "string") {
      if (schema.maxLength !== undefined) out.push({ name: `${name} maxLength`, path, ok: "x".repeat(schema.maxLength), bad: "x".repeat(schema.maxLength + 1) });
      if (schema.minLength !== undefined) out.push({ name: `${name} minLength`, path, ok: "x".repeat(schema.minLength), bad: "x".repeat(schema.minLength - 1) });
    }
    if (schema.type === "number" || schema.type === "integer") {
      if (schema.maximum !== undefined) out.push({ name: `${name} maximum`, path, ok: schema.maximum, bad: schema.maximum + 1 });
      if (schema.minimum !== undefined) out.push({ name: `${name} minimum`, path, ok: schema.minimum, bad: schema.minimum - 1 });
    }
    if (schema.type === "array") {
      const many = (n: number) => Array.from({ length: n }, () => structuredClone(here[0]));
      if (schema.maxItems !== undefined) out.push({ name: `${name} maxItems`, path, ok: many(schema.maxItems), bad: many(schema.maxItems + 1) });
      if (schema.minItems !== undefined) out.push({ name: `${name} minItems`, path, ok: many(schema.minItems), bad: many(schema.minItems - 1) });
      (here as unknown[]).forEach((_, i) => probesOf(schema.items, [...path, i], doc, out));
    }
    if (schema.type === "object" && schema.properties) {
      for (const [key, sub] of Object.entries(schema.properties)) if (here?.[key] !== undefined) probesOf(sub, [...path, key], doc, out);
    }
    return out;
  }

  it("every bound it states is the zod schema's: the value at it passes, one past it fails — walked over every field", () => {
    const doc = fullDoc();
    expect(workoutDocSchema.safeParse(doc).error?.issues ?? []).toEqual([]);
    const probes = probesOf(S, [], doc, []);
    // Every bounded field the schema names is reached (the walk can't pass by skipping them).
    expect(probes.length).toBeGreaterThanOrEqual(60);
    const wrong: string[] = [];
    for (const p of probes) {
      if (!workoutDocSchema.safeParse(setAt(doc, p.path, p.ok)).success) wrong.push(`${p.name}: the bound itself is refused`);
      if (workoutDocSchema.safeParse(setAt(doc, p.path, p.bad)).success) wrong.push(`${p.name}: one past it is accepted`);
    }
    expect(wrong).toEqual([]);
  });
});
