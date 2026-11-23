/**
 * TODAY'S EXCHANGE, REPLAYED (R1.7; r1-7/BRIEF.md "Build" 2; r1-6/FOLLOWUPS.md "Found live"). On Mon 23 Nov the owner asked the
 * web coach for TRE every 2 weeks on Mondays, from today. The card read "Next TRE Mon 23 Nov, then Mon 21 Dec": their race, a
 * 10K time trial on Sat 12 Dec, held 5–12 Dec quiet, so Mon 7 Dec was passed over, and nothing said so. Asked next to put TRE
 * back on 7 Dec, the coach — which couldn't see the rule — said 7 Dec was already in the schedule. That was false.
 *
 * Here the same two turns run through the real registry, the real opening context and the real loop, driven by a scripted
 * model (no key, no network) that answers from what the tools and the context hand it, as the prompt now says to: the card's
 * computed lines and read_plans' heldBack are the truth about dates.
 *  - As it was (TRE read as R1.6 read every course: a race holds it back): the card names 7 Dec and why; the follow-up's
 *    read_plans and conversation both carry the race's reason; the reply says it, and never that 7 Dec is scheduled.
 *  - As R1.7 has it (TRE carries no training load, so the race doesn't hold it back): the card says 7 Dec is next, and the
 *    follow-up finds it on the plan.
 * The script stands in for the model, so what this proves is that the truth reaches the model, not which words a real model
 * picks (no real model calls in this build).
 *
 * Synthetic data only: a made-up account on fixed days under a faked `Date`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Whether TRE is read as R1.6 read every course (a race holds it back), for the replay of today's exchange as it was. */
const asR16 = vi.hoisted(() => ({ on: false }));
vi.mock("@rg/workout", async (importOriginal) => {
  const real = await importOriginal<typeof import("@rg/workout")>();
  const held = (id: string) => {
    const d = real.courseDefinition(id);
    if (!d || !asR16.on) return d;
    const { holdForRace: _calm, ...asItWas } = d;
    return asItWas;
  };
  return { ...real, courseDefinition: held };
});

import { and, eq, isNull } from "drizzle-orm";
import { schema } from "@rg/database";
import { courseConfigSchema } from "@rg/domain";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { loadPreferences } from "../src/services/calendar-sync.js";
import { createRun, runStep, type RunDeps } from "../src/services/coach-runs.js";
import { designContextBuilder } from "../src/services/design-context.js";
import { approveDesignOps } from "../src/services/design-approve.js";
import { allTools } from "../src/services/design-tools/index.js";
import { designProposalId } from "../src/services/design-tools/propose.js";
import type { ContentBlock, MessagesOk, MessagesRequest, MessagesResult } from "../src/services/llm-messages.js";
import type { PlanChangeOp } from "../src/services/proposal-kinds.js";
import { placeSlots, slotId } from "../src/services/program-slots.js";
import { makeTestDb, makeTestUser, untilDone } from "./helpers.js";

/** The main block's rules for dates and for who makes a change (design-prompt-dates-truth.test.ts holds them too). */
const DATES_TRUTH_LINE =
  "A card's computed lines (Next, Not …, Taken off) and read_plans' heldBack are the truth about a plan's dates: never contradict them or guess past them; explain with the reason they give, or say you don't know.";
const WHO_LINE = "Say who makes a change (\"I'll move it to Mondays\", \"Fridays will be taken off\"), never as if a thing changed itself (\"Reading moves to 4:00\", \"Fridays come off\").";

const env = { APP_URL: "https://app.test", FIXTURE_MODE: "0", AI_DEFAULT_ENABLED: "1" } as Env;
const RACE = "2026-12-12";
const MON23 = "2026-11-23";
/** Mon 23 Nov, 09:00 in Los Angeles: the ask. */
const ASKED = new Date("2026-11-23T17:00:00.000Z");
/** The follow-up, that evening at 18:00. */
const FOLLOW_UP = new Date("2026-11-24T02:00:00.000Z");
const ASK = "TRE every 2 weeks on Mondays, from today";
const PUT_BACK = "Can you put TRE back on 7 Dec?";

let db: Db;
let userId: string;
let tre: string;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(ASKED);
  db = makeTestDb({ boundVariableCap: 100 });
  userId = (await makeTestUser(db, { raceDate: RACE, raceDistanceKm: 10 })).userId;
  await db.insert(schema.athleteProfiles).values({ id: userId, userId, events: [{ id: "ev-tt", label: "10K time trial", kind: "race", start: RACE, priority: "A", taper: true }], updatedAt: ASKED.toISOString() });
  tre = `course-${userId}-tre`;
  // TRE as it stood: Mondays and Fridays at 19:30, Mon 16 Nov done; its outlines placed.
  await db.insert(schema.programs).values({
    id: tre, userId, kind: "course", name: "TRE", status: "active", disciplines: ["yoga"], onEnd: "continue", purpose: "Calm the nervous system",
    config: courseConfigSchema.parse({ course: "tre", weekdays: [0, 4], time: "19:30" }), createdAt: "2026-10-01T12:00:00.000Z", updatedAt: "2026-10-01T12:00:00.000Z",
  });
  const done = `tre-done-${userId.slice(0, 6)}`;
  await db.insert(schema.plannedWorkouts).values({
    id: done, userId, planId: tre, sourceWorkoutId: done, title: "TRE", category: "yoga", sport: "yoga", originalPlanDate: "2026-11-16", lastVerifiedCorosDate: "",
    effectiveDate: "2026-11-16", effectiveTime: "19:30", sourceContentFingerprint: "studio", fallbackEstimatedDurationSeconds: 1200, calendarBlockDurationSeconds: 1200,
    origin: "studio", contentState: "outline", completionState: "completed", courseSession: 1, createdAt: ASKED.toISOString(), updatedAt: ASKED.toISOString(),
  });
});

/** Its outlines, placed by the reading of TRE the test chose. */
const placed = async () => placeSlots(db, userId, tre, MON23, await loadPreferences(db, userId), ASKED.toISOString());
afterEach(() => {
  asR16.on = false;
  vi.useRealTimers();
});

let seq = 0;
const use = (name: string, input: unknown): ContentBlock => ({ type: "tool_use", id: `toolu_tt${++seq}`, name, input });
function turn(uses: ContentBlock[], text = "Working on it."): MessagesOk {
  return {
    ok: true,
    model: "anthropic/claude-opus-5.5",
    content: [{ type: "thinking", thinking: "", signature: `sig-${++seq}-${"x".repeat(30)}` }, { type: "text", text }, ...uses],
    stopReason: uses.length > 0 ? "tool_use" : "end_turn",
    usage: { inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 50, outputTokens: 40 },
    costMicros: 1_000,
  };
}

/** The last tool result the model was handed for `name`, parsed. */
function lastResult(req: MessagesRequest, name: string): Record<string, any> | null {
  const ids = new Map<string, string>();
  let out: Record<string, any> | null = null;
  for (const m of req.messages) {
    if (typeof m.content === "string") continue;
    for (const b of m.content) {
      if (b.type === "tool_use") ids.set(b.id, b.name);
      if (b.type === "tool_result" && ids.get(b.tool_use_id) === name) out = JSON.parse(typeof b.content === "string" ? b.content : b.content.map((c) => c.text).join(""));
    }
  }
  return out;
}

/** Everything the model was shown in a request: its system blocks and its messages' text. */
const shown = (req: MessagesRequest) =>
  [...req.system.map((b) => b.text), ...req.messages.flatMap((m) => (typeof m.content === "string" ? [m.content] : m.content.map((b) => ("text" in b ? String(b.text) : "content" in b ? JSON.stringify(b.content) : ""))))].join("\n");

const treOf = (read: Record<string, any> | null) => ((read?.data?.plans ?? []) as Array<Record<string, any>>).find((p) => p.name?.text === "TRE");

/** Turn 1, as the prompt routes it: read the plans, change TRE's rhythm with one change_plan, and say what the card says. */
function askCoach() {
  const requests: MessagesRequest[] = [];
  let step = 0;
  let reply = "";
  const deps: RunDeps = {
    callModel: async (_env, req): Promise<MessagesResult> => {
      requests.push(structuredClone(req));
      step += 1;
      if (step === 1) return turn([use("read_plans", {})], "Reading your plans.");
      if (step === 2) {
        const t = treOf(lastResult(req, "read_plans"));
        return turn([use("change_plan", { planId: t!.planId ?? t!.id, days: ["Mon"], everyWeeks: 2, from: MON23, why: "Every two weeks, as you asked: Mondays, from today." })]);
      }
      // The card's lines are the truth: its Next line, and each held-back date's own words.
      const res = lastResult(req, "change_plan")!.data;
      const next = (res.lines as string[]).find((l) => l.startsWith("Next "))!;
      const held = ((res.heldBack ?? []) as Array<{ line: string }>).map((h) => h.line);
      reply = [`TRE will be every second Monday from today. ${next}.`, ...held.map((l) => `${l}.`)].join(" ");
      return turn([use("finish", { summary: reply })], reply);
    },
    buildContext: designContextBuilder,
    tools: allTools(),
    review: true,
    clock: () => 0,
  };
  return { deps, requests, reply: () => reply };
}

/** Turn 2: read the plans, and answer from TRE's held-back dates and next sessions — or say it doesn't know. */
function putBackCoach() {
  const requests: MessagesRequest[] = [];
  let step = 0;
  let reply = "";
  const deps: RunDeps = {
    callModel: async (_env, req): Promise<MessagesResult> => {
      requests.push(structuredClone(req));
      step += 1;
      if (step === 1) return turn([use("read_plans", {})], "Checking TRE's dates.");
      const t = treOf(lastResult(req, "read_plans"))!;
      const held = ((t.heldBack ?? []) as Array<{ date: string; line: { text: string } }>).find((h) => h.date === "2026-12-07");
      const on = ((t.next ?? []) as Array<{ date: string }>).some((n) => n.date === "2026-12-07");
      reply = held
        ? `Mon 7 Dec is held back: ${held.line.text.replace(/^Not Mon 7 Dec: /, "")}. Say the word and I'll set TRE's quiet days before the race to none, so it's placed on 7 Dec.`
        : on
          ? "TRE is already on Mon 7 Dec, at 19:30."
          : "I don't know why Mon 7 Dec isn't on the plan.";
      return turn([use("finish", { summary: reply })], reply);
    },
    buildContext: designContextBuilder,
    tools: allTools(),
    review: true,
    clock: () => 0,
  };
  return { deps, requests, reply: () => reply };
}

async function drive(runId: string, deps: RunDeps, at: Date) {
  let last = "active";
  await untilDone(
    async (i) => {
      const out = await runStep(db, env, runId, userId, new Date(at.getTime() + i * 1000), deps);
      if (out.kind !== "ok") throw new Error(`step answered ${out.kind}`);
      last = out.result.status;
      return last !== "active";
    },
    { max: 40, what: "drive" },
  );
  return last;
}

async function approveCard(runId: string, at: Date): Promise<PlanChangeOp> {
  const [p] = await db.select().from(schema.coachProposals).where(eq(schema.coachProposals.id, designProposalId(runId)));
  const op = (p!.ops as PlanChangeOp[]).find((o) => o.kind === "plan_change")!;
  const prefs = await loadPreferences(db, userId);
  const res = await approveDesignOps(db, userId, p! as never, { opIds: [op.id] }, { today: MON23, now: at.toISOString(), prefs }, Number.POSITIVE_INFINITY);
  expect(res.status, JSON.stringify(res)).toBe("approved");
  return op;
}

const liveDates = async () =>
  (await db.select().from(schema.plannedWorkouts).where(and(eq(schema.plannedWorkouts.planId, tre), isNull(schema.plannedWorkouts.archivedAt))))
    .filter((r) => r.completionState === "scheduled")
    .map((r) => r.effectiveDate)
    .sort();

/** Says 7 Dec is on the plan, in any of the ways the coach said it on 23 Nov. */
const SAYS_SCHEDULED = /7 Dec(ember)? (is|'s) (already )?(in the schedule|scheduled|on the plan|set|on\b)|is in the schedule/i;

describe("today's exchange as it was: a race holds TRE back (R1.6's reading)", () => {
  it("the card names 7 Dec and why; the follow-up gets the race's reason and never says 7 Dec is scheduled", async () => {
    asR16.on = true;
    await placed();
    const first = (await createRun(db, userId, { scope: { kind: "auto" }, request: ASK }, ASKED)).run.id;
    const ask = askCoach();
    expect(await drive(first, ask.deps, ASKED)).toBe("finished");
    // The rule the model works by.
    expect(ask.requests[0]!.system.map((b) => b.text).join("\n")).toContain(`${DATES_TRUTH_LINE} ${WHO_LINE}`);
    // change_plan's answer: the card's lines, and 7 Dec with its reason code and words.
    const told = lastResult(ask.requests.at(-1)!, "change_plan")!.data;
    expect(told.lines).toEqual([
      "Days Mon · Fri → Mon",
      "Every week → Every 2 weeks",
      "Next TRE Mon 23 Nov, then Mon 21 Dec",
      "Not Mon 7 Dec: the week before your 10K time trial is kept quiet",
      "Taken off: Fri 27 Nov · Mon 30 Nov · Fri 4 Dec",
    ]);
    expect(told.heldBack).toEqual([{ date: "2026-12-07", reason: "race_quiet", line: "Not Mon 7 Dec: the week before your 10K time trial is kept quiet" }]);
    expect(ask.reply()).toBe("TRE will be every second Monday from today. Next TRE Mon 23 Nov, then Mon 21 Dec. Not Mon 7 Dec: the week before your 10K time trial is kept quiet.");
    await approveCard(first, ASKED);
    expect(await liveDates()).toEqual([MON23]);

    // The follow-up, in the same conversation.
    vi.setSystemTime(FOLLOW_UP);
    const second = (await createRun(db, userId, { scope: { kind: "auto" }, request: PUT_BACK }, FOLLOW_UP)).run.id;
    const back = putBackCoach();
    expect(await drive(second, back.deps, FOLLOW_UP)).toBe("finished");
    // The conversation so far carries what the card said, its reason among it.
    expect(shown(back.requests[0]!)).toContain("The card's lines:");
    expect(shown(back.requests[0]!)).toContain("Not Mon 7 Dec: the week before your 10K time trial is kept quiet");
    // read_plans: TRE's race quiet window, and 7 Dec held back with the card's words.
    const t = treOf(lastResult(back.requests.at(-1)!, "read_plans"))!;
    expect(t.raceQuiet).toEqual({ from: "2026-12-05", to: RACE });
    expect(t.heldBack).toEqual([{ date: "2026-12-07", reason: "race_quiet", line: { untrusted: true, text: "Not Mon 7 Dec: the week before your 10K time trial is kept quiet" } }]);
    expect(back.reply()).toContain("the week before your 10K time trial is kept quiet");
    expect(back.reply()).not.toMatch(SAYS_SCHEDULED);
  });
});

describe("the same exchange with R1.7: TRE carries no training load, so the race doesn't hold it back", () => {
  it("the card says 7 Dec is next; approved, it is placed; the follow-up finds it on the plan", async () => {
    await placed();
    const first = (await createRun(db, userId, { scope: { kind: "auto" }, request: ASK }, ASKED)).run.id;
    const ask = askCoach();
    expect(await drive(first, ask.deps, ASKED)).toBe("finished");
    const told = lastResult(ask.requests.at(-1)!, "change_plan")!.data;
    expect(told.lines).toContain("Next TRE Mon 23 Nov, then Mon 7 Dec");
    expect(told.heldBack).toBeUndefined();
    await approveCard(first, ASKED);
    expect(await liveDates()).toEqual([MON23, "2026-12-07"]);
    expect((await db.select().from(schema.plannedWorkouts).where(eq(schema.plannedWorkouts.id, slotId(tre, "2026-12-07"))))[0]!.effectiveTime).toBe("19:30");

    vi.setSystemTime(FOLLOW_UP);
    const second = (await createRun(db, userId, { scope: { kind: "auto" }, request: PUT_BACK }, FOLLOW_UP)).run.id;
    const back = putBackCoach();
    expect(await drive(second, back.deps, FOLLOW_UP)).toBe("finished");
    const t = treOf(lastResult(back.requests.at(-1)!, "read_plans"))!;
    expect(t.raceQuiet).toBe("none");
    expect(t.heldBack).toBeUndefined();
    expect(back.reply()).toBe("TRE is already on Mon 7 Dec, at 19:30.");
  });
});
