/**
 * read_plans (§8 §5, stream W): the conversation coach reads the athlete's plans — its own coach blocks, the athlete's
 * adaptive programmes and the watch's plans — each with its id, kind, name, dates, race day, firm and shape weeks, the
 * next three sessions, and whether the coach may change its structure (only a block it wrote, still running). One
 * statement. Synthetic data only, on the rich fixture's fixed clock (today Wed 13 May 2026).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, newId } from "@rg/domain";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { loadNonCoachPlanEntries } from "../src/services/coach-plans.js";
import { STUDIO_PLAN_RETIRED } from "../src/services/studio-push.js";
import { READ_TOOLS } from "../src/services/design-tools/index.js";
import { readPlans } from "../src/services/design-tools/read-plans.js";
import { RESULT_BUDGET_BYTES } from "../src/services/design-tools/read-common.js";
import { isToolErr, type ToolErr, type ToolOk } from "../src/services/design-tools/types.js";
import { at, day, NOW, OTHER_SENTINEL, seedOtherAthlete, seedRichAthlete, TODAY } from "./design-read-fixture.js";
import { isWrite, makeTestDb, makeTestUser } from "./helpers.js";

/** The words read_plans puts where it once said "plan what comes after it as a new plan" (training lines §3.7). */
const CONTINUE_LINE = "To continue a line, propose its next phase starting the day after the line's last phase ends; it joins the line.";

const ENV = {} as Env;
let db: Db;
const statements: string[] = [];
let rich: Awaited<ReturnType<typeof seedRichAthlete>>;
let other: Awaited<ReturnType<typeof seedOtherAthlete>>;

beforeEach(async () => {
  statements.length = 0;
  db = makeTestDb({ boundVariableCap: 100, onStatement: (s) => statements.push(s) });
  rich = await seedRichAthlete(db);
  other = await seedOtherAthlete(db);
});

/** A coach block of the athlete's, with its weeks. */
async function block(userId: string, o: { id: string; name: string; status?: string; start: string; end: string; race?: string | null; discipline?: string; weeks?: Array<{ weekStart: string; state: "firm" | "shape"; volumeTarget?: string; keySessions?: string[] }> }) {
  await db.insert(schema.coachPlans).values({
    id: o.id, userId, discipline: o.discipline ?? "run", name: o.name, status: o.status ?? "active", startDate: o.start, endDate: o.end,
    raceDate: o.race ?? null, stampPrefix: o.name, createdAt: at(day(10)), updatedAt: at(day(10)),
  });
  for (const w of o.weeks ?? []) {
    await db.insert(schema.coachPlanWeeks).values({
      id: `${o.id}-${w.weekStart}`, planId: o.id, weekStart: w.weekStart, state: w.state,
      shape: w.state === "shape" ? { volumeTarget: w.volumeTarget ?? "about 30 km", keySessions: w.keySessions ?? ["long run"] } : null,
    });
  }
}

/** A planned session in a plan. */
async function session(userId: string, planId: string, date: string, o: { title?: string; category?: string; state?: string; archived?: boolean; time?: string; minutes?: number } = {}) {
  const id = newId();
  await db.insert(schema.plannedWorkouts).values({
    id, userId, planId, sourceWorkoutId: id, title: o.title ?? "Easy run", category: o.category ?? "easy", sport: "run",
    originalPlanDate: date, lastVerifiedCorosDate: date, effectiveDate: date, effectiveTime: o.time ?? "07:00", sourceContentFingerprint: "fp",
    sourceEstimatedDurationSeconds: (o.minutes ?? 40) * 60, calendarBlockDurationSeconds: (o.minutes ?? 40) * 60 + 900,
    completionState: o.state ?? "scheduled", origin: "coach", archivedAt: o.archived ? at(day(1)) : null, createdAt: at(day(10)), updatedAt: at(day(10)),
  });
  return id;
}

/** A Studio plan of the athlete's: its brief's start and weeks, its pushes' statuses, retired by the athlete or not. */
async function studio(userId: string, o: { id: string; name: string; start?: string; weeks: number; createdAt: string; pushes: string[]; retired?: boolean }) {
  const brief = { goal: "general", durationWeeks: o.weeks, ...(o.start ? { startDate: o.start } : {}) };
  await db.insert(schema.studioPlans).values({ id: o.id, userId, brief, plan: { name: o.name, brief, weeks: [] }, version: 1, createdAt: o.createdAt, updatedAt: o.createdAt });
  for (const [n, status] of o.pushes.entries()) {
    await db.insert(schema.studioPlanPushes).values({ id: newId(), planId: o.id, planVersion: 1, happenDay: addDays(o.start ?? o.createdAt.slice(0, 10), 7 * n), sessionTitle: `W${n + 1} — Lift`, status, updatedAt: o.createdAt });
  }
  if (o.retired) await db.insert(schema.auditEvents).values({ id: newId(), userId, kind: STUDIO_PLAN_RETIRED, detail: { studioPlanId: o.id }, createdAt: o.createdAt });
}

async function read(userId = rich.userId, input: unknown = {}) {
  statements.length = 0;
  const res = await readPlans.run({ db, env: ENV, userId, run: { id: "run-rp", role: "main", scope: { kind: "auto" }, parentId: null, rehearsal: false }, now: NOW }, input);
  return { res, count: statements.length, writes: statements.filter(isWrite) };
}
const ok = (res: ToolOk | ToolErr): ToolOk & { data: { plans: Array<Record<string, any>> } } => {
  if (isToolErr(res)) throw new Error(`refused: ${res.error} — ${res.why}`);
  return res as ToolOk & { data: { plans: Array<Record<string, any>> } };
};

describe("read_plans", () => {
  it("is a read tool for every role, offered right after read_plan, one statement, small to describe", () => {
    const names = READ_TOOLS.map((t) => t.name);
    expect(names.indexOf("read_plans")).toBe(names.indexOf("read_plan") + 1);
    expect(readPlans.roles).toEqual(["main", "designer", "reviewer"]);
    expect(readPlans.statementCost).toBe(1);
    expect(readPlans.description.length).toBeLessThanOrEqual(240);
    expect(readPlans.inputSchema).toMatchObject({ type: "object", additionalProperties: false });
  });

  it("lists the coach's blocks — its weeks, the next three sessions, its race day — the programme and the watch plan; the coach may change only its own running block", async () => {
    await block(rich.userId, {
      id: "cp-10k", name: "10K build", start: day(2), end: day(-26), race: day(-26),
      weeks: [
        { weekStart: "2026-05-11", state: "firm" },
        { weekStart: "2026-05-18", state: "shape", volumeTarget: "about 32 km", keySessions: ["tempo 20 min", "long 14 km"] },
        { weekStart: "2026-05-25", state: "shape", volumeTarget: "about 35 km", keySessions: ["intervals 5×1 km"] },
      ],
    });
    await session(rich.userId, "cp-10k", day(1), { title: "Yesterday's run", state: "completed" });
    // Still only scheduled, but its day has gone (the read reaches a day back, for any zone): not "next".
    await session(rich.userId, "cp-10k", day(1), { title: "Yesterday, not logged" });
    await session(rich.userId, "cp-10k", day(-1), { title: "Gone", archived: true });
    await session(rich.userId, "cp-10k", day(-1), { title: "Tempo 20", category: "quality", minutes: 50 });
    await session(rich.userId, "cp-10k", day(-3), { title: "Easy 40" });
    await session(rich.userId, "cp-10k", day(-4), { title: "Strides" });
    await session(rich.userId, "cp-10k", day(-6), { title: "Long 12 km", category: "long", minutes: 75 });
    // A loose bucket is not a plan; one retired long ago is gone; one ended lately is shown, not changeable.
    await block(rich.userId, { id: `adhoc-run-${rich.userId.slice(0, 8)}`, name: "Coach one-offs", start: day(30), end: day(-2) });
    await block(rich.userId, { id: "cp-old", name: "Old block", status: "retired", start: day(120), end: day(60) });
    await block(rich.userId, { id: "cp-done", name: "Spring base", status: "completed", start: day(40), end: day(5) });
    await db.insert(schema.trainingPlans).values({
      id: "coros-plan", userId: rich.userId, sourcePlanId: "src-1", name: "Half marathon (watch)", startDate: day(30), endDate: "2026-06-20",
      status: "active", createdAt: at(day(30)), updatedAt: at(day(30)),
    });
    const { res, count, writes } = await read();
    expect(writes).toEqual([]);
    expect(count).toBe(1);
    const plans = ok(res).data.plans;
    const byId = new Map(plans.map((p) => [p.id, p]));
    expect(plans).toHaveLength(4);
    for (const id of ["cp-10k", "cp-done", "coros-plan"]) expect(byId.has(id), id).toBe(true);
    expect(byId.has(`adhoc-run-${rich.userId.slice(0, 8)}`)).toBe(false);
    expect(byId.has("cp-old")).toBe(false);

    const tenK = byId.get("cp-10k")!;
    expect(tenK).toMatchObject({ kind: "coach block", discipline: "run", status: "active", start: day(2), end: day(-26), raceDate: day(-26), coachMayChange: true });
    expect(tenK.name).toEqual({ untrusted: true, text: "10K build" });
    expect(tenK.firmWeeks).toEqual(["2026-05-11"]);
    expect(tenK.shapeWeeks).toEqual([
      { weekStart: "2026-05-18", volumeTarget: { untrusted: true, text: "about 32 km" }, keySessions: [{ untrusted: true, text: "tempo 20 min" }, { untrusted: true, text: "long 14 km" }] },
      { weekStart: "2026-05-25", volumeTarget: { untrusted: true, text: "about 35 km" }, keySessions: [{ untrusted: true, text: "intervals 5×1 km" }] },
    ]);
    expect(tenK.next.map((n: Record<string, any>) => [n.date, n.title.text, n.minutes])).toEqual([
      [day(-1), "Tempo 20", 50],
      [day(-3), "Easy 40", 40],
      [day(-4), "Strides", 40],
    ]);
    expect(tenK.next[0]).toMatchObject({ day: "Thu 14 May · tomorrow", what: "run, quality" });
    expect(typeof tenK.next[0].id).toBe("string");

    const done = byId.get("cp-done")!;
    expect(done).toMatchObject({ kind: "coach block", status: "completed", coachMayChange: false });
    expect(done.why).toMatch(/ended/);

    const watch = byId.get("coros-plan")!;
    expect(watch).toMatchObject({ kind: "watch plan", status: "active", coachMayChange: false, start: day(30), end: "2026-06-20" });
    expect(watch.name).toEqual({ untrusted: true, text: "Half marathon (watch)" });
    expect(watch.why).toMatch(/adjust_plan/);
    expect(watch.next).toHaveLength(3);
    for (const n of watch.next) expect(n.date >= TODAY).toBe(true);

    const programme = plans.find((p) => p.kind === "programme")!;
    expect(programme).toMatchObject({ status: "active", coachMayChange: false, weeklyGoal: 3 });
    expect(programme.name).toEqual({ untrusted: true, text: "Strength block" });
    expect(programme.next.length).toBeGreaterThan(0);
    expect(programme.why).toMatch(/settings/i);
    // The coach's own block comes first: it is the one it may work on.
    expect(plans[0]!.id).toBe("cp-10k");
  });

  it("never shows another athlete's plans", async () => {
    await block(other.userId, { id: "cp-other", name: `${OTHER_SENTINEL} block`, start: day(2), end: day(-20) });
    await session(other.userId, "cp-other", day(-1), { title: `${OTHER_SENTINEL} run` });
    const { res } = await read();
    expect(JSON.stringify(ok(res).data)).not.toContain(OTHER_SENTINEL);
  });

  it("an athlete with no plans: an empty list, said in missing; still one statement", async () => {
    const empty = (await makeTestUser(db, { timezone: "America/Los_Angeles" })).userId;
    const { res, count } = await read(empty);
    const r = ok(res);
    expect(r.data.plans).toEqual([]);
    expect(r.missing).toContain("no plans yet");
    expect(count).toBe(1);
    expect(r.summary).toBe("No plans yet");
    // No lines: nothing to continue.
    expect(r.data).not.toHaveProperty("continueLine");
    expect(JSON.stringify(r)).not.toContain(CONTINUE_LINE);
  });

  it("a live line says once how to continue it — the chip's flow, its last phase still running (training lines §3.7)", async () => {
    // One phase, ending in 12 days: "Plan what comes after my running plan" is offered, and nothing has ended.
    await block(rich.userId, { id: "cp-live", name: "10K build", start: day(30), end: day(-12) });
    const { res, count } = await read();
    expect(count).toBe(1);
    const r = ok(res) as ToolOk & { data: Record<string, any> };
    expect(r.data.lines).toHaveLength(1);
    expect(r.data.plans.find((p: Record<string, any>) => p.id === "cp-live")).toMatchObject({ coachMayChange: true });
    expect(r.data.continueLine).toBe(CONTINUE_LINE);
    expect(JSON.stringify(r).split(CONTINUE_LINE)).toHaveLength(2);
    // Only programmes and watch plans: no lines, nothing to continue.
    const { userId } = await makeTestUser(db, { timezone: "America/Los_Angeles" });
    await db.insert(schema.trainingPlans).values({
      id: "tp-only", userId, sourcePlanId: "src-only", name: "Watch plan", startDate: day(10), endDate: day(-20), status: "active", createdAt: at(day(10)), updatedAt: at(day(10)),
    });
    const watchOnly = ok((await read(userId)).res) as ToolOk & { data: Record<string, any> };
    expect(watchOnly.data.plans).toHaveLength(1);
    expect(watchOnly.data.lines).toEqual([]);
    expect(watchOnly.data).not.toHaveProperty("continueLine");
  });

  it("refuses a field it doesn't take, naming it", async () => {
    const { res } = await read(rich.userId, { zzz: 1 });
    expect(isToolErr(res)).toBe(true);
    expect((res as ToolErr).why).toContain('"zzz"');
  });

  it("past what shortening can fit: the last plans are counted (morePlans), never a list cut mid-way", async () => {
    const long = (s: string) => `${s} ${"with a very long name the watch gave it ".repeat(4)}`.trim();
    for (let n = 0; n < 10; n++) {
      await block(rich.userId, { id: `cp-many-${n}`, name: long(`Block ${n}`), start: day(2), end: "2026-12-31" });
      await db.insert(schema.trainingPlans).values({
        id: `tp-many-${n}`, userId: rich.userId, sourcePlanId: `src-${n}`, name: long(`Watch plan ${n}`), startDate: day(30), endDate: "2026-12-31",
        status: "active", createdAt: at(day(30)), updatedAt: at(day(30)),
      });
      for (let d = 1; d <= 3; d++) {
        await session(rich.userId, `cp-many-${n}`, day(-d), { title: long(`Session ${d}`) });
        await session(rich.userId, `tp-many-${n}`, day(-d), { title: long(`Watch session ${d}`) });
      }
    }
    const { res, count } = await read();
    const r = ok(res) as ToolOk & { data: { plans: Array<Record<string, any>>; morePlans?: number } };
    expect(count).toBe(1);
    expect(Buffer.byteLength(JSON.stringify({ provenance: r.provenance, missing: r.missing, data: r.data }))).toBeLessThanOrEqual(RESULT_BUDGET_BYTES);
    expect(r.data.morePlans).toBeGreaterThan(0);
    // 10 blocks, 10 watch plans, the fixture's programme: every one shown or counted.
    expect(r.data.plans.length + r.data.morePlans!).toBe(21);
    // The coach's own running blocks come first: the ones left out are the others.
    expect(r.data.plans[0]!.kind).toBe("coach block");
  });

  it("lists the coach's blocks as training lines with their phases, and the Studio plan read-only — still one statement; an ended phase says how to continue its line", async () => {
    // Three running blocks in a row: the bridge ended yesterday (the hourly sweep hasn't flipped it), the base runs, the
    // build follows with the race. A retired block and a bucket of one-offs are no phase; a lifting block is a line of its own.
    await block(rich.userId, { id: "cp-bridge", name: "Bridge block", start: day(27), end: day(1) });
    await block(rich.userId, { id: "cp-base", name: "Base block", start: TODAY, end: day(-25) });
    await block(rich.userId, { id: "cp-build", name: "Race build", start: day(-26), end: day(-53), race: day(-53) });
    await block(rich.userId, { id: "cp-dropped", name: "Dropped block", status: "retired", start: day(5), end: day(-10) });
    await block(rich.userId, { id: `adhoc-run-${rich.userId.slice(0, 8)}`, name: "Coach one-offs", start: day(30), end: day(-2) });
    await block(rich.userId, { id: "cp-lift", name: "Strength base", discipline: "lift", start: day(10), end: day(-20) });
    // Two Studio plans: only the newest is the athlete's (as the plan list shows it), written to the watch.
    await studio(rich.userId, { id: "studio-old", name: "Old Lift Block", start: "2026-02-02", weeks: 8, createdAt: at(day(110)), pushes: ["verified"] });
    await studio(rich.userId, { id: "studio-new", name: "Full Body Strength", start: "2026-05-04", weeks: 8, createdAt: at(day(12)), pushes: ["verified", "pending"] });
    const { res, count, writes } = await read();
    expect(writes).toEqual([]);
    expect(count).toBe(1);
    const data = ok(res).data as { plans: Array<Record<string, any>>; lines: Array<Record<string, any>> };
    const phase = (id: string, name: string, start: string, end: string, ended: boolean) => ({ id, name: { untrusted: true, text: name }, start, end, ended });
    expect(data.lines).toEqual([
      {
        name: "Running",
        discipline: "run",
        phases: [phase("cp-bridge", "Bridge block", day(27), day(1), true), phase("cp-base", "Base block", TODAY, day(-25), false), phase("cp-build", "Race build", day(-26), day(-53), false)],
        end: day(-53),
        goalRace: day(-53),
      },
      { name: "Lifting", discipline: "lift", phases: [phase("cp-lift", "Strength base", day(10), day(-20), false)], end: day(-20), goalRace: null },
    ]);
    // The blocks list keeps its ids.
    const byId = new Map(data.plans.map((p) => [p.id, p]));
    for (const id of ["cp-bridge", "cp-base", "cp-build", "cp-lift"]) expect(byId.get(id), id).toMatchObject({ kind: "coach block" });
    expect(byId.get("cp-base")!.coachMayChange).toBe(true);
    const bridge = byId.get("cp-bridge")!;
    expect(bridge.coachMayChange).toBe(false);
    expect(bridge.why).toContain(CONTINUE_LINE);
    expect(JSON.stringify(ok(res))).not.toContain("as a new plan");

    // The Studio plan: the newest, read-only, with the dates the plan list gives it.
    expect(byId.has("studio-old")).toBe(false);
    const lift = byId.get("studio-new")!;
    expect(lift).toMatchObject({ kind: "Studio plan", discipline: "lift", status: "active", start: "2026-05-04", end: "2026-06-28", coachMayChange: false });
    expect(lift.name).toEqual({ untrusted: true, text: "Full Body Strength" });
    expect(lift.why).toMatch(/Studio/);
    expect(lift.why).toMatch(/adjust_plan/);
  });

  describe("the Studio plan is the plan list's own (GET /api/coach/plans): the same entry, or none", () => {
    afterEach(() => vi.useRealTimers());
    const cases: Array<{ name: string; plans: Array<Parameters<typeof studio>[1]>; listed: string | null; status?: string }> = [
      { name: "written to the watch and running: active", plans: [{ id: "sp-a", name: "Lift A", start: "2026-05-04", weeks: 6, createdAt: at(day(12)), pushes: ["verified"] }], listed: "sp-a", status: "active" },
      { name: "a push still on its way: draft", plans: [{ id: "sp-b", name: "Lift B", start: "2026-05-18", weeks: 4, createdAt: at(day(3)), pushes: ["pending", "failed"] }], listed: "sp-b", status: "draft" },
      { name: "past its last day: completed", plans: [{ id: "sp-c", name: "Lift C", start: "2026-03-02", weeks: 4, createdAt: at(day(80)), pushes: ["verified"] }], listed: "sp-c", status: "completed" },
      { name: "no start in its brief: its creation day's week", plans: [{ id: "sp-d", name: "Lift D", weeks: 3, createdAt: "2026-05-06T10:00:00.000Z", pushes: ["verified"] }], listed: "sp-d", status: "active" },
      { name: "every push deleted: none", plans: [{ id: "sp-e", name: "Lift E", start: "2026-05-04", weeks: 6, createdAt: at(day(12)), pushes: ["deleted", "deleted"] }], listed: null },
      { name: "never pushed: none", plans: [{ id: "sp-f", name: "Lift F", start: "2026-05-04", weeks: 6, createdAt: at(day(12)), pushes: [] }], listed: null },
      { name: "retired by the athlete: none", plans: [{ id: "sp-g", name: "Lift G", start: "2026-05-04", weeks: 6, createdAt: at(day(12)), pushes: ["verified"], retired: true }], listed: null },
      {
        name: "the newest never pushed, an older one on the watch: none (the newest is the athlete's)",
        plans: [
          { id: "sp-h-old", name: "Lift H old", start: "2026-04-06", weeks: 8, createdAt: at(day(40)), pushes: ["verified"] },
          { id: "sp-h-new", name: "Lift H new", start: "2026-05-18", weeks: 8, createdAt: at(day(2)), pushes: [] },
        ],
        listed: null,
      },
      {
        name: "two made at the same moment: the same one in both lists (the later id)",
        plans: [
          { id: "sp-i-a", name: "Lift I a", start: "2026-05-04", weeks: 6, createdAt: at(day(12)), pushes: ["verified"] },
          { id: "sp-i-b", name: "Lift I b", start: "2026-05-11", weeks: 6, createdAt: at(day(12)), pushes: ["verified"] },
        ],
        listed: "sp-i-b",
        status: "active",
      },
    ];
    for (const c of cases) {
      it(c.name, async () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(NOW);
        const { userId, prefs } = await makeTestUser(db, { timezone: "America/Los_Angeles" });
        for (const p of c.plans) await studio(userId, p);
        const { res, count } = await read(userId);
        expect(count).toBe(1);
        const shown = ok(res).data.plans.filter((p) => p.kind === "Studio plan");
        const { studioEntries } = await loadNonCoachPlanEntries(db, userId, prefs);
        expect(studioEntries.map((e) => e.id)).toEqual(c.listed ? [c.listed] : []);
        expect(shown.map((p) => ({ id: p.id, name: p.name.text, status: p.status, start: p.start, end: p.end }))).toEqual(
          studioEntries.map((e) => ({ id: e.id, name: e.name, status: e.status, start: e.startDate, end: e.endDate })),
        );
        if (c.status) expect(shown[0]!.status).toBe(c.status);
        for (const p of shown) expect(p.coachMayChange).toBe(false);
      });
    }
  });

  it("the answer fits the budget whatever its names' lengths — the lines and how to continue them counted with the plans", async () => {
    // Ten blocks of one line, sessions with long imported titles: the answer sits at the budget's edge, plans left out
    // and counted. The first block's next session grows 40 characters a read, so some read lands within the
    // continuation's hundred-odd bytes of the budget, either side.
    const long = (s: string) => `${s} ${"with a very long title the watch gave it ".repeat(5)}`.trim();
    for (let n = 0; n < 10; n++) {
      await block(rich.userId, { id: `cp-edge-${n}`, name: `Block ${n} — a long name for the size test`, start: day(2), end: "2026-12-31" });
      for (let d = 1; d <= 3; d++) await session(rich.userId, `cp-edge-${n}`, day(-d), { title: long(`Session ${d}`) });
    }
    const [first] = await db.select({ id: schema.plannedWorkouts.id }).from(schema.plannedWorkouts)
      .where(and(eq(schema.plannedWorkouts.planId, "cp-edge-0"), eq(schema.plannedWorkouts.effectiveDate, day(-1))));
    let dropped = 0;
    for (let k = 0; k < 30; k++) {
      await db.update(schema.plannedWorkouts).set({ title: `${long("Session 1")}${"x".repeat(40 * k)}` }).where(eq(schema.plannedWorkouts.id, first!.id));
      const r = ok((await read()).res) as ToolOk & { data: Record<string, any> };
      expect(r.data.continueLine).toBe(CONTINUE_LINE);
      expect(Buffer.byteLength(JSON.stringify({ provenance: r.provenance, missing: r.missing, data: r.data })), `k=${k}`).toBeLessThanOrEqual(RESULT_BUDGET_BYTES);
      dropped = Math.max(dropped, r.data.morePlans ?? 0);
    }
    expect(dropped).toBeGreaterThan(0);
  });

  it("many blocks with many weeks still fit the result budget: every block named, its shape weeks shortened and counted", async () => {
    const mondays = Array.from({ length: 30 }, (_, k) => new Date(Date.UTC(2026, 4, 18 + 7 * k)).toISOString().slice(0, 10));
    for (let n = 0; n < 8; n++) {
      await block(rich.userId, {
        id: `cp-big-${n}`, name: `Block ${n} with a long name for the size test`, start: day(2), end: "2026-12-31",
        weeks: mondays.map((weekStart) => ({ weekStart, state: "shape" as const, volumeTarget: "about 40 km of easy running", keySessions: ["a long run of two hours", "a tempo of forty minutes", "strides"] })),
      });
      for (let d = 1; d <= 4; d++) await session(rich.userId, `cp-big-${n}`, day(-d), { title: `Session ${d} of block ${n}` });
    }
    const { res, count } = await read();
    const r = ok(res);
    expect(count).toBe(1);
    expect(Buffer.byteLength(JSON.stringify({ provenance: r.provenance, missing: r.missing, data: r.data }))).toBeLessThanOrEqual(RESULT_BUDGET_BYTES);
    // Every plan is named or counted; each one shown keeps its first shape week, the rest counted.
    const shown = r.data.plans.filter((p) => String(p.id).startsWith("cp-big-"));
    expect(shown.length + ((r.data as { morePlans?: number }).morePlans ?? 0)).toBe(8);
    expect(shown.length).toBeGreaterThanOrEqual(6);
    for (const big of shown) {
      expect(big.shapeWeeks.length + big.moreShapeWeeks).toBe(30);
      if (big.shapeWeeks.length > 0) expect(big.shapeWeeks[0].weekStart).toBe("2026-05-18");
      expect(big.next.length).toBeGreaterThanOrEqual(1);
    }
  });
});
