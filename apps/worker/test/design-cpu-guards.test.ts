/**
 * THE COACH DESIGNER'S CPU GUARDS that no other suite pins (the go-live CPU gate, design-cpu-bench.test.ts): what a
 * request rebuilds every time it runs is built once. A timezone's formatter is the costly part of reading a clock in it
 * (tens of µs a build, a few to format), and every read tool, propose and the approve read the athlete's clock.
 * Behaviour is unchanged; the suites of each caller pin it.
 */
import { afterEach, describe, expect, it } from "vitest";
import { DOCUMENT_TOOLS, MAX_TOOL_CPU_WEIGHT, MODEL_STEP_CPU_ROOM, PENDING_STEP_CPU_ROOM } from "../src/services/coach-runs.js";
import { allTools } from "../src/services/design-tools/index.js";
import { readAthlete } from "../src/services/design-tools/read-common.js";
import { clockIn } from "../src/services/design-time.js";
import { makeTestDb, makeTestUser } from "./helpers.js";

const Real = Intl.DateTimeFormat;
let built = 0;

/** Count every formatter built from here on (the real one still does the work). */
function countFormatters(): void {
  built = 0;
  const counting = function (this: unknown, ...args: ConstructorParameters<typeof Intl.DateTimeFormat>) {
    built += 1;
    return new Real(...args);
  } as unknown as typeof Intl.DateTimeFormat;
  Object.assign(counting, Real);
  Intl.DateTimeFormat = counting;
}

afterEach(() => {
  Intl.DateTimeFormat = Real;
});

describe("a timezone's formatter is built once, not on every read of the clock", () => {
  it("readAthlete: the second read of the same athlete builds none — the zone's check and its today are kept", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db, { timezone: "Pacific/Chatham" });
    const { userId: lost } = await makeTestUser(db, { timezone: "Mars/Olympus_Mons" });
    const now = new Date("2026-10-16T10:00:00Z");
    countFormatters();
    const first = await readAthlete(db, userId, now);
    const unknown = await readAthlete(db, lost, now);
    const before = built;
    const again = await readAthlete(db, userId, now);
    const unknownAgain = await readAthlete(db, lost, now);
    expect(built - before).toBe(0);
    // The same answers: the athlete's zone, and UTC said plainly for a zone the runtime doesn't know.
    expect(again).toEqual(first);
    expect(unknownAgain).toEqual(unknown);
    expect(first.athlete.tz).toBe("Pacific/Chatham");
    expect(unknown.athlete.tz).toBe("UTC");
    expect(unknown.athlete.missing).toContain("timezone unknown — using UTC");
  });

  it("clockIn (propose, the approve and the manifest): the second read in a zone builds none, and reads the same clock", () => {
    const fresh = (tz: string, now: Date) => {
      const parts = new Real("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(now);
      const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "0";
      return { date: `${get("year")}-${get("month")}-${get("day")}`, minutes: Number(get("hour")) * 60 + Number(get("minute")) + Number(get("second")) / 60 };
    };
    const at = [new Date("2026-03-08T09:59:59Z"), new Date("2026-03-08T10:00:00Z"), new Date("2026-11-01T08:30:00Z"), new Date("2026-11-01T09:30:00Z"), new Date("2026-12-31T23:59:59Z")];
    countFormatters();
    clockIn("America/Los_Angeles", at[0]!);
    clockIn("Not/AZone", at[0]!);
    const before = built;
    for (const now of at) {
      expect(clockIn("America/Los_Angeles", now)).toEqual(fresh("America/Los_Angeles", now));
      expect(clockIn("Not/AZone", now)).toEqual(fresh("UTC", now));
    }
    expect(built - before).toBe(0);
  });
});

describe("every tool declares the CPU one call takes (the bench holds each declaration to what it measures)", () => {
  it("a weight above nothing and within what a step of queued calls holds, in tenths of a ms; the document tools are the registry's own", () => {
    expect(MODEL_STEP_CPU_ROOM).toBeLessThan(PENDING_STEP_CPU_ROOM);
    expect(MAX_TOOL_CPU_WEIGHT).toBe(PENDING_STEP_CPU_ROOM);
    for (const t of allTools()) {
      expect(t.cpuWeight, t.name).toBeGreaterThan(0);
      expect(t.cpuWeight, t.name).toBeLessThanOrEqual(MAX_TOOL_CPU_WEIGHT);
      expect(Math.round(t.cpuWeight * 10) / 10, t.name).toBe(t.cpuWeight);
    }
    const names = allTools().map((t) => t.name);
    for (const name of DOCUMENT_TOOLS) expect(names, name).toContain(name);
  });
});
