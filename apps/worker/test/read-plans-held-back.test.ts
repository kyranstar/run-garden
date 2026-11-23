/**
 * READ_PLANS GIVES A COURSE'S RACE QUIET WINDOW, AND THE DATES A RULE HOLDS BACK (R1.7; r1-7/BRIEF.md "Build" 2).
 *
 * The owner's follow-up on 23 Nov ("put TRE back on 7 Dec") met a coach that couldn't see the race's quiet days, so it said 7
 * Dec was in the schedule. Now, while a race is near, a course says which days before it it keeps clear (`raceQuiet`: its
 * window, or "none" for a course whose sessions carry no training load), and every course lists the dates of its rhythm a
 * rule holds back, with the rule and the card's own words (`heldBack`). A course a race holds back lists its quiet days among
 * the settings change_plan changes. Still one statement.
 *
 * Synthetic data only, on the rich fixture's fixed clock (today Wed 13 May 2026; its race "Spring half", Sat 20 Jun).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@rg/workout", async (importOriginal) => {
  const { withIntroCourse } = await import("./course-fixture.js");
  return withIntroCourse(await importOriginal<typeof import("@rg/workout")>());
});

import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { courseConfigSchema, type CourseConfig } from "@rg/domain";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { readPlans, RACE_QUIET_NOTE } from "../src/services/design-tools/read-plans.js";
import { isToolErr } from "../src/services/design-tools/types.js";
import { at, day, NOW, seedRichAthlete } from "./design-read-fixture.js";
import { INTRO_COURSE } from "./course-fixture.js";
import { makeTestDb } from "./helpers.js";

let db: Db;
let userId: string;
const statements: string[] = [];

beforeEach(async () => {
  db = makeTestDb({ boundVariableCap: 100, onStatement: (s) => statements.push(s) });
  userId = (await seedRichAthlete(db)).userId;
});

const ID = "course-invented-tre";
async function course(definition: string, config: Partial<CourseConfig> = {}, pausedUntil: string | null = null) {
  await db.insert(schema.programs).values({
    id: ID, userId, kind: "course", name: "TRE", status: "active", disciplines: ["yoga"], onEnd: "continue", pausedUntil,
    config: courseConfigSchema.parse({ course: definition, weekdays: [0], time: "19:30", ...config }), createdAt: at(day(60)), updatedAt: at(day(60)),
  });
}

async function readTre(): Promise<{ entry: Record<string, any>; data: Record<string, any> }> {
  statements.length = 0;
  const res = await readPlans.run({ db, env: {} as Env, userId, run: { id: "r", role: "main", scope: { kind: "auto" }, parentId: null, rehearsal: false }, now: NOW }, {});
  if (isToolErr(res)) throw new Error(res.why);
  const data = res.data as Record<string, any>;
  const entry = (data.plans as Array<Record<string, any>>).find((p) => p.id === ID);
  if (!entry) throw new Error("TRE not listed in full");
  return { entry, data };
}

const marked = (text: string) => ({ untrusted: true, text });

describe("a course a race holds back, with the race near", () => {
  it("its quiet days are a setting, its window is given, and Mon 15 Jun is held back with the card's words", async () => {
    await course(INTRO_COURSE.id);
    const { entry, data } = await readTre();
    expect(entry.settings).toEqual({ days: ["Mon"], time: "19:30", everyWeeks: 1, quietDaysBeforeRace: 7 });
    expect(entry.raceQuiet).toEqual({ from: "2026-06-13", to: "2026-06-20" });
    expect(entry.heldBack).toEqual([{ date: "2026-06-15", reason: "race_quiet", line: marked("Not Mon 15 Jun: the week before your Spring half is kept quiet") }]);
    expect(data.raceQuietNote).toBe(RACE_QUIET_NOTE);
    expect(statements).toHaveLength(1);
  });

  it("no quiet days: only race day is kept, and a Saturday course names it", async () => {
    await course(INTRO_COURSE.id, { weekdays: [5], quietDaysBeforeRace: 0 });
    const { entry } = await readTre();
    expect(entry.raceQuiet).toEqual({ from: "2026-06-20", to: "2026-06-20" });
    expect(entry.heldBack).toEqual([{ date: "2026-06-20", reason: "race_day", line: marked("Not Sat 20 Jun: it's the day of your Spring half") }]);
  });
});

describe("the real TRE: a race doesn't hold it back", () => {
  it("raceQuiet says none, its settings list no quiet days, and nothing is held back", async () => {
    await course("tre");
    const { entry, data } = await readTre();
    expect(entry.raceQuiet).toBe("none");
    expect(entry.settings).toEqual({ days: ["Mon"], time: "19:30", everyWeeks: 1 });
    expect(entry.heldBack).toBeUndefined();
    expect(data.raceQuietNote).toBe(RACE_QUIET_NOTE);
  });

  it("a pause holds its dates back, said with the pause's own end", async () => {
    await course("tre", {}, "2026-05-27");
    const { entry } = await readTre();
    expect(entry.heldBack).toEqual([
      { date: "2026-05-18", reason: "paused", line: marked("Not Mon 18 May: TRE is paused until Wed 27 May") },
      { date: "2026-05-25", reason: "paused", line: marked("Not Mon 25 May: TRE is paused until Wed 27 May") },
    ]);
  });
});

describe("with no race near", () => {
  it("no window, no note", async () => {
    await course(INTRO_COURSE.id);
    const [prefs] = await db.select().from(schema.userPreferences).where(eq(schema.userPreferences.userId, userId));
    await db.update(schema.userPreferences).set({ prefs: { ...prefs!.prefs, raceDate: "2026-09-12" } }).where(eq(schema.userPreferences.userId, userId));
    const { entry, data } = await readTre();
    expect(entry.raceQuiet).toBeUndefined();
    expect(entry.heldBack).toBeUndefined();
    expect(data.raceQuietNote).toBeUndefined();
    // Its quiet days are still a setting it has.
    expect(entry.settings.quietDaysBeforeRace).toBe(7);
  });
});
