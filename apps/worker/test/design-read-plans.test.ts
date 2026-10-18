/**
 * read_plans (§8 §5, stream W): the conversation coach reads the athlete's plans — its own coach blocks, the athlete's
 * adaptive programmes and the watch's plans — each with its id, kind, name, dates, race day, firm and shape weeks, the
 * next three sessions, and whether the coach may change its structure (only a block it wrote, still running). One
 * statement. Synthetic data only, on the rich fixture's fixed clock (today Wed 13 May 2026).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { schema } from "@rg/database";
import { newId } from "@rg/domain";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { READ_TOOLS } from "../src/services/design-tools/index.js";
import { readPlans } from "../src/services/design-tools/read-plans.js";
import { RESULT_BUDGET_BYTES } from "../src/services/design-tools/read-common.js";
import { isToolErr, type ToolErr, type ToolOk } from "../src/services/design-tools/types.js";
import { at, day, NOW, OTHER_SENTINEL, seedOtherAthlete, seedRichAthlete, TODAY } from "./design-read-fixture.js";
import { isWrite, makeTestDb, makeTestUser } from "./helpers.js";

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
  });

  it("refuses a field it doesn't take, naming it", async () => {
    const { res } = await read(rich.userId, { zzz: 1 });
    expect(isToolErr(res)).toBe(true);
    expect((res as ToolErr).why).toContain('"zzz"');
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
