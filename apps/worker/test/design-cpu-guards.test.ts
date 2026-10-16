/**
 * THE COACH DESIGNER'S CPU GUARDS that no other suite pins (the go-live CPU gate, design-cpu-bench.test.ts): what a
 * request rebuilds every time it runs is built once. A timezone's formatter is the costly part of reading a clock in it
 * (tens of µs a build, a few to format), and every read tool, propose and the approve read the athlete's clock. The
 * athlete themselves — preferences, switched-on profiles and today's checks — is read once for a step's read tools.
 * Behaviour is unchanged; the suites of each caller pin it.
 */
import { afterEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { Env } from "../src/env.js";
import { createRun, DOCUMENT_TOOLS, MAX_TOOL_CPU_WEIGHT, MODEL_STEP_CPU_ROOM, PENDING_STEP_CPU_ROOM, runStep, type RunDeps } from "../src/services/coach-runs.js";
import { allTools } from "../src/services/design-tools/index.js";
import { readAthlete } from "../src/services/design-tools/read-common.js";
import type { ToolContext } from "../src/services/design-tools/types.js";
import { clockIn } from "../src/services/design-time.js";
import type { ContentBlock, MessagesRequest, MessagesResult, ToolResultBlock } from "../src/services/llm-messages.js";
import { day, NOW, seedRichAthlete, TODAY } from "./design-read-fixture.js";
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

describe("a step's read tools read the athlete once between them", () => {
  /** The read tools that need nothing beside the athlete, with an ask each — as a designer's first turn asks them. */
  const READS: Array<[string, unknown]> = [
    ["read_history", { from: day(28), to: TODAY }],
    ["read_day", { date: TODAY }],
    ["read_plan", { from: TODAY, to: day(-13) }],
    ["read_answers", { limit: 20 }],
    ["recall_memory", { limit: 10 }],
  ];

  it("one athlete read for the step's calls (it was one a call), and every answer exactly the one the tool gives alone", async () => {
    const statements: string[] = [];
    const db = makeTestDb({ boundVariableCap: 100, onStatement: (text) => statements.push(text) });
    const rich = await seedRichAthlete(db);
    const runId = (await createRun(db, rich.userId, { scope: { kind: "now" }, request: "Something calm." }, NOW)).run.id;
    let seq = 0;
    const uses: ContentBlock[] = READS.map(([name, input]) => ({ type: "tool_use", id: `toolu_once${++seq}`, name, input }));
    const requests: MessagesRequest[] = [];
    const turn = (content: ContentBlock[]): MessagesResult => ({
      ok: true,
      model: "anthropic/claude-opus-5.5",
      content: [{ type: "thinking", thinking: "", signature: "sig" }, ...content],
      stopReason: "tool_use",
      usage: { inputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 10 },
      costMicros: 100,
    });
    const turns = [turn(uses), turn([{ type: "tool_use", id: "toolu_once_end", name: "finish", input: { summary: "Done." } }])];
    const deps: RunDeps = {
      callModel: async (_env, req) => {
        requests.push(structuredClone(req));
        return turns.shift()!;
      },
      buildContext: { statementCost: 0, build: async () => ({ system: [{ type: "text", text: "S" }], header: "H" }) },
      tools: allTools(),
    };
    const env = { APP_URL: "https://app.test", FIXTURE_MODE: "0", AI_DEFAULT_ENABLED: "1" } as Env;
    const athleteReads = () => statements.filter((s) => s.includes(") as prefs")).length;
    await runStep(db, env, runId, rich.userId, NOW, deps); // context
    // The model step runs what its CPU room holds (read_history, read_day, read_plan: 2.3 of 2.5); the rest queued.
    statements.length = 0;
    const model = await runStep(db, env, runId, rich.userId, new Date(NOW.getTime() + 1000), deps);
    expect(model.kind === "ok" && model.result.events.filter((e) => e.kind === "tool_result").length).toBe(3);
    expect(athleteReads()).toBe(1);
    statements.length = 0;
    const queued = await runStep(db, env, runId, rich.userId, new Date(NOW.getTime() + 2000), deps);
    expect(queued.kind === "ok" && queued.result.events.filter((e) => e.kind === "tool_result").length).toBe(2);
    expect(athleteReads()).toBe(1);
    await runStep(db, env, runId, rich.userId, new Date(NOW.getTime() + 3000), deps); // the model sees every result
    const results = requests[1]!.messages.at(-1)!.content as ToolResultBlock[];
    expect(results.map((r) => r.tool_use_id)).toEqual(uses.map((u) => (u as { id: string }).id));
    // Each answer as the tool gives it alone, at the step's instant (the tool reading the athlete itself).
    for (const [k, [name, input]] of READS.entries()) {
      const ctx: ToolContext = { db, env, userId: rich.userId, run: { id: runId, role: "main", scope: { kind: "now" }, parentId: null, rehearsal: false }, now: new Date(NOW.getTime() + (k < 3 ? 1000 : 2000)) };
      const alone = await allTools().find((t) => t.name === name)!.run(ctx, input);
      const { summary: _s, receipt: _r, control: _c, ...forModel } = alone as unknown as Record<string, unknown>;
      expect(JSON.parse(results[k]!.content as string), name).toEqual(JSON.parse(JSON.stringify(forModel)));
    }
  });

  it("a read that fails is not kept: the next call reads again", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db, { timezone: "Europe/Berlin" });
    const { sharedAthlete } = await import("../src/services/design-tools/read-common.js");
    let fail = true;
    const flaky = new Proxy(db, {
      get(target, key, receiver) {
        if (key === "all" && fail) {
          fail = false;
          return async () => {
            throw new Error("D1 hiccup");
          };
        }
        return Reflect.get(target, key, receiver);
      },
    });
    const athlete = sharedAthlete(flaky, userId, NOW);
    await expect(athlete()).rejects.toThrow("D1 hiccup");
    const first = await athlete();
    expect(first.tz).toBe("Europe/Berlin");
    // Each call has its own `missing`: a tool adding to its own never adds to another's.
    first.missing.push("mine");
    expect((await athlete()).missing).not.toContain("mine");
    await db.run(sql`select 1`);
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
