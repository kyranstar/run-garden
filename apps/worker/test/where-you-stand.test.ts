/**
 * WHERE THE ATHLETE STANDS (spec 2026-11-05 §7.1–§7.2; principles §6.3 as amended, §12): the facts read in one statement
 * and the measures their key results need; the block every main run opens with, against captured text; and the drift
 * rules. A made-up athlete (Zorbex objectives); every date relative to a fixed day.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, keyResultMeasureSchema, newId, type KeyResultProgress } from "@rg/domain";
import type { Db } from "../src/services/db.js";
import {
  disciplineOf,
  driftCoveredBy,
  driftNudge,
  driftsOf,
  paceOf,
  readStandFacts,
  standBlock,
  standMeasured,
  standRowsSql,
  standStatements,
  STAND_KEY_RESULTS_MAX,
  type StandFacts,
  type StandKeyResult,
  type StandPlanRow,
} from "../src/services/where-you-stand.js";
import { isWrite, makeTestDb, makeTestUser } from "./helpers.js";
import { seedRichAthlete, TODAY as RICH_TODAY } from "./design-read-fixture.js";

const TODAY = "2026-11-05"; // a Thursday
const d = (n: number) => addDays(TODAY, n);

const progress = (current: number | null, evidence: KeyResultProgress["evidence"], series: number[] = current === null ? [] : [current]): KeyResultProgress => ({
  unit: "s",
  current,
  series: series.map((v, i) => ({ date: d(-i - 1), value: v, display: v })),
  lastMeasuredAt: series.length ? d(-1) : null,
  sampleSize: series.length,
  evidence,
  display: { unit: "s", current },
});

const kr = (over: Partial<StandKeyResult>): StandKeyResult => ({
  id: "kr",
  objectiveId: "obj",
  label: "Zorbex hold",
  measure: null,
  direction: "up",
  baseline: null,
  target: null,
  unit: "s",
  due: null,
  createdOn: d(-30),
  progress: null,
  ...over,
});

let rowN = 0;
const row = (date: string, category: string, state: string, over: Partial<StandPlanRow> = {}): StandPlanRow => ({
  id: `w${(rowN += 1)}`,
  date,
  time: "07:00",
  category,
  origin: category === "strength" || category === "yoga" ? "studio" : null,
  state,
  sanctionedBy: null,
  subtype: null,
  sport: category === "strength" ? "strength" : category === "yoga" ? "yoga" : "run",
  seconds: 1800,
  ...over,
});

/** The synthetic athlete the captured block is read for. */
function athlete(): StandFacts {
  rowN = 0;
  const health = Array.from({ length: 14 }, (_, i) => {
    const date = d(-i);
    const hrv7 = [63, 62, 60, 61, null, 58, 55]; // today first
    const rhr7 = [49, 50, 50, 51, null, 51, 52];
    return { date, hrv: i < 7 ? hrv7[i]! : 58, restingHeartRate: i < 7 ? rhr7[i]! : 51, recoveryScore: null, sleepHrvBase: null, sleepHrvSd: null };
  });
  return {
    today: TODAY,
    objectives: [
      {
        id: "obj-ski",
        keyResults: [
          kr({ id: "kr-hold", objectiveId: "obj-ski", label: "Wall sit hold", baseline: 60, target: 120, due: d(20), createdOn: d(-30), progress: progress(75, "measured", [70, 72, 75]) }),
          kr({ id: "kr-5k", objectiveId: "obj-ski", label: "5K time", direction: "down", baseline: 1500, target: 1380, due: "2027-02-01", createdOn: "2026-09-01", progress: progress(1450, "sparse") }),
        ],
      },
      { id: "obj-calm", keyResults: [kr({ id: "kr-energy", objectiveId: "obj-calm", label: "Energy", unit: "score", target: 8, createdOn: d(-35), progress: { ...progress(6.5, "measured", [6, 6.5, 6.5]), unit: "score" } })] },
    ],
    plan: [
      // Strength: 14 d — 1 done, 1 missed, 1 skipped, 1 not known; one more done in the 21 days; one in the 4 weeks.
      row(d(-1), "strength", "completed"),
      row(d(-3), "strength", "unresolved"),
      row(d(-6), "strength", "skipped"),
      row(d(-9), "strength", "missed"),
      row(d(-16), "strength", "completed"),
      row(d(-23), "strength", "completed"),
      // Not planned work: the coach's own skip, a rest day.
      row(d(-8), "strength", "skipped", { sanctionedBy: "coach" }),
      row(d(-10), "rest", "scheduled"),
      // Runs: all done in 14 d; one the athlete missed in the 4 weeks.
      row(d(-2), "easy", "completed"),
      row(d(-5), "long", "completed", { seconds: 5400 }),
      row(d(-7), "easy", "completed"),
      row(d(-12), "quality", "completed", { subtype: "tempo" }),
      row(d(-19), "easy", "completed"),
      row(d(-26), "easy", "missed"),
      // Mobility and care.
      row(d(-4), "yoga", "completed"),
      row(d(-11), "yoga", "completed"),
      // The next 14 days.
      row(d(0), "easy", "scheduled", { time: "18:00", seconds: 2400 }),
      row(d(0), "strength", "scheduled"),
      row(d(1), "rest", "scheduled", { seconds: 0 }),
      row(d(2), "long", "scheduled", { seconds: 5400 }),
      row(d(5), "quality", "scheduled", { subtype: "tempo", seconds: 3000 }),
      row(d(7), "strength", "scheduled"),
      row(d(9), "yoga", "scheduled", { origin: null, seconds: 3600 }),
    ],
    unplanned: [{ date: d(-4), discipline: "runs" }],
    health,
    sleep: Array.from({ length: 7 }, (_, i) => ({ date: d(-i), seconds: i === 6 ? 6.5 * 3600 : i === 4 ? 7.5 * 3600 : 7 * 3600 })),
    review: { weekStart: "2026-10-26", narrative: "Solid week: three runs and two lifts. Next week, add a mobility session." },
    reads: [{ date: d(-2), sport: "run", seconds: 2520, flags: ["hr_drift"], glance: "Heart rate crept up in the last third." }],
    beyondCore: { note: 3, observation: 2 },
    conclusions: [],
    plans: [],
  };
}

const EMPTY: StandFacts = { today: TODAY, objectives: [], plan: [], unplanned: [], health: [], sleep: [], review: null, reads: [], beyondCore: {}, conclusions: [], plans: [] };

const U = (from: string, text: string) => `<untrusted from="${from}">${text}</untrusted>`;

const CAPTURED = [
  "# Where you stand (the app's own figures)",
  "Objectives — current → target by due: pace:",
  `- obj-ski: ${U("athlete", "Wall sit hold")} 75 s → 120 s by 2026-11-25: behind (25% there, 60% of time gone)`,
  `- obj-ski: ${U("athlete", "5K time")} 24:10 (few readings) → 23:00 by 2027-02-01: on track (42% there, 42% of time gone)`,
  `- obj-calm: ${U("athlete", "Energy")} 6.5 → 8: no data (no due date)`,
  "Planned → done, last 14 d | 4 wk (missed · skipped · not known):",
  "- runs 4/4 | 5/6 (0·0·0 | 1·0·0), +1 off the plan in 4 wk",
  "- strength 1/4 | 3/6 (1·1·1 | 1·1·1)",
  "- mobility and care 2/2 | 2/2",
  "Next 14 days (a day not listed: nothing planned):",
  "Thu 5 Nov: strength 30 min; easy run 40 min",
  "Fri 6 Nov: rest",
  "Sat 7 Nov: long run 90 min",
  "Tue 10 Nov: tempo 50 min",
  "Thu 12 Nov: strength 30 min",
  "Sat 14 Nov: yoga 60 min",
  "Readiness: good. Last 7 d, oldest first — HRV 55 58 – 61 60 62 63 (usual 58, rising) · resting HR 52 51 – 51 50 50 49 (usual 51, falling) · sleep 7.0 h a night (6.5–7.5)",
  `Last weekly review (week of Mon 26 Oct): ${U("coach read", "Solid week: three runs and two lifts.")}`,
  "Activity reads flagged in 7 d:",
  `- Tue 3 Nov run 42 min — hr_drift: ${U("coach read", "Heart rate crept up in the last third.")}`,
  "Memory beyond the core: 3 notes, 2 observations (recall_memory).",
  "Needs you (the first not held is the chip on Today and in the coach):",
  "- 2 of 5 planned lifts logged in 3 weeks (drift:discipline:strength)",
  `- ${U("athlete", "Wall sit hold")} is behind schedule with 3 weeks left (drift:key_result:kr-hold)`,
].join("\n");

const CAPTURED_EMPTY = [
  "# Where you stand (the app's own figures)",
  "Objectives: none active.",
  "Planned → done: nothing planned in the last 4 weeks.",
  "Next 14 days: nothing planned.",
  "Readiness: no verdict (too little data). Last 7 d: no HRV, resting HR or sleep recorded.",
  "Last weekly review: none yet.",
  "Activity reads flagged in 7 d: none.",
  "Memory beyond the core: none.",
  "Needs you: nothing the app sees.",
].join("\n");

describe("the rules, pure", () => {
  it("a planned row's discipline: runs, strength, the app's yoga kind as mobility and care, an import's as yoga; rest and cross-training none", () => {
    for (const c of ["recovery", "easy", "long", "quality", "race", "unknown"]) expect(disciplineOf({ category: c, origin: null })).toBe("runs");
    expect(disciplineOf({ category: "strength", origin: "program" })).toBe("strength");
    expect(disciplineOf({ category: "yoga", origin: "studio" })).toBe("mobility and care");
    expect(disciplineOf({ category: "yoga", origin: "program" })).toBe("mobility and care");
    expect(disciplineOf({ category: "yoga", origin: null })).toBe("yoga");
    expect(disciplineOf({ category: "rest", origin: null })).toBeNull();
    expect(disciplineOf({ category: "cross_training", origin: null })).toBeNull();
  });

  it("pace: behind, on track, ahead, reached, and no data with its reason — never a division by zero", () => {
    const up = { direction: "up" as const, start: 60, target: 120, startDate: d(-40), due: d(30) };
    expect(paceOf(up, 75, TODAY)).toEqual({ pace: "behind", done: 0.25, elapsed: 40 / 70 });
    expect(paceOf(up, 95, TODAY).pace).toBe("on track");
    expect(paceOf(up, 110, TODAY).pace).toBe("ahead");
    expect(paceOf(up, 120, TODAY).pace).toBe("reached");
    expect(paceOf({ ...up, direction: "down", start: 1500, target: 1380 }, 1440, TODAY).pace).toBe("on track");
    expect(paceOf({ ...up, due: d(-1) }, 100, TODAY).pace).toBe("behind");
    expect(paceOf(up, null, TODAY)).toEqual({ pace: "no data", why: "nothing measured" });
    expect(paceOf({ ...up, target: null }, 80, TODAY)).toEqual({ pace: "no data", why: "no target" });
    expect(paceOf({ ...up, due: null }, 80, TODAY)).toEqual({ pace: "no data", why: "no due date" });
    expect(paceOf({ ...up, start: null }, 80, TODAY)).toEqual({ pace: "no data", why: "no starting value" });
    expect(paceOf({ ...up, target: 60 }, 80, TODAY)).toEqual({ pace: "reached", done: 1, elapsed: 40 / 70 });
    expect(paceOf({ ...up, target: 60, start: 60 }, 50, TODAY)).toEqual({ pace: "no data", why: "the target is the start" });
  });
});

describe("the block, against captured text", () => {
  it("reads for the synthetic athlete exactly as captured, within about 1,500 characters", () => {
    const f = athlete();
    const block = standBlock(f, driftsOf(f));
    expect(block).toBe(CAPTURED);
    // About 1,500 (spec §7.1): measured 1,580 — five marked texts are 190 of it. REBASED 2026-11-06 (the audits' fix
    // pass: "behind schedule", the Needs-you header says which is the chip) — measured 1,603.
    expect(block.length).toBeLessThanOrEqual(1650);
  });

  it("an empty account: every part in a few words, no drift", () => {
    expect(driftsOf(EMPTY)).toEqual([]);
    expect(standBlock(EMPTY, [])).toBe(CAPTURED_EMPTY);
  });

  it("a rich account stays bounded: three key-result lines and a pointer, two reads and a pointer, three moves a day, a long review cut at a word", () => {
    const f = athlete();
    f.objectives = Array.from({ length: 12 }, (_, o) => ({
      id: `obj-${o}`,
      keyResults: Array.from({ length: 10 }, (_, k) => kr({ id: `kr-${o}-${k}`, objectiveId: `obj-${o}`, label: `Zorbex key result number ${k} of a long label`, target: 100 })),
    }));
    f.reads = Array.from({ length: 3 }, (_, i) => ({ date: d(-i), sport: "run", seconds: 1800, flags: ["strain_high", "hr_drift"], glance: "A very long glance ".repeat(20) }));
    f.review = { weekStart: "2026-10-26", narrative: `${"A long first sentence that goes on ".repeat(10)}. Then more.` };
    f.plan.push(...Array.from({ length: 5 }, () => row(d(3), "strength", "scheduled")));
    const block = standBlock(f, driftsOf(f));
    expect(block).toContain("- and 117 more key results (read_objectives)");
    expect(block).toContain("and 1 more (read_history)");
    expect(block).toContain("Sun 8 Nov: strength 30 min; strength 30 min; strength 30 min; +2");
    expect(block.match(/Zorbex key result/g)).toHaveLength(3);
    expect(block).toMatch(/A long first sentence[^\n]{0,120}…<\/untrusted>/);
    expect(block.length).toBeLessThanOrEqual(2000);
  });
});

describe("the block's plan lines (plans with a purpose, §4.3)", () => {
  it("one line per active plan: its name and purpose marked as the athlete's, or that it has none; none at all with no plan", () => {
    const f = athlete();
    f.plans = [
      { id: "p1", name: "Zorbex steady", purpose: "Keep the Zorbex habit going" },
      { id: "p2", name: "Zorbex bare", purpose: null },
    ];
    const block = standBlock(f, driftsOf(f));
    expect(block).toContain(
      ["Plans (read_plans has each one's brief and ending):", `- ${U("athlete", "Zorbex steady")}: ${U("athlete", "Keep the Zorbex habit going")}`, `- ${U("athlete", "Zorbex bare")}: no purpose set yet`].join("\n"),
    );
    expect(standBlock(athlete(), [])).not.toContain("Plans (");
  });

  it("stays bounded: six plans, a long name and purpose cut at a word, a pointer for the rest", () => {
    const f = athlete();
    f.plans = Array.from({ length: 8 }, (_, i) => ({ id: `p${i}`, name: `Zorbex ${"name ".repeat(20)}${i}`, purpose: `A long purpose ${"that goes on ".repeat(20)}${i}` }));
    const lines = standBlock(f, []).split("\n").filter((l) => l.startsWith("- <untrusted from=\"athlete\">Zorbex name"));
    expect(lines).toHaveLength(6);
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(220);
    expect(standBlock(f, [])).toContain("- and 2 more (read_plans)");
  });
});

describe("the block's drift lines are capped too (final review #2)", () => {
  it("twenty key results behind pace: three lines and a count, the block within 2,000 characters", () => {
    const f = athlete();
    f.objectives = [
      {
        id: "obj-many",
        keyResults: Array.from({ length: 20 }, (_, k) =>
          kr({ id: `kr-${k}`, objectiveId: "obj-many", label: `Zorbex key result number ${k} of a long label`, baseline: 60, target: 120, createdOn: d(-30), due: d(20), progress: progress(65, "measured") }),
        ),
      },
    ];
    const drifts = driftsOf(f);
    expect(drifts.filter((x) => x.rule === "key_result")).toHaveLength(20);
    const block = standBlock(f, drifts);
    expect(block.split("\n").filter((l) => l.includes("(drift:"))).toHaveLength(3);
    expect(block).toContain(`- and ${drifts.length - 3} more the app sees`);
    expect(block.length).toBeLessThanOrEqual(2000);
  });
});

describe("drift (§7.2)", () => {
  const strength = (planned: number, done: number, from = -2): StandPlanRow[] =>
    Array.from({ length: planned }, (_, i) => row(d(from - i), "strength", i < done ? "completed" : "skipped"));
  const only = (plan: StandPlanRow[], over: Partial<StandFacts> = {}): StandFacts => ({ ...EMPTY, plan, ...over });

  it("a discipline under half its planned sessions over 3 weeks (at least 3 planned) — at its edge", () => {
    expect(driftsOf(only(strength(4, 1))).map((x) => x.observation)).toEqual(["1 of 4 planned lifts logged in 3 weeks"]);
    expect(driftsOf(only(strength(4, 2)))).toEqual([]);
    expect(driftsOf(only(strength(3, 1)))[0]).toMatchObject({ id: "drift:discipline:strength", rule: "discipline" });
    // Older than 3 weeks: not counted.
    expect(driftsOf(only(strength(4, 0, -22)))).toEqual([]);
  });

  it("none of a planned discipline in 3 weeks: two planned, the first a week back — not when done off the plan; one, or two just now, are the missed chip's", () => {
    const yoga = (n: number) => row(d(n), "yoga", "skipped", { origin: null });
    expect(driftsOf(only([yoga(-3), yoga(-10)]))).toMatchObject([{ id: "drift:none:yoga", rule: "none", observation: "No yoga sessions logged in 3 weeks, with 2 planned" }]);
    expect(driftsOf(only([yoga(-3)]))).toEqual([]);
    expect(driftsOf(only([yoga(-1), yoga(-3)]))).toEqual([]);
    expect(driftsOf(only([row(d(-3), "strength", "unresolved"), row(d(-10), "strength", "missed")], { unplanned: [{ date: d(-4), discipline: "strength" }] }))).toEqual([]);
  });

  it("a session past but still only scheduled (within the sync's grace) is no part of a drift", () => {
    expect(driftsOf(only([...strength(2, 1), row(d(-1), "strength", "scheduled")]))).toEqual([]);
    expect(driftsOf(only([...strength(3, 1, -3), row(d(-1), "strength", "scheduled")])).map((x) => x.observation)).toEqual(["1 of 3 planned lifts logged in 3 weeks"]);
  });

  it("3 or more sessions missed or not logged in 2 weeks: said as not logged, never as missed", () => {
    const plan = [row(d(-1), "easy", "unresolved"), row(d(-4), "easy", "unresolved"), row(d(-13), "long", "missed"), row(d(-2), "easy", "completed"), row(d(-3), "easy", "completed"), row(d(-6), "easy", "completed")];
    const [x] = driftsOf(only(plan));
    expect(x).toMatchObject({ id: "drift:missed", rule: "missed", observation: "3 sessions not logged in 2 weeks" });
    expect(driftsOf(only(plan.slice(1)))).toEqual([]);
  });

  it("a key result behind pace by more than a quarter with under half its time left", () => {
    const k = (current: number, due: number) => ({
      ...EMPTY,
      objectives: [{ id: "o", keyResults: [kr({ id: "k1", label: "Zorbex plank", baseline: 60, target: 120, createdOn: d(-30), due: d(due), progress: progress(current, "measured") })] }],
    });
    // 60% of the time gone, a quarter there: 0.35 behind.
    expect(driftsOf(k(75, 20))).toMatchObject([{ id: "drift:key_result:k1", rule: "key_result", observation: "Zorbex plank is behind schedule with 3 weeks left" }]);
    expect(driftsOf(k(75, 10))[0]!.observation).toBe("Zorbex plank is behind schedule with 10 days left");
    // Behind, but half its time still ahead.
    expect(driftsOf(k(61, 31))).toEqual([]);
    // Under half its time left, behind by less than a quarter.
    expect(driftsOf(k(86, 20))).toEqual([]);
  });

  it("the most pressing first: the lowest share of a discipline, then not logged, then key results", () => {
    const plan = [...strength(4, 1), row(d(-2), "yoga", "skipped", { origin: null }), row(d(-9), "yoga", "skipped", { origin: null }), row(d(-1), "easy", "unresolved"), row(d(-4), "easy", "unresolved"), row(d(-6), "easy", "unresolved")];
    // Runs 0 of 3 and yoga 0 of 2 share the lowest share: the discipline's order breaks the tie.
    expect(driftsOf(only(plan)).map((x) => x.id)).toEqual(["drift:discipline:runs", "drift:none:yoga", "drift:discipline:strength", "drift:missed"]);
  });

  it("a conclusion with a check-back after today holds the drift; on the check-back day it comes back, with what was concluded", () => {
    const held = only(strength(4, 1), { conclusions: [{ id: "mem:r:1", drift: "drift:discipline:strength", checkBack: d(1), at: `${d(-6)}T09:00:00.000Z`, body: "Lifts on Saturdays while work is busy." }] });
    const [x] = driftsOf(held);
    expect(x!.held).toEqual({ until: d(1), memoryId: "mem:r:1", at: d(-6), body: "Lifts on Saturdays while work is busy." });
    expect(standBlock(held, [x!])).toContain(
      `- 1 of 4 planned lifts logged in 3 weeks (drift:discipline:strength) — talked through ${d(-6)}, held until ${d(1)} (mem:r:1): ${U("memory", "Lifts on Saturdays while work is busy.")}`,
    );
    const due = only(strength(4, 1), { conclusions: [{ id: "mem:r:1", drift: "drift:discipline:strength", checkBack: TODAY, at: `${d(-6)}T09:00:00.000Z`, body: "Lifts on Saturdays while work is busy." }] });
    const [y] = driftsOf(due);
    expect(y!.held).toBeNull();
    expect(y!.since).toEqual({ at: d(-6), memoryId: "mem:r:1", body: "Lifts on Saturdays while work is busy." });
    expect(standBlock(due, [y!])).toContain(`(drift:discipline:strength) — talked through ${d(-6)} (mem:r:1), check back now: ${U("memory", "Lifts on Saturdays while work is busy.")}`);
  });

  it("a chip: an observation and a question; its request the athlete's words", () => {
    const [x] = driftsOf(only(strength(4, 1)));
    expect(driftNudge(x!)).toEqual({
      id: "drift:discipline:strength",
      label: "1 of 4 planned lifts logged in 3 weeks — talk it through?",
      request: "1 of 4 planned lifts logged in 3 weeks — let's talk it through.",
    });
  });
});

describe("the audits' fix pass (2026-11-06)", () => {
  const strength = (dates: Array<[number, string]>) => dates.map(([n, state]) => row(d(n), "strength", state));
  const facts = (over: Partial<StandFacts>): StandFacts => ({ ...EMPTY, ...over });
  const conclusion = (drift: string, checkBack = d(10)) => ({ id: `mem:${drift}`, drift, checkBack, at: `${d(-2)}T09:00:00.000Z`, body: "Zorbex: talked it through." });

  it("#1 a start already past the target, the better way, has no pace — never 'ahead', never a chip", () => {
    const base = { startDate: d(-40), due: d(30) };
    expect(paceOf({ ...base, direction: "up", start: 8, target: 7 }, 5, TODAY)).toEqual({ pace: "no data", why: "started past the target" });
    expect(paceOf({ ...base, direction: "down", start: 1, target: 2 }, 5, TODAY)).toEqual({ pace: "no data", why: "started past the target" });
    expect(paceOf({ ...base, direction: "up", start: 7, target: 7 }, 5, TODAY)).toEqual({ pace: "no data", why: "the target is the start" });
    const f = facts({ objectives: [{ id: "o", keyResults: [kr({ id: "k", baseline: 8, target: 7, createdOn: d(-30), due: d(5), progress: progress(5, "measured") })] }] });
    expect(driftsOf(f)).toEqual([]);
  });

  it("#2 one reading and no baseline: no data, 'one reading so far' — no 'behind', no chip", () => {
    const f = facts({ objectives: [{ id: "o", keyResults: [kr({ id: "k", baseline: null, target: 120, createdOn: d(-30), due: d(14), progress: progress(65, "sparse") })] }] });
    expect(driftsOf(f)).toEqual([]);
    expect(standBlock(f, [])).toContain(": no data (one reading so far)");
  });

  it("#3a a held discipline holds the not-logged drift its sessions raise", () => {
    const plan = strength([[-2, "unresolved"], [-4, "unresolved"], [-6, "missed"], [-8, "completed"]]);
    expect(driftsOf(facts({ plan })).map((x) => x.id)).toEqual(["drift:discipline:strength", "drift:missed"]);
    const held = driftsOf(facts({ plan, conclusions: [conclusion("drift:discipline:strength")] }));
    expect(held.map((x) => [x.id, x.held?.memoryId])).toEqual([
      ["drift:discipline:strength", "mem:drift:discipline:strength"],
      ["drift:missed", "mem:drift:discipline:strength"],
    ]);
  });

  it("#3b a hold follows the discipline as its drift flips from discipline to none", () => {
    const yoga = [row(d(-3), "yoga", "skipped", { origin: null }), row(d(-10), "yoga", "skipped", { origin: null })];
    const [x] = driftsOf(facts({ plan: yoga, conclusions: [conclusion("drift:discipline:yoga")] }));
    expect(x).toMatchObject({ id: "drift:none:yoga", held: { memoryId: "mem:drift:discipline:yoga" } });
  });

  it("#3c a missed conclusion holds the disciplines it covers now; a missed drift is held only when every discipline in it is", () => {
    const plan = strength([[-2, "unresolved"], [-4, "unresolved"], [-6, "missed"], [-8, "completed"]]);
    expect(driftsOf(facts({ plan, conclusions: [conclusion("drift:missed")] })).every((x) => x.held !== null)).toBe(true);
    const mixed = [...strength([[-2, "unresolved"], [-4, "unresolved"]]), row(d(-3), "easy", "unresolved"), row(d(-5), "easy", "completed"), row(d(-7), "easy", "completed")];
    const out = driftsOf(facts({ plan: mixed, conclusions: [conclusion("drift:discipline:strength")] }));
    expect(out.find((x) => x.id === "drift:missed")!.held).toBeNull();
  });

  it("#3d driftCoveredBy: the same subject match for a run that diagnosed it", () => {
    const plan = strength([[-2, "unresolved"], [-4, "unresolved"], [-6, "missed"], [-8, "completed"]]);
    const f = facts({ plan });
    const missed = driftsOf(f).find((x) => x.id === "drift:missed")!;
    expect(driftCoveredBy(missed, ["drift:discipline:strength"], f)).toBe(true);
    expect(driftCoveredBy(missed, ["drift:none:yoga"], f)).toBe(false);
    expect(driftCoveredBy(driftsOf(f)[0]!, ["drift:missed"], f)).toBe(true);
  });

  it("#6 a Start-now session is off the plan: never planned, never a planned one done", () => {
    const plan = [
      ...strength([[-2, "skipped"], [-5, "skipped"], [-9, "skipped"], [-12, "skipped"]]),
      ...[-1, -4, -7, -11].map((n) => row(d(n), "strength", "completed", { startNow: true })),
    ];
    const f = facts({ plan });
    expect(standBlock(f, driftsOf(f))).toContain("- strength 0/4 | 0/4 (0·4·0 | 0·4·0), +4 off the plan in 4 wk");
    expect(driftsOf(f).map((x) => x.observation)).toEqual(["0 of 4 planned lifts logged in 3 weeks"]);
  });

  it("#7 the stand measures 12 key results at most: the ones shown and those that could drift first", () => {
    const many = Array.from({ length: 30 }, (_, k) => kr({ id: `k${k}`, label: `Zorbex ${k}`, baseline: 60, target: 120, due: k === 29 ? d(3) : null, measure: { kind: "checkin", questionId: "energy" } as never }));
    // The ones shown, then the one that can drift; the rest — not shown, no due date, so no drift — are never read (CPU).
    expect(standMeasured(many).map((x) => x.id)).toEqual(["k0", "k1", "k2", "k29"]);
    const due = Array.from({ length: 20 }, (_, k) => kr({ id: `d${k}`, target: 120, due: d(40 - k), measure: { kind: "checkin", questionId: "energy" } as never }));
    expect(standMeasured(due).map((x) => x.id)).toEqual(["d0", "d1", "d2", "d19", "d18", "d17", "d16", "d15", "d14", "d13", "d12", "d11"]);
    expect(STAND_KEY_RESULTS_MAX).toBe(12);
  });

  it("#11 a key result's chip says it is behind schedule, never 'behind pace'", () => {
    const f = facts({ objectives: [{ id: "o", keyResults: [kr({ id: "k1", label: "Zorbex plank", baseline: 60, target: 120, createdOn: d(-30), due: d(20), progress: progress(75, "measured") })] }] });
    const [x] = driftsOf(f);
    expect(driftNudge(x!).label).toBe("Zorbex plank is behind schedule with 3 weeks left — talk it through?");
    expect(standBlock(f, [x!])).not.toContain("behind pace");
  });
});

// ── The read ─────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("readStandFacts: one statement and the measures its key results need", () => {
  let db: Db;
  let userId: string;
  let other: string;
  let statements: string[];
  const at = (date: string, hhmm = "12:00") => `${date}T${hhmm}:00.000Z`;

  const planned = (id: string, date: string, category: string, state: string, over: Record<string, unknown> = {}, owner = userId) =>
    db.insert(schema.plannedWorkouts).values({
      id,
      userId: owner,
      planId: "p",
      sourceWorkoutId: `src-${id}`,
      title: "PLAN-TITLE-SENTINEL",
      category,
      sport: category === "strength" ? "strength" : "run",
      originalPlanDate: date,
      lastVerifiedCorosDate: date,
      effectiveDate: date,
      effectiveTime: "07:00",
      completionState: state,
      sourceContentFingerprint: "fp",
      calendarBlockDurationSeconds: 1800,
      createdAt: at(date),
      updatedAt: at(date),
      ...over,
    });
  const activity = (id: string, date: string, seconds: number, over: Record<string, unknown> = {}) =>
    db.insert(schema.activities).values({
      id,
      userId,
      startTime: `${date}T15:00:00Z`,
      startTimeLocal: `${date}T08:00:00`,
      sport: "run",
      durationSeconds: seconds,
      sourceMergeConfidence: 1,
      createdAt: at(date),
      updatedAt: at(date),
      ...over,
    });
  const memory = (id: string, kind: string, over: Record<string, unknown> = {}) =>
    db.insert(schema.coachMemory).values({
      id,
      userId,
      kind,
      body: "MEMORY-NOTE-SENTINEL",
      provenance: { source: "coach_inference", at: at(d(-3)) },
      learnedAt: at(d(-3)),
      active: true,
      pinned: false,
      confidence: "inferred",
      ...over,
    });

  beforeEach(async () => {
    statements = [];
    db = makeTestDb({ boundVariableCap: 100, onStatement: (s) => statements.push(s) });
    ({ userId } = await makeTestUser(db, { timezone: "America/Los_Angeles" }));
    ({ userId: other } = await makeTestUser(db));
    await planned("s1", d(-1), "strength", "completed", { origin: "studio" });
    await planned("s2", d(-3), "strength", "unresolved", { origin: "studio" });
    await planned("s3", d(-8), "strength", "skipped", { origin: "studio", sanctionedBy: "coach" });
    await planned("s4", d(-2), "strength", "missed", { origin: "studio", archivedAt: at(d(-1)) });
    await planned("r1", d(0), "easy", "scheduled");
    await planned("r2", d(13), "long", "scheduled");
    await planned("r3", d(14), "long", "scheduled");
    await planned("r4", d(-29), "easy", "missed");
    await planned("x1", d(-1), "strength", "missed", {}, other);
    // Off the plan: a run of 40 minutes; a 3-minute walk; a run that completed a planned one.
    await activity("a1", d(-4), 2400);
    await activity("a2", d(-4), 180);
    await db.insert(schema.workoutCompletionMatches).values({ id: "m1", userId, activityId: "a3", workoutId: "r4", confidence: 1, method: "scored_auto", matchedAt: at(d(-6)) } as never);
    await activity("a3", d(-6), 2400, { completionMatchId: "m1" });
    await db.insert(schema.dailyHealth).values([
      { id: `${userId}:1`, userId, date: d(-1), hrv: 61.4, restingHeartRate: 50.2, contentFingerprint: "f", updatedAt: at(d(-1)) },
      { id: `${userId}:20`, userId, date: d(-20), hrv: 40, contentFingerprint: "f", updatedAt: at(d(-20)) },
    ]);
    await db.insert(schema.sleepRecords).values({ id: `${userId}:s`, userId, date: d(-1), durationSeconds: 25200, contentFingerprint: "f", updatedAt: at(d(-1)) } as never);
    await db.insert(schema.weeklyReviews).values([
      { id: "wr1", userId, weekStart: "2026-10-19", facts: {}, narrative: "Older review.", createdAt: at("2026-10-27") },
      { id: "wr2", userId, weekStart: "2026-10-26", facts: {}, narrative: "Newest review. More.", createdAt: at("2026-11-03") },
    ]);
    await db.insert(schema.coachReads).values([
      { id: "cr1", userId, activityId: "a1", status: "done", nextAttemptAt: at(d(-4)), glance: "Flagged glance.", flags: ["hr_drift"], createdAt: at(d(-4)) },
      { id: "cr2", userId, activityId: "a3", status: "done", nextAttemptAt: at(d(-6)), glance: "Quiet glance.", flags: [], createdAt: at(d(-6)) },
    ]);
    await memory("core-fact", "fact");
    await memory("beyond-note", "note", { expiresAt: d(30) });
    await memory("beyond-obs-1", "observation");
    await memory("beyond-obs-2", "observation");
    await memory("rehearsal", "observation", { provenance: { source: "coach_inference", at: at(d(-3)), rehearsal: true } });
    await memory("conclusion", "rule", { body: "Zorbex: lifts on Saturdays.", provenance: { source: "coach_inference", at: at(d(-3)), runId: "r", drift: "drift:discipline:strength", checkBack: d(10) } });
    await db.insert(schema.objectives).values({ id: "o1", userId, title: "Zorbex calm", status: "active", goalIds: [], sort: 0, createdAt: at(d(-40)), updatedAt: at(d(-40)) });
    await db.insert(schema.objectives).values({ id: "o2", userId, title: "Zorbex paused", status: "paused", goalIds: [], sort: 1, createdAt: at(d(-40)), updatedAt: at(d(-40)) });
    await db.insert(schema.keyResults).values([
      { id: "k1", userId, objectiveId: "o1", label: "Energy", measure: { kind: "checkin", questionId: "energy" }, direction: "up", target: 8, unit: "score", position: 0, createdAt: at(d(-40)), updatedAt: at(d(-40)) },
      { id: "k2", userId, objectiveId: "o2", label: "Paused", measure: { kind: "threshold_pace", windowDays: 90 }, direction: "down", unit: "s/km", position: 0, createdAt: at(d(-40)), updatedAt: at(d(-40)) },
    ]);
    await db.insert(schema.athleteAnswers).values({ id: "an1", userId, questionId: "energy", valueNum: 6, source: "checkin", localDate: d(-2), at: at(d(-2)) });
  });

  it("reads the facts, the athlete's only, and spends exactly what standStatements says", async () => {
    statements.length = 0;
    const f = await readStandFacts(db, userId, { today: TODAY, tz: "America/Los_Angeles" });
    expect(statements.length).toBe(standStatements([keyResultMeasureSchema.parse({ kind: "checkin", questionId: "energy" })]));
    expect(statements.length).toBe(2);
    expect(statements.filter(isWrite)).toEqual([]);
    expect(f.plan.map((p) => p.id).sort()).toEqual(["r1", "r2", "s1", "s2", "s3"]);
    expect(f.unplanned).toEqual([{ date: d(-4), discipline: "runs" }]);
    expect(f.health.map((h) => h.date)).toEqual([d(-1)]);
    expect(f.sleep).toEqual([{ date: d(-1), seconds: 25200 }]);
    expect(f.review).toEqual({ weekStart: "2026-10-26", narrative: "Newest review. More." });
    expect(f.reads).toEqual([{ date: d(-4), sport: "run", seconds: 2400, flags: ["hr_drift"], glance: "Flagged glance." }]);
    expect(f.beyondCore).toEqual({ note: 1, observation: 2 });
    expect(f.conclusions).toEqual([{ id: "conclusion", drift: "drift:discipline:strength", checkBack: d(10), at: at(d(-3)), body: "Zorbex: lifts on Saturdays." }]);
    expect(f.objectives).toHaveLength(1);
    expect(f.objectives[0]!.keyResults[0]).toMatchObject({ id: "k1", label: "Energy", target: 8, createdOn: d(-40), progress: { current: 6 } });
    expect(JSON.stringify(f)).not.toContain("PLAN-TITLE-SENTINEL");
    expect(JSON.stringify(f)).not.toContain("MEMORY-NOTE-SENTINEL");
  });

  it("reads the athlete's active, unended plans in the same statement: not a retired, archived, ended, studio or another athlete's", async () => {
    const plan = (id: string, over: Record<string, unknown> = {}, who = userId) =>
      db.insert(schema.programs).values({
        id, userId: who, kind: "coach", name: `Zorbex ${id}`, status: "active", disciplines: ["run"], config: {}, createdAt: at(d(-9)), updatedAt: at(d(-9)), ...over,
      } as never);
    await plan("a", { purpose: "Zorbex purpose", endDate: d(10) });
    await plan("b", { createdAt: at(d(-8)) });
    await plan("c", { status: "retired" });
    await plan("e", { archivedAt: at(d(-1)) });
    await plan("f", { endDate: d(-1) });
    await plan("g", { kind: "studio" });
    await plan("h", {}, other);
    statements.length = 0;
    const f = await readStandFacts(db, userId, { today: TODAY, tz: "UTC" });
    expect(statements.length).toBe(2);
    expect(f.plans).toEqual([
      { id: "a", name: "Zorbex a", purpose: "Zorbex purpose" },
      { id: "b", name: "Zorbex b", purpose: null },
    ]);
  });

  it("a plan stores no dates: it is unended while a block of it, or a session filed under it, is still ahead", async () => {
    const plan = (id: string) =>
      db.insert(schema.programs).values({
        id, userId, kind: "coach", name: `Zorbex ${id}`, status: "active", disciplines: ["run"], config: {}, createdAt: at(d(-9)), updatedAt: at(d(-9)),
      } as never);
    const block = (id: string, programId: string, end: string) =>
      db.insert(schema.coachPlans).values({
        id, userId, discipline: "run", name: "Synthetic block", status: "active", startDate: d(-30), endDate: end, raceDate: null, stampPrefix: "S", programId, createdAt: at(d(-30)), updatedAt: at(d(-30)),
      });
    await plan("over");
    await block("b-over", "over", d(-3));
    await plan("running");
    await block("b-old", "running", d(-20));
    await block("b-new", "running", d(5));
    const f = await readStandFacts(db, userId, { today: TODAY, tz: "UTC" });
    expect(f.plans.map((p) => p.id)).toEqual(["running"]);
  });

  it("#8 rows read stay bounded by the windows, not the lifetime: every activity, session and read search uses a time range (query plan)", async () => {
    const plan = ((await db.all(sql`explain query plan ${standRowsSql(db, userId, TODAY, { library: false })}`)) as Array<{ detail: string }>).map((r) => r.detail);
    const on = (table: string) => plan.filter((l) => new RegExp(`^(SEARCH|SCAN) ${table}\\b`).test(l));
    expect(plan.filter((l) => /^SCAN (activities|performed_sessions|coach_reads|planned_workouts|coach_memory)\b/.test(l))).toEqual([]);
    for (const l of on("activities")) expect(l, l).toMatch(/activities_user_time_idx \(user_id=\? AND start_time>\? AND start_time<\?\)|\(id=\?\)/);
    expect(on("activities").filter((l) => /start_time/.test(l))).toHaveLength(2);
    for (const l of on("performed_sessions")) expect(l, l).toMatch(/local_date>\? AND local_date<\?/);
    for (const l of on("coach_reads")) expect(l, l).toMatch(/coach_reads_user_activity_unique \(user_id=\? AND activity_id=\?\)/);
  });

  it("an empty account: one statement, nothing measured", async () => {
    const { userId: empty } = await makeTestUser(db);
    statements.length = 0;
    const f = await readStandFacts(db, empty, { today: TODAY, tz: "UTC" });
    expect(statements.length).toBe(1);
    expect(standStatements([])).toBe(1);
    expect(f).toMatchObject({ objectives: [], plan: [], unplanned: [], health: [], sleep: [], review: null, reads: [], beyondCore: {}, conclusions: [], plans: [] });
  });

  it("a key result whose measure no longer reads: no data, never a throw", async () => {
    await db.insert(schema.keyResults).values({ id: newId(), userId, objectiveId: "o1", label: "Broken", measure: { kind: "nope" }, direction: "up", unit: "s", position: 1, createdAt: at(d(-1)), updatedAt: at(d(-1)) });
    const f = await readStandFacts(db, userId, { today: TODAY, tz: "UTC" });
    expect(f.objectives[0]!.keyResults[1]).toMatchObject({ label: "Broken", measure: null, progress: null });
  });
});

describe("the rich fixture's block, pinned before the CPU pass (bench 1a's account)", () => {
  /** Captured 2026-11-06 before the context step's CPU was cut: every cut must leave it byte-identical. REBASED 2026-11-06 (plans with a purpose, §4.3): one new line per active plan —
   the fixture's one programme, with no purpose yet — after the next 14 days; nothing else moved. */
  const RICH_BLOCK = "# Where you stand (the app's own figures)\nObjectives — current → target by due: pace:\n- <user>-obj-hold: <untrusted from=\"athlete\">Wall sit hold</untrusted> 46 s (at least) → 90 s: no data (no due date)\n- <user>-obj-hold: <untrusted from=\"athlete\">Goblet squat estimated max</untrusted> 44.3 lb (at least) → 60 lb: no data (no due date)\n- <user>-obj-run: <untrusted from=\"athlete\">5K time</untrusted> 27:30 (few readings) → 25:00: no data (one reading so far)\n- and 3 more key results (read_objectives)\nPlanned → done, last 14 d | 4 wk (missed · skipped · not known):\n- runs 0/0 | 0/0, +9 off the plan in 4 wk\n- strength 3/3 | 6/6\n- yoga 0/0 | 0/0, +1 off the plan in 4 wk\nNext 14 days (a day not listed: nothing planned):\nWed 13 May: strength 35 min; strength 40 min\nFri 15 May: strength 35 min\nSat 16 May: easy run 45 min\nSun 17 May: strength 35 min\nTue 19 May: strength 35 min; easy run 45 min\nWed 20 May: strength 40 min\nThu 21 May: strength 35 min\nFri 22 May: long run 90 min\nSat 23 May: strength 35 min\nMon 25 May: strength 35 min; easy run 45 min\nPlans (read_plans has each one's brief and ending):\n- <untrusted from=\"athlete\">Strength block</untrusted>: no purpose set yet\nReadiness: good. Last 7 d, oldest first — HRV 57 58 54 55 56 57 58 (usual 56, steady) · resting HR 50 52 51 50 52 51 50 (usual 51, steady) · sleep 7.2 h a night (7.0–7.5)\nLast weekly review: none yet.\nActivity reads flagged in 7 d: none.\nMemory beyond the core: 1 fact, 8 notes, 7 observations (recall_memory).\nNeeds you: nothing the app sees.";

  it("reads byte-identically", async () => {
    const db = makeTestDb();
    const { userId } = await seedRichAthlete(db);
    const f = await readStandFacts(db, userId, { today: RICH_TODAY, tz: "America/Los_Angeles" });
    expect(standBlock(f, driftsOf(f)).replaceAll(userId, "<user>")).toBe(RICH_BLOCK);
  });
});
