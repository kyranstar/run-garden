/**
 * READ_PLANS NEVER HIDES A PLAN (R1.6; DEBUG-tre-cadence §5.2). The owner's coach was asked to change TRE and never saw it:
 * the answer fits 6,500 bytes, and plans were dropped from its end to fit, so the course past the cut was counted
 * (`morePlans: 6`) but not named. Now every plan the read finds is named: in full while they fit, and the rest in short — its
 * id, its kind, its name and its schedule — and `read_plans {planId}` gives any one of them in full. A course lists its
 * settings (days, time, rhythm), and its `why` names change_plan's lever for them. One statement either way.
 *
 * Synthetic data only, on the rich fixture's fixed clock (today Wed 13 May 2026).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { schema } from "@rg/database";
import { adaptiveConfigSchema, courseConfigSchema, newId } from "@rg/domain";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { readPlans } from "../src/services/design-tools/read-plans.js";
import { RESULT_BUDGET_BYTES } from "../src/services/design-tools/read-common.js";
import { isToolErr, type ToolErr, type ToolOk } from "../src/services/design-tools/types.js";
import { at, day, NOW, seedRichAthlete } from "./design-read-fixture.js";
import { isWrite, makeTestDb } from "./helpers.js";

const ENV = {} as Env;
let db: Db;
const statements: string[] = [];
let userId: string;
let programmeId: string;

beforeEach(async () => {
  statements.length = 0;
  db = makeTestDb({ boundVariableCap: 100, onStatement: (s) => statements.push(s) });
  const rich = await seedRichAthlete(db);
  userId = rich.userId;
  programmeId = rich.programId;
});

const TRE = "course-invented-tre";

async function course(id: string, name: string, config: Record<string, unknown>, createdAt = at(day(60))) {
  await db.insert(schema.programs).values({
    id, userId, kind: "course", name, status: "active", disciplines: ["yoga"], onEnd: "continue", purpose: "Calm the nervous system",
    config: courseConfigSchema.parse({ course: "intro", time: "19:30", ...config }), createdAt, updatedAt: createdAt,
  });
}

async function block(id: string, name: string) {
  await db.insert(schema.coachPlans).values({
    id, userId, discipline: "run", name, status: "active", startDate: day(2), endDate: "2026-12-31", raceDate: null, stampPrefix: name, createdAt: at(day(10)), updatedAt: at(day(10)),
  });
}

async function session(planId: string, date: string, title: string) {
  const id = newId();
  await db.insert(schema.plannedWorkouts).values({
    id, userId, planId, sourceWorkoutId: id, title, category: "easy", sport: "run", originalPlanDate: date, lastVerifiedCorosDate: date, effectiveDate: date,
    effectiveTime: "07:00", sourceContentFingerprint: "fp", sourceEstimatedDurationSeconds: 2400, calendarBlockDurationSeconds: 3300, completionState: "scheduled",
    origin: "coach", createdAt: at(day(10)), updatedAt: at(day(10)),
  });
}

async function read(input: unknown = {}) {
  statements.length = 0;
  const res = await readPlans.run({ db, env: ENV, userId, run: { id: "run-rp", role: "main", scope: { kind: "auto" }, parentId: null, rehearsal: false }, now: NOW }, input);
  return { res, count: statements.length, writes: statements.filter(isWrite) };
}
/** A plan in short (fix round 1): `[id, name, schedule]`, or a block named in `lines` by its id alone; grouped by kind. */
type Short = string | [string, { untrusted: true; text: string }, string];
type Answer = ToolOk & {
  data: { plans: Array<Record<string, any>>; otherPlans?: Record<string, Short[]>; otherPlansNote?: string; morePlans?: number; lines?: Array<Record<string, any>> };
};
const ok = (res: ToolOk | ToolErr): Answer => {
  if (isToolErr(res)) throw new Error(`refused: ${res.error} — ${res.why}`);
  return res as Answer;
};
const bytes = (r: Answer) => Buffer.byteLength(JSON.stringify({ provenance: r.provenance, missing: r.missing, data: r.data }));
const shortIdOf = (s: Short): string => (typeof s === "string" ? s : s[0]);
/** Every plan the answer names: in full, or in short. */
const namedIds = (r: Answer): string[] => [...r.data.plans.map((p) => p.id as string), ...Object.values(r.data.otherPlans ?? {}).flat().map(shortIdOf)];

/** Ten running blocks with long names and long session titles, two watch plans, the fixture's programme, and TRE: fourteen. */
async function crowded(): Promise<string[]> {
  const long = (s: string) => `${s} ${"with a very long name the watch gave it ".repeat(4)}`.trim();
  const ids: string[] = [];
  for (let n = 0; n < 10; n++) {
    await block(`cp-crowd-${n}`, long(`Block ${n}`));
    for (let d = 1; d <= 3; d++) await session(`cp-crowd-${n}`, day(-d), long(`Session ${d}`));
    ids.push(`cp-crowd-${n}`);
  }
  for (let n = 0; n < 2; n++) {
    await db.insert(schema.trainingPlans).values({
      id: `tp-crowd-${n}`, userId, sourcePlanId: `src-${n}`, name: long(`Watch plan ${n}`), startDate: day(30), endDate: "2026-12-31", status: "active", createdAt: at(day(30)), updatedAt: at(day(30)),
    });
    ids.push(`tp-crowd-${n}`);
  }
  await course(TRE, "TRE", { weekdays: [0, 4] });
  return [...ids, programmeId, TRE];
}

describe("read_plans with more plans than fit", () => {
  it("names every one of fourteen plans: in full while they fit, the rest in short with their schedule — none counted away", async () => {
    const ids = await crowded();
    expect(ids.length).toBeGreaterThanOrEqual(12);
    const { res, count, writes } = await read();
    const r = ok(res);
    expect(count).toBe(1);
    expect(writes).toEqual([]);
    expect(bytes(r)).toBeLessThanOrEqual(RESULT_BUDGET_BYTES);
    expect(r.data.morePlans).toBeUndefined();
    const named = namedIds(r);
    for (const id of ids) expect(named, id).toContain(id);
    // Some had to go short: the answer says how to read one in full.
    expect(Object.values(r.data.otherPlans!).flat().length).toBeGreaterThan(0);
    expect(r.data.otherPlansNote).toBe(
      "Listed in short to fit the answer, by kind: [id, name, schedule] — a coach block by its id alone, its name and dates in lines. read_plans with a planId gives that plan in full.",
    );
    // The coach's own running blocks still come first, in full.
    expect(r.data.plans[0]!.kind).toBe("coach block");
  });

  it("in short: a course its days and time, a watch plan its dates, a block in lines its id alone; courses first", async () => {
    await crowded();
    const r = ok((await read()).res);
    const groups = r.data.otherPlans!;
    const all = [...r.data.plans.map((p) => [p.id, p] as const)];
    const tre = (groups.course ?? []).find((s) => shortIdOf(s) === TRE);
    if (tre) expect(tre).toEqual([TRE, { untrusted: true, text: "TRE" }, "Mon · Fri · 19:30"]);
    else expect(new Map(all).get(TRE)!.settings).toMatchObject({ days: ["Mon", "Fri"], time: "19:30", everyWeeks: 1 });
    for (const s of groups["watch plan"] ?? []) expect((s as [string, unknown, string])[2]).toMatch(/^\d{4}-\d\d-\d\d → \d{4}-\d\d-\d\d$/);
    const inLines = new Set((r.data.lines ?? []).flatMap((l) => (l.phases as Array<{ id: string }>).map((p) => p.id)));
    for (const s of groups["coach block"] ?? []) {
      if (inLines.has(shortIdOf(s))) expect(typeof s).toBe("string");
    }
    const kinds = Object.keys(groups);
    if (kinds.includes("course")) expect(kinds[0]).toBe("course");
  });

  // The review's probe (fix round 1, MINOR 4): ten of every kind, at the per-kind caps.
  it("ten of every kind — blocks, programmes, courses, watch plans — and every one still named, courses first", async () => {
    const ids: string[] = [];
    for (let n = 0; n < 10; n++) {
      const b = newId();
      await block(b, `Block ${n}`);
      const t = newId();
      await db.insert(schema.trainingPlans).values({ id: t, userId, sourcePlanId: `src-${n}`, name: `Watch plan ${n}`, startDate: day(30), endDate: "2026-12-31", status: "active", createdAt: at(day(30)), updatedAt: at(day(30)) });
      const c = `course-${newId()}-c${n}`;
      await course(c, `Course ${n}`, { weekdays: [0, 4] });
      const p = newId();
      await db.insert(schema.programs).values({ id: p, userId, kind: "adaptive", name: `Programme ${n}`, status: "active", disciplines: ["strength"], onEnd: "continue", config: adaptiveConfigSchema.parse({}), createdAt: at(day(60)), updatedAt: at(day(60)) });
      ids.push(b, t, c, p);
    }
    const { res, count } = await read();
    const r = ok(res);
    expect(count).toBe(1);
    expect(bytes(r)).toBeLessThanOrEqual(RESULT_BUDGET_BYTES);
    expect(r.data.morePlans).toBeUndefined();
    const named = new Set(namedIds(r));
    expect(ids.filter((id) => !named.has(id))).toEqual([]);
    expect(Object.keys(r.data.otherPlans ?? {})[0]).toBe("course");
  });

  it("past the read's cap of 20 a kind, the rest are counted, never dropped unsaid", async () => {
    for (let n = 0; n < 22; n++) {
      await db.insert(schema.trainingPlans).values({ id: `tp-cap-${n}`, userId, sourcePlanId: `src-cap-${n}`, name: `W${n}`, startDate: day(30), endDate: "2026-12-31", status: "active", createdAt: at(day(30)), updatedAt: at(day(30)) });
    }
    const r = ok((await read()).res);
    const named = namedIds(r).filter((id) => id.startsWith("tp-cap-"));
    expect(named.length).toBe(20);
    expect(r.data.morePlans).toBe(2);
  });

  // RECHECK X8 and X9 (fix round 2): the order holds in full as in short, and past even the short form a course is the last
  // kind counted away.
  it("in full too, a course comes before a programme", async () => {
    await course(TRE, "TRE", { weekdays: [0, 4] });
    const r = ok((await read()).res);
    const ids = r.data.plans.map((p) => p.id as string);
    expect(ids).toContain(TRE);
    expect(ids).toContain(programmeId);
    expect(ids.indexOf(TRE)).toBeLessThan(ids.indexOf(programmeId));
  });

  it("past even the short form, the watch's plans are counted away first and every course is still named", async () => {
    const long = (s: string) => `${s} ${"with a very long name ".repeat(3)}`.trim();
    const pad = (n: number, c: string) => `${String(n).padStart(2, "0")}-${c.repeat(24)}`;
    const courses: string[] = [];
    for (let n = 0; n < 20; n++) {
      const c = `course-many-${pad(n, "x")}`;
      await course(c, long(`Course ${n}`), { weekdays: [0, 2, 4] });
      courses.push(c);
      await db.insert(schema.trainingPlans).values({
        id: `tp-many-${pad(n, "y")}`, userId, sourcePlanId: `src-many-${n}`, name: long(`Watch plan ${n}`), startDate: day(30), endDate: "2026-12-31",
        status: "active", createdAt: at(day(30)), updatedAt: at(day(30)),
      });
      // Nineteen beside the fixture's own: twenty, the read's cap for a kind.
      if (n < 19) {
        await db.insert(schema.programs).values({
          id: `pg-many-${pad(n, "z")}`, userId, kind: "adaptive", name: long(`Programme ${n}`), status: "active", disciplines: ["strength"], onEnd: "continue",
          config: adaptiveConfigSchema.parse({}), createdAt: at(day(60)), updatedAt: at(day(60)),
        });
      }
    }
    const r = ok((await read()).res);
    expect(bytes(r)).toBeLessThanOrEqual(RESULT_BUDGET_BYTES);
    expect(r.data.morePlans).toBeGreaterThan(0);
    const named = new Set(namedIds(r));
    expect(courses.filter((c) => !named.has(c))).toEqual([]);
    // The watch's go first: none of them is named while a programme is counted away.
    const watchNamed = [...named].filter((id) => id.startsWith("tp-many-")).length;
    if (watchNamed > 0) expect([...named].filter((id) => id.startsWith("pg-many-")).length).toBe(19);
  });

  it("read_plans {planId} gives that plan in full, whatever else there is", async () => {
    await crowded();
    const { res, count } = await read({ planId: TRE });
    const r = ok(res);
    expect(count).toBe(1);
    expect(r.data.plans).toHaveLength(1);
    expect(r.data.plans[0]).toMatchObject({ id: TRE, kind: "course", planId: TRE, settings: { days: ["Mon", "Fri"], time: "19:30", everyWeeks: 1 } });
    expect(r.data.otherPlans).toBeUndefined();
  });

  it("read_plans {planId} of no plan of theirs says so, and how to find them", async () => {
    await crowded();
    const r = ok((await read({ planId: "no-such-plan" })).res);
    expect(r.data.plans).toEqual([]);
    expect(r.missing).toContain('no plan "no-such-plan": read_plans with no planId names them all');
  });
});

describe("a course's settings, and what changes them", () => {
  it("lists its days, time and rhythm; every 2 weeks, the Monday it counts from; its why names change_plan's lever", async () => {
    await course(TRE, "TRE", { weekdays: [0], everyWeeks: 2, cadenceFrom: "2026-05-11" });
    const r = ok((await read()).res);
    const tre = r.data.plans.find((p) => p.id === TRE)!;
    // R1.7: and its quiet days before a race, a course a race holds back (this one's definition isn't found, so it is one).
    expect(tre.settings).toEqual({ days: ["Mon"], time: "19:30", everyWeeks: 2, from: "2026-05-11", quietDaysBeforeRace: 7 });
    expect(tre.why).toBe(
      "a course: a fixed sequence, each session written on its day. Change its days, time or rhythm (everyWeeks: its days every 1 to 4 weeks), ease its next session or pause it with change_plan (its planId); skip or move one session with adjust_plan",
    );
  });
});
