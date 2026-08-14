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

  it("passes every non-distance fact through untouched", () => {
    const out = narrationFacts(METRIC_FACTS, "mi");
    expect(out.planned).toBe(5);
    expect(out.completed).toBe(2);
    expect(out.adherencePct).toBe(40);
    expect(out.gardenSummary).toBe("A quiet week in the garden");
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
