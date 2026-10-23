/**
 * Weekly-review narration in the athlete's own units (audit 2026-08-14).
 *
 * The deployed review read "covering 16.9 km in about 4.4 hours" for an
 * athlete whose preference is Miles: the prompt shipped raw metres and let
 * the model do the conversion. Prose can't be fixed by a render-time
 * formatter, so the fix is upstream — the model is handed numbers ALREADY in
 * the athlete's units and told never to convert.
 *
 * Gateway stubbing follows studio-llm.test.ts's `scriptedFetch` seam.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { schema } from "@rg/database";
import type { Env } from "../src/env.js";
import {
  buildWeeklyReviewSystemPrompt,
  generateWeeklyReview,
  narrationFacts,
} from "../src/services/llm.js";
import { makeTestDb, makeTestUser } from "./helpers.js";
import type { Db } from "../src/services/db.js";

const METRIC_FACTS = {
  weekStart: "2026-08-03",
  planned: 5,
  completed: 2,
  moved: 0,
  skipped: 3,
  totalDurationSeconds: 15_840, // 4.4 h
  totalDistanceMeters: 16_900,
  qualitySessions: 1,
  longRunCompleted: false,
  adherencePct: 40,
  gardenSummary: "A quiet week in the garden",
};

function makeEnv(): Env {
  return {
    APP_URL: "https://app.test",
    SESSION_SECRET: "s",
    TOKEN_ENCRYPTION_KEY: "k",
    AI_GATEWAY_API_KEY: "test-key",
  } as Env;
}

/** Records every request body; replies with a fixed narrative. */
function scriptedFetch(narrative = "All good.") {
  const sent: Array<Record<string, unknown>> = [];
  const impl = (async (_url: string | URL | Request, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ narrative }) } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
  return { impl, sent };
}

const systemOf = (body: Record<string, unknown>): string =>
  (body.messages as Array<{ role: string; content: string }>).find((m) => m.role === "system")!
    .content;
const userOf = (body: Record<string, unknown>): string =>
  (body.messages as Array<{ role: string; content: string }>).find((m) => m.role === "user")!
    .content;

let db: Db;
let userId: string;

beforeEach(async () => {
  db = makeTestDb();
  ({ userId } = await makeTestUser(db));
});

describe("narrationFacts", () => {
  it("pre-converts distance to miles and names the unit, dropping the metric raws", () => {
    const out = narrationFacts(METRIC_FACTS, "mi");
    expect(out.totalDistance).toBe(10.5); // 16 900 m / 1609.344
    expect(out.distanceUnit).toBe("miles");
    expect(out.totalHours).toBe(4.4);
    // The model must never SEE a number it could convert.
    expect(out).not.toHaveProperty("totalDistanceMeters");
    expect(out).not.toHaveProperty("totalDurationSeconds");
  });

  it("pre-converts to kilometres for a km athlete", () => {
    const out = narrationFacts(METRIC_FACTS, "km");
    expect(out.totalDistance).toBe(16.9);
    expect(out.distanceUnit).toBe("kilometres");
  });

  it("passes every other fact through untouched — but no percentage: the review says what got done, never a rate", () => {
    const out = narrationFacts(METRIC_FACTS, "mi");
    expect(out.planned).toBe(5);
    expect(out.completed).toBe(2);
    expect(out.gardenSummary).toBe("A quiet week in the garden");
    // The owner's coach opened with "…for an adherence rate of 50%" (2026-10-19): the model never sees one to quote.
    expect(out).not.toHaveProperty("adherencePct");
  });

  it("omits the derived keys rather than emitting NaN when a raw is missing", () => {
    const out = narrationFacts({ planned: 3 }, "mi");
    expect(out).not.toHaveProperty("totalDistance");
    expect(out).not.toHaveProperty("totalHours");
    expect(out.distanceUnit).toBe("miles");
  });
});

describe("buildWeeklyReviewSystemPrompt", () => {
  it("names the athlete's unit and forbids conversion", () => {
    const mi = buildWeeklyReviewSystemPrompt("mi");
    expect(mi).toContain("miles");
    expect(mi).not.toContain("kilometres");
    expect(mi).toContain("never convert");
    expect(buildWeeklyReviewSystemPrompt("km")).toContain("kilometres");
  });

  /**
   * The owner's voice (2026-10-19): brisk, plain, one next step, no fluff, no apologies. The first sentence is the
   * coach's opening line on Monday (the opening shows only it), so it must say what last week was, on its own.
   */
  it("speaks in the owner's voice: last week first, in the athlete's terms, the first sentence whole on its own", () => {
    const p = buildWeeklyReviewSystemPrompt("km");
    expect(p).toContain('The review is about LAST week: call it "last week", never "this week".');
    expect(p).toContain(
      'Its first sentence says what last week was in the athlete\'s own terms — what got done and what carried the week (the long run, a quality session, a record) — and reads complete on its own: it starts with "Last week" and never points to a later sentence.',
    );
    expect(p).toContain("End with one thing to carry forward, drawn from the facts.");
    expect(p).toContain(
      'Use numbers sparingly — a count or a distance where it helps — and never a percentage or a rate, nor jargon such as "adherence", "compliance", "volume" or "load".',
    );
    expect(p).toContain("Brisk and plain: at most 120 words, no fluff, no hype, no apologies.");
    expect(p).toContain("Moving a workout is not a failure");
    // The old, clinical shape is gone.
    expect(p).not.toContain("What happened");
    expect(p).not.toContain("200 words");
    // Generic: nothing of any one athlete in it.
    expect(buildWeeklyReviewSystemPrompt("mi").replace(/miles/g, "kilometres")).toBe(p);
  });

  it("says the totals cover every kind of session the facts count — a hike's hours and distance are never running (2026-10-23)", () => {
    expect(buildWeeklyReviewSystemPrompt("km")).toContain(
      "`sessions` counts last week's sessions by kind (runs, lifts, yoga sessions, hikes); `totalHours` and `totalDistance` cover all of them, so never call them running hours or a running distance.",
    );
  });
});

describe("generateWeeklyReview", () => {
  it("sends miles — not metres — to the gateway for a Miles athlete", async () => {
    const { impl, sent } = scriptedFetch();
    const res = await generateWeeklyReview(
      db,
      makeEnv(),
      userId,
      { weekStart: "2026-08-03", facts: METRIC_FACTS, units: "mi" },
      true,
      impl,
    );
    expect(res.narrative).toBe("All good.");
    expect(systemOf(sent[0]!)).toContain("miles");
    const payload = JSON.parse(userOf(sent[0]!).split("\n").slice(1).join("\n")) as Record<
      string,
      unknown
    >;
    expect(payload.totalDistance).toBe(10.5);
    expect(payload.distanceUnit).toBe("miles");
    expect(payload).not.toHaveProperty("totalDistanceMeters");
  });

  it("a review already written stays as it was: a week whose facts are unchanged is never narrated again", async () => {
    const old = "This week you completed 2 of 5 planned workouts, for an adherence rate of 40%.";
    await db.insert(schema.weeklyReviews).values({
      id: "wr-old",
      userId,
      weekStart: "2026-08-03",
      facts: { ...METRIC_FACTS, units: "km" },
      narrative: old,
      createdAt: "2026-08-10T20:00:00.000Z",
    });
    const fresh = scriptedFetch("Last week you ran twice.");
    const res = await generateWeeklyReview(db, makeEnv(), userId, { weekStart: "2026-08-03", facts: METRIC_FACTS, units: "km" }, true, fresh.impl);
    expect(res).toEqual({ narrative: old, cached: true });
    expect(fresh.sent).toHaveLength(0);
  });

  it("stores the METRIC facts, plus the units the prose was written in", async () => {
    const { impl } = scriptedFetch();
    await generateWeeklyReview(
      db,
      makeEnv(),
      userId,
      { weekStart: "2026-08-03", facts: METRIC_FACTS, units: "mi" },
      true,
      impl,
    );
    const [row] = await db.select().from(schema.weeklyReviews);
    expect(row!.facts).toMatchObject({ totalDistanceMeters: 16_900, units: "mi" });
  });

  it("re-narrates when the unit preference changes, and caches when it does not", async () => {
    const first = scriptedFetch("Miles review.");
    await generateWeeklyReview(
      db,
      makeEnv(),
      userId,
      { weekStart: "2026-08-03", facts: METRIC_FACTS, units: "mi" },
      true,
      first.impl,
    );

    const cached = scriptedFetch("never used");
    const same = await generateWeeklyReview(
      db,
      makeEnv(),
      userId,
      { weekStart: "2026-08-03", facts: METRIC_FACTS, units: "mi" },
      true,
      cached.impl,
    );
    expect(same).toEqual({ narrative: "Miles review.", cached: true });
    expect(cached.sent).toHaveLength(0);

    const switched = scriptedFetch("Kilometre review.");
    const flipped = await generateWeeklyReview(
      db,
      makeEnv(),
      userId,
      { weekStart: "2026-08-03", facts: METRIC_FACTS, units: "km" },
      true,
      switched.impl,
    );
    expect(flipped.cached).toBe(false);
    expect(flipped.narrative).toBe("Kilometre review.");
    expect(switched.sent).toHaveLength(1);
  });
});
