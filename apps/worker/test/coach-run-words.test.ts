/**
 * The run's own lines as the athlete reads them in the run view (Stage 3 Task 9 fix round, the lead's QA):
 *  - the first step says what the coach read in the athlete's words: "Read your request and today's plan." (Q5);
 *  - a stop that proposed nothing says so with a line the view can mark as an outcome, not a step done (Q3): its
 *    payload says `proposed: false`.
 * The model is scripted (no key); synthetic data only.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { createRun, LINES, runStep, type RunDeps } from "../src/services/coach-runs.js";
import { makeTestDb, makeTestUser } from "./helpers.js";

const env = { APP_URL: "https://app.test", FIXTURE_MODE: "0", AI_DEFAULT_ENABLED: "1" } as Env;

const deps: RunDeps = {
  callModel: async () => ({ ok: false, kind: "no_key", reason: "no_key" }),
  buildContext: { statementCost: 0, build: async () => ({ system: [{ type: "text", text: "s" }], header: "h" }) },
  tools: [],
  clock: () => 0,
};

let db: Db;
let userId: string;

beforeEach(async () => {
  db = makeTestDb();
  ({ userId } = await makeTestUser(db));
});

describe("the run's lines, in the athlete's words", () => {
  it("the first step reads the request and today's plan", () => {
    expect(LINES.context).toBe("Read your request and today's plan.");
  });

  it("a stop that proposed nothing says so as an outcome (proposed: false), its first line the athlete's words", async () => {
    const now = new Date();
    const runId = (await createRun(db, userId, { scope: { kind: "now" }, request: "hips" }, now)).run.id;
    for (let i = 0; i < 3; i++) {
      const out = await runStep(db, env, runId, userId, new Date(now.getTime() + i * 1000), deps);
      if (out.kind !== "ok" || out.result.status !== "active") break;
    }
    const events = await db.select().from(schema.coachRunEvents).where(eq(schema.coachRunEvents.runId, runId)).orderBy(schema.coachRunEvents.seq);
    expect(events[0]).toMatchObject({ summary: "Read your request and today's plan." });
    const last = events.at(-1)!;
    expect(last).toMatchObject({ kind: "note", summary: LINES.nothingProposed, payload: { proposed: false } });
  });
});
