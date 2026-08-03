/**
 * Plan Studio's two-tier LLM service (plan-studio-design §3, task-4-brief.md).
 *
 * Gateway stubbing: llm.ts — the file this module structurally mirrors — has
 * no test file anywhere in this repo to copy a stubbing pattern from (grep
 * confirms it), and no test file in the whole repo uses `vi.fn()` /
 * `vi.stubGlobal` at all. The established pattern for HTTP-calling code
 * under test here is dependency injection of a `fetch`-shaped function (see
 * `services/coros-bridge/test/mock-coros-server.ts`'s `fetchImpl`, injected
 * into `CorosClient`). studio-llm.ts follows that: both entry points take an
 * optional trailing `fetchImpl` (default: global `fetch`), and
 * `scriptedFetch` below is this file's version of that seam — a plain
 * closure returning canned `Response`s in order, recording what was sent.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { schema } from "@rg/database";
import {
  fingerprint,
  liftingPlanSchema,
  newId,
  nowInstant,
  type LiftingPlan,
  type PlanBrief,
  type StudioExercise,
} from "@rg/domain";
import type { Env } from "../src/env.js";
import { LLM_BUDGET } from "../src/services/llm.js";
import {
  applyOps,
  buildEditSystemPrompt,
  buildEditUserPrompt,
  buildGenerateSystemPrompt,
  buildGenerateUserPrompt,
  buildMajorReviseSystemPrompt,
  buildMajorReviseUserPrompt,
  editPlan,
  generatePlan,
  type CatalogEntry,
} from "../src/services/studio-llm.js";
import { makeTestDb, makeTestUser } from "./helpers.js";
import type { Db } from "../src/services/db.js";

const { llmUsage } = schema;

// ── Fixtures ─────────────────────────────────────────────────────────────

const CATALOG: CatalogEntry[] = [
  { id: "sq-1", name: "Back Squat" },
  { id: "bp-1", name: "Bench Press" },
  { id: "pu-1", name: "Pull Up" },
];

function brief(over: Partial<PlanBrief> = {}): PlanBrief {
  return {
    goal: "strength",
    durationWeeks: 2,
    sessionsPerWeek: 1,
    preferredDays: [1],
    sessionMinutes: 45,
    equipment: "full gym",
    constraints: "",
    notes: "UNIQUE_NOTES_MARKER",
    startDate: "2026-09-07",
    ...over,
  };
}

function exercise(over: Partial<StudioExercise> = {}): StudioExercise {
  return {
    originId: "sq-1",
    name: "Back Squat",
    sets: 3,
    reps: 8,
    weight: { type: "kg", value: 60 },
    restSeconds: 90,
    ...over,
  };
}

function plan(over: Partial<LiftingPlan> = {}): LiftingPlan {
  const b = (over.brief as PlanBrief | undefined) ?? brief();
  const weeks = over.weeks ?? [
    { sessions: [{ title: "Full Body", weekday: 1, exercises: [exercise()] }] },
    { sessions: [{ title: "Full Body", weekday: 1, exercises: [exercise()] }] },
  ];
  return { name: "Test Plan", ...over, brief: b, weeks } as LiftingPlan;
}

/** Everything studio-llm.ts reads off `Env`; DB/ASSETS are unused by it (it
 * takes `db` as its own parameter) and are dummy placeholders only to
 * satisfy the type — no test file in this repo has needed an `Env` before. */
function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: {} as unknown as Env["DB"],
    ASSETS: {} as unknown as Env["ASSETS"],
    APP_URL: "https://app.test",
    FIXTURE_MODE: "0",
    AI_DEFAULT_ENABLED: "1",
    SESSION_SECRET: "test-session-secret",
    TOKEN_ENCRYPTION_KEY: "test-token-encryption-key",
    ALLOWED_GOOGLE_EMAIL: "runner@example.com",
    GOOGLE_CLIENT_ID: "test-client-id",
    GOOGLE_CLIENT_SECRET: "test-client-secret",
    AI_GATEWAY_API_KEY: "test-gateway-key",
    ...overrides,
  };
}

interface ScriptedResponse {
  status?: number;
  body?: unknown;
  throws?: boolean;
}

function scriptedFetch(responses: ScriptedResponse[]): {
  fetchImpl: typeof fetch;
  calls: Array<{ url: string; body: Record<string, unknown> }>;
} {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  let i = 0;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : {};
    calls.push({ url, body });
    const spec = responses[i++];
    if (!spec) throw new Error("scriptedFetch: no more responses configured");
    if (spec.throws) throw new Error("network error");
    return new Response(JSON.stringify(spec.body ?? {}), {
      status: spec.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function chatBody(
  content: unknown,
  usage: { prompt_tokens: number; completion_tokens: number } = { prompt_tokens: 100, completion_tokens: 200 },
  finishReason: string = "stop",
): unknown {
  return {
    choices: [
      { message: { content: typeof content === "string" ? content : JSON.stringify(content) }, finish_reason: finishReason },
    ],
    usage,
  };
}

/** A response cut off mid-JSON by the token cap: unparseable, finish_reason "length". */
function truncatedChatBody(usage: { prompt_tokens: number; completion_tokens: number } = { prompt_tokens: 100, completion_tokens: 200 }): unknown {
  return chatBody('{"name": "Cut off plan", "brief": {"goal": "strength"', usage, "length");
}

const failingFetch = (async () => {
  throw new Error("fetchImpl must not be called in this test");
}) as typeof fetch;

// ─────────────────────────────────────────────────────────────────────────

describe("applyOps — pure RFC-6902 subset", () => {
  it("replaces a scalar field", () => {
    const result = applyOps(plan(), [{ op: "replace", path: "/weeks/0/sessions/0/exercises/0/reps", value: 12 }]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const p = result.plan as LiftingPlan;
      expect(p.weeks[0]!.sessions[0]!.exercises[0]!.reps).toBe(12);
    }
  });

  it("does not mutate the original plan (deep clone)", () => {
    const original = plan();
    applyOps(original, [{ op: "replace", path: "/weeks/0/sessions/0/exercises/0/reps", value: 999 }]);
    expect(original.weeks[0]!.sessions[0]!.exercises[0]!.reps).toBe(8);
  });

  it("replaces a top-level root-adjacent field (/name)", () => {
    const result = applyOps(plan(), [{ op: "replace", path: "/name", value: "Renamed" }]);
    expect(result.ok).toBe(true);
    if (result.ok) expect((result.plan as LiftingPlan).name).toBe("Renamed");
  });

  it("appends to an array with '-'", () => {
    const result = applyOps(plan(), [
      { op: "add", path: "/weeks/0/sessions/0/exercises/-", value: exercise({ originId: "bp-1", name: "Bench Press" }) },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const p = result.plan as LiftingPlan;
      expect(p.weeks[0]!.sessions[0]!.exercises).toHaveLength(2);
      expect(p.weeks[0]!.sessions[0]!.exercises[1]!.originId).toBe("bp-1");
    }
  });

  it("inserts into an array at an explicit index, shifting later elements", () => {
    const base = plan({
      weeks: [
        {
          sessions: [
            {
              title: "Full Body",
              weekday: 1,
              exercises: [exercise({ originId: "sq-1" }), exercise({ originId: "bp-1" })],
            },
          ],
        },
        { sessions: [] },
      ],
    });
    const result = applyOps(base, [
      { op: "add", path: "/weeks/0/sessions/0/exercises/1", value: exercise({ originId: "pu-1" }) },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const exercises = (result.plan as LiftingPlan).weeks[0]!.sessions[0]!.exercises;
      expect(exercises.map((e) => e.originId)).toEqual(["sq-1", "pu-1", "bp-1"]);
    }
  });

  it("removes an array element", () => {
    const base = plan({
      weeks: [
        { sessions: [{ title: "A", weekday: 1, exercises: [exercise({ originId: "sq-1" }), exercise({ originId: "bp-1" })] }] },
        { sessions: [] },
      ],
    });
    const result = applyOps(base, [{ op: "remove", path: "/weeks/0/sessions/0/exercises/0" }]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const exercises = (result.plan as LiftingPlan).weeks[0]!.sessions[0]!.exercises;
      expect(exercises.map((e) => e.originId)).toEqual(["bp-1"]);
    }
  });

  it("adds and replaces object keys, including creating a new key (caught later by strict-schema re-parse, not here)", () => {
    const result = applyOps(plan(), [
      { op: "add", path: "/weeks/0/sessions/0/exercises/0/note", value: "go slow" },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.plan as LiftingPlan).weeks[0]!.sessions[0]!.exercises[0]!.note).toBe("go slow");
    }
  });

  it("removes an object key", () => {
    const base = applyOps(plan(), [{ op: "add", path: "/weeks/0/sessions/0/exercises/0/note", value: "x" }]);
    expect(base.ok).toBe(true);
    if (!base.ok) return;
    const result = applyOps(base.plan as LiftingPlan, [{ op: "remove", path: "/weeks/0/sessions/0/exercises/0/note" }]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.plan as LiftingPlan).weeks[0]!.sessions[0]!.exercises[0]!.note).toBeUndefined();
    }
  });

  it("applies multiple ops in sequence", () => {
    const result = applyOps(plan(), [
      { op: "replace", path: "/weeks/0/sessions/0/exercises/0/reps", value: 5 },
      { op: "replace", path: "/weeks/1/sessions/0/exercises/0/reps", value: 6 },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const p = result.plan as LiftingPlan;
      expect(p.weeks[0]!.sessions[0]!.exercises[0]!.reps).toBe(5);
      expect(p.weeks[1]!.sessions[0]!.exercises[0]!.reps).toBe(6);
    }
  });

  it("integration: a valid patch still passes the full liftingPlanSchema re-parse", () => {
    const result = applyOps(plan(), [{ op: "replace", path: "/weeks/0/sessions/0/exercises/0/reps", value: 12 }]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(liftingPlanSchema.safeParse(result.plan).success).toBe(true);
  });

  it("integration: applyOps has no schema awareness — breaking weeks.length vs durationWeeks passes applyOps but fails the re-parse", () => {
    const result = applyOps(plan(), [{ op: "remove", path: "/weeks/1" }]);
    expect(result.ok).toBe(true); // applyOps itself has no opinion on this
    if (result.ok) expect(liftingPlanSchema.safeParse(result.plan).success).toBe(false); // the re-parse catches it
  });

  describe("rejections", () => {
    it("rejects an empty ops array", () => {
      expect(applyOps(plan(), [])).toEqual({ ok: false, error: expect.any(String) });
    });

    it("rejects a non-array ops payload", () => {
      expect(applyOps(plan(), { op: "replace" }).ok).toBe(false);
    });

    it("rejects an unknown op", () => {
      const result = applyOps(plan(), [{ op: "update", path: "/name", value: "x" }]);
      expect(result.ok).toBe(false);
    });

    it("rejects add/replace missing a value", () => {
      expect(applyOps(plan(), [{ op: "replace", path: "/name" }]).ok).toBe(false);
      expect(applyOps(plan(), [{ op: "add", path: "/weeks/0/sessions/0/exercises/-" }]).ok).toBe(false);
    });

    it("rejects a path that doesn't start with '/'", () => {
      expect(applyOps(plan(), [{ op: "replace", path: "name", value: "x" }]).ok).toBe(false);
    });

    it("rejects the empty-string (root) path", () => {
      expect(applyOps(plan(), [{ op: "replace", path: "", value: {} }]).ok).toBe(false);
    });

    it("rejects an out-of-bounds replace/remove index", () => {
      expect(applyOps(plan(), [{ op: "replace", path: "/weeks/0/sessions/0/exercises/9", value: exercise() }]).ok).toBe(false);
      expect(applyOps(plan(), [{ op: "remove", path: "/weeks/0/sessions/0/exercises/9" }]).ok).toBe(false);
      expect(applyOps(plan(), [{ op: "remove", path: "/weeks/0/sessions/0/exercises/-1" }]).ok).toBe(false);
    });

    it("rejects an out-of-bounds add index (more than one past the end)", () => {
      expect(applyOps(plan(), [{ op: "add", path: "/weeks/0/sessions/0/exercises/5", value: exercise() }]).ok).toBe(false);
    });

    it("rejects a non-numeric, non-'-' array index", () => {
      expect(applyOps(plan(), [{ op: "replace", path: "/weeks/0/sessions/0/exercises/foo", value: exercise() }]).ok).toBe(false);
    });

    it("rejects replace/remove on a nonexistent object key", () => {
      expect(applyOps(plan(), [{ op: "replace", path: "/weeks/0/sessions/0/exercises/0/nope", value: 1 }]).ok).toBe(false);
      expect(applyOps(plan(), [{ op: "remove", path: "/weeks/0/sessions/0/exercises/0/nope" }]).ok).toBe(false);
    });

    it("rejects navigating through a scalar (e.g. /name/x — name is a string, not a container)", () => {
      expect(applyOps(plan(), [{ op: "replace", path: "/name/x", value: 1 }]).ok).toBe(false);
    });

    // Malicious paths explicitly called out by the task brief.
    it("rejects '/__proto__/x' (prototype pollution)", () => {
      const result = applyOps(plan(), [{ op: "add", path: "/__proto__/x", value: "polluted" }]);
      expect(result.ok).toBe(false);
      // Confirm nothing leaked onto the real Object prototype either way.
      expect(({} as Record<string, unknown>).x).toBeUndefined();
    });

    it("rejects '/weeks/0/__proto__/polluted' (constructor pollution mid-path)", () => {
      expect(applyOps(plan(), [{ op: "add", path: "/weeks/0/__proto__/polluted", value: 1 }]).ok).toBe(false);
    });

    it("rejects '/constructor/prototype/polluted'", () => {
      expect(applyOps(plan(), [{ op: "add", path: "/constructor/prototype/polluted", value: 1 }]).ok).toBe(false);
    });

    it("rejects '/brief/../..' (no such literal '..' key — naturally rejected, not special-cased)", () => {
      const result = applyOps(plan(), [{ op: "replace", path: "/brief/../..", value: "x" }]);
      expect(result.ok).toBe(false);
    });

    // Review round 1: /brief must be immutable in CODE, not just asked for in
    // the prompt — `request` is user-controlled free text reaching the model,
    // so a prompt-injected edit request rewriting e.g. brief.constraints
    // (safety-relevant) previously passed both applyOps (no shape violation)
    // and the schema (brief fields don't participate in the weeks refine).
    it("rejects a direct /brief/* replace", () => {
      const result = applyOps(plan(), [{ op: "replace", path: "/brief/equipment", value: "nothing at all" }]);
      expect(result.ok).toBe(false);
    });

    it("rejects a direct /brief/* add", () => {
      const result = applyOps(plan(), [{ op: "add", path: "/brief/notes", value: "injected" }]);
      expect(result.ok).toBe(false);
    });

    it("rejects a direct /brief/* remove", () => {
      const result = applyOps(plan(), [{ op: "remove", path: "/brief/constraints" }]);
      expect(result.ok).toBe(false);
    });

    it("rejects replacing /brief wholesale", () => {
      const result = applyOps(plan(), [{ op: "replace", path: "/brief", value: {} }]);
      expect(result.ok).toBe(false);
    });

    it("still allows /name — only /brief is immutable", () => {
      const result = applyOps(plan(), [{ op: "replace", path: "/name", value: "Renamed" }]);
      expect(result.ok).toBe(true);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────

describe("prompt builders — determinism and stable/volatile separation", () => {
  it("buildGenerateSystemPrompt is a pure function of the catalog (same input -> identical output)", () => {
    expect(buildGenerateSystemPrompt(CATALOG)).toBe(buildGenerateSystemPrompt(CATALOG));
  });

  it("buildGenerateSystemPrompt embeds every catalog id|name pair and nothing brief-specific", () => {
    const system = buildGenerateSystemPrompt(CATALOG);
    for (const c of CATALOG) expect(system).toContain(`${c.id}|${c.name}`);
    expect(system).not.toContain("UNIQUE_NOTES_MARKER");
  });

  it("buildGenerateUserPrompt carries the volatile brief content the system prompt omits", () => {
    const user = buildGenerateUserPrompt(brief());
    expect(user).toContain("UNIQUE_NOTES_MARKER");
  });

  it("buildEditSystemPrompt/buildMajorReviseSystemPrompt are deterministic and catalog-only too", () => {
    expect(buildEditSystemPrompt(CATALOG)).toBe(buildEditSystemPrompt(CATALOG));
    expect(buildMajorReviseSystemPrompt(CATALOG)).toBe(buildMajorReviseSystemPrompt(CATALOG));
    expect(buildEditSystemPrompt(CATALOG)).not.toContain("UNIQUE_NOTES_MARKER");
  });

  it("buildEditUserPrompt/buildMajorReviseUserPrompt carry the plan + volatile request text", () => {
    const p = plan();
    expect(buildEditUserPrompt(p, "make it harder")).toContain("make it harder");
    expect(buildEditUserPrompt(p, "make it harder")).toContain(p.name);
    expect(buildMajorReviseUserPrompt(p, "add a fourth day")).toContain("add a fourth day");
  });
});

// ─────────────────────────────────────────────────────────────────────────

let db: Db;
let userId: string;

beforeEach(async () => {
  db = makeTestDb();
  ({ userId } = await makeTestUser(db));
});

describe("generatePlan — fixture mode", () => {
  it("returns a deterministic 2-week 3-day plan from the given catalog, with no gateway call and no usage row", async () => {
    const env = makeEnv({ FIXTURE_MODE: "1" });
    const first = await generatePlan(env, db, userId, brief(), CATALOG, failingFetch);
    const second = await generatePlan(env, db, userId, brief(), CATALOG, failingFetch);
    expect(first.plan).not.toBeNull();
    expect(first.plan).toEqual(second.plan); // deterministic
    expect(first.plan!.weeks).toHaveLength(2);
    expect(first.plan!.weeks[0]!.sessions).toHaveLength(3);
    for (const week of first.plan!.weeks) {
      for (const session of week.sessions) {
        for (const ex of session.exercises) {
          expect(CATALOG.some((c) => c.id === ex.originId)).toBe(true);
        }
      }
    }
    // Review round 1 (Minor): the claim that the canned plan is valid existed
    // without the assertion to back it — assert it directly, not just its shape.
    expect(liftingPlanSchema.safeParse(first.plan).success).toBe(true);
    expect(await db.select().from(llmUsage)).toHaveLength(0);
  });

  it("returns {plan:null, reason:'no_catalog'} on an empty catalog", async () => {
    const env = makeEnv({ FIXTURE_MODE: "1" });
    const result = await generatePlan(env, db, userId, brief(), [], failingFetch);
    expect(result).toEqual({ plan: null, reason: "no_catalog" });
  });
});

describe("editPlan — fixture mode", () => {
  it("returns the plan renamed '(edited)' regardless of request/major, with no gateway call and no usage row", async () => {
    const env = makeEnv({ FIXTURE_MODE: "1" });
    const base = plan({ name: "Autumn Strength" });
    const result = await editPlan(env, db, userId, base, "add more volume", true, CATALOG, failingFetch);
    expect(result.plan).toEqual({ ...base, name: "Autumn Strength (edited)" });
    // Review round 1 (Minor): assert the canned edit output actually validates.
    expect(liftingPlanSchema.safeParse(result.plan).success).toBe(true);
    expect(await db.select().from(llmUsage)).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────

describe("generatePlan — budget gate (checked before any gateway call)", () => {
  it("refuses with no_api_key when the gateway key is unset", async () => {
    const env = makeEnv({ AI_GATEWAY_API_KEY: undefined });
    const result = await generatePlan(env, db, userId, brief(), CATALOG, failingFetch);
    expect(result).toEqual({ plan: null, reason: "no_api_key" });
  });

  it("refuses with budget_cutoff once the rolling 7-day spend hits the same threshold llm.ts uses", async () => {
    await db.insert(llmUsage).values({
      id: newId(),
      userId,
      kind: "weekly_review",
      model: "anthropic/claude-haiku-4.5",
      inputTokens: 0,
      outputTokens: 0,
      costMicros: LLM_BUDGET.cutoffMicros,
      cacheHit: false,
      requestFingerprint: null,
      createdAt: nowInstant(),
    });
    const env = makeEnv();
    const result = await generatePlan(env, db, userId, brief(), CATALOG, failingFetch);
    expect(result).toEqual({ plan: null, reason: "budget_cutoff" });
  });

  it("never touches the gateway when refused for budget or missing key", async () => {
    const env = makeEnv({ AI_GATEWAY_API_KEY: undefined });
    // failingFetch throws if called at all; a clean {plan:null} return proves it wasn't.
    await expect(generatePlan(env, db, userId, brief(), CATALOG, failingFetch)).resolves.toEqual({
      plan: null,
      reason: "no_api_key",
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────

const VALID_GENERATED_PLAN = {
  name: "Model Plan",
  brief: brief(),
  weeks: [
    { sessions: [{ title: "Day 1", weekday: 1, exercises: [exercise({ originId: "sq-1", name: "Back Squat" })] }] },
    { sessions: [{ title: "Day 1", weekday: 1, exercises: [exercise({ originId: "bp-1", name: "Bench Press" })] }] },
  ],
};

describe("generatePlan — success, prompts, and usage rows", () => {
  it("returns the validated plan and records a studio_generate usage row shaped like llm.ts's rows", async () => {
    const env = makeEnv();
    const { fetchImpl } = scriptedFetch([{ body: chatBody(VALID_GENERATED_PLAN) }]);
    const result = await generatePlan(env, db, userId, brief(), CATALOG, fetchImpl);

    expect(result.plan).toEqual(VALID_GENERATED_PLAN);
    const rows = await db.select().from(llmUsage);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      userId,
      kind: "studio_generate",
      model: "anthropic/claude-opus-5",
      inputTokens: 100,
      outputTokens: 200,
      costMicros: 100 * 5 + 200 * 25, // strong-tier: $5/$25 per 1M input/output tokens
      cacheHit: false,
    });
    expect(rows[0]!.requestFingerprint).toBe(fingerprint({ brief: brief(), catalogSize: CATALOG.length }));
  });

  it("sends stable-prefix-first messages: system first (catalog, no brief content), user last (the brief)", async () => {
    const env = makeEnv();
    const { fetchImpl, calls } = scriptedFetch([{ body: chatBody(VALID_GENERATED_PLAN) }]);
    await generatePlan(env, db, userId, brief(), CATALOG, fetchImpl);

    const messages = calls[0]!.body.messages as Array<{ role: string; content: string }>;
    expect(messages).toHaveLength(2);
    expect(messages[0]!.role).toBe("system");
    expect(messages[0]!.content).toContain("sq-1|Back Squat");
    expect(messages[0]!.content).not.toContain("UNIQUE_NOTES_MARKER");
    expect(messages[1]!.role).toBe("user");
    expect(messages[1]!.content).toContain("UNIQUE_NOTES_MARKER");
  });

  it("uses AI_STUDIO_MODEL_STRONG when set, both on the wire and in the usage row", async () => {
    const env = makeEnv({ AI_STUDIO_MODEL_STRONG: "anthropic/claude-opus-5-custom" });
    const { fetchImpl, calls } = scriptedFetch([{ body: chatBody(VALID_GENERATED_PLAN) }]);
    await generatePlan(env, db, userId, brief(), CATALOG, fetchImpl);

    expect(calls[0]!.body.model).toBe("anthropic/claude-opus-5-custom");
    const rows = await db.select().from(llmUsage);
    expect(rows[0]!.model).toBe("anthropic/claude-opus-5-custom");
  });

  it("retries exactly once on invalid JSON, succeeding on the corrected second attempt", async () => {
    const env = makeEnv();
    const { fetchImpl, calls } = scriptedFetch([
      { body: chatBody("not json at all") },
      { body: chatBody(VALID_GENERATED_PLAN) },
    ]);
    const result = await generatePlan(env, db, userId, brief(), CATALOG, fetchImpl);

    expect(result.plan).toEqual(VALID_GENERATED_PLAN);
    expect(calls).toHaveLength(2);
    expect(await db.select().from(llmUsage)).toHaveLength(2); // both attempts cost tokens

    const retryMessages = calls[1]!.body.messages as Array<{ role: string; content: string }>;
    expect(retryMessages).toHaveLength(4); // system, user, assistant(bad), user(feedback)
    expect(retryMessages[2]!.role).toBe("assistant");
    expect(retryMessages[3]!.role).toBe("user");
  });

  it("retries once on a schema-invalid plan (missing weeks), then fails honestly if still invalid", async () => {
    const env = makeEnv();
    const broken = { name: "Broken" }; // no brief, no weeks
    const { fetchImpl, calls } = scriptedFetch([{ body: chatBody(broken) }, { body: chatBody(broken) }]);
    const result = await generatePlan(env, db, userId, brief(), CATALOG, fetchImpl);

    expect(result).toEqual({ plan: null, reason: "invalid_output" });
    expect(calls).toHaveLength(2); // exactly one retry, no more
  });

  it("retries once on an unknown originId, then fails with reason unknown_exercise", async () => {
    const env = makeEnv();
    const badPlan = {
      ...VALID_GENERATED_PLAN,
      weeks: [
        { sessions: [{ title: "Day 1", weekday: 1, exercises: [exercise({ originId: "not-in-catalog" })] }] },
        { sessions: [{ title: "Day 1", weekday: 1, exercises: [exercise({ originId: "not-in-catalog" })] }] },
      ],
    };
    const { fetchImpl, calls } = scriptedFetch([{ body: chatBody(badPlan) }, { body: chatBody(badPlan) }]);
    const result = await generatePlan(env, db, userId, brief(), CATALOG, fetchImpl);

    expect(result).toEqual({ plan: null, reason: "unknown_exercise" });
    expect(calls).toHaveLength(2);
  });

  it("retries a transient gateway 5xx once, then fails with the status — no usage row", async () => {
    const env = makeEnv();
    const { fetchImpl, calls } = scriptedFetch([
      { status: 500, body: { error: "boom" } },
      { status: 500, body: { error: "boom" } },
    ]);
    const result = await generatePlan(env, db, userId, brief(), CATALOG, fetchImpl);

    expect(result).toEqual({ plan: null, reason: "gateway_500" });
    expect(calls).toHaveLength(2); // the in-place transient retry, not the feedback retry
    expect(await db.select().from(llmUsage)).toHaveLength(0);
  });

  it("recovers when a transient gateway 5xx is followed by a good response", async () => {
    const env = makeEnv();
    const { fetchImpl, calls } = scriptedFetch([
      { status: 503, body: { error: "overloaded" } },
      { body: chatBody(VALID_GENERATED_PLAN) },
    ]);
    const result = await generatePlan(env, db, userId, brief(), CATALOG, fetchImpl);

    expect(result.plan).not.toBeNull();
    expect(calls).toHaveLength(2);
  });

  it("does not retry a deterministic gateway 4xx — fails immediately", async () => {
    const env = makeEnv();
    const { fetchImpl, calls } = scriptedFetch([{ status: 400, body: { error: "bad request" } }]);
    const result = await generatePlan(env, db, userId, brief(), CATALOG, fetchImpl);

    expect(result).toEqual({ plan: null, reason: "gateway_400" });
    expect(calls).toHaveLength(1);
  });

  it("sends a flat, over-provisioned max_tokens so no plan can ever truncate", async () => {
    // The response body's own validity doesn't matter here — only what was
    // SENT on the first request is under test (the retry-on-invalid path is
    // covered elsewhere), so both calls reuse the same canned response.
    const env = makeEnv();
    const small = scriptedFetch([{ body: chatBody(VALID_GENERATED_PLAN) }]);
    await generatePlan(env, db, userId, brief({ durationWeeks: 2, sessionsPerWeek: 1 }), CATALOG, small.fetchImpl);
    const smallMaxTokens = small.calls[0]!.body.max_tokens as number;

    const bigBrief = brief({ durationWeeks: 16, sessionsPerWeek: 6, preferredDays: [1, 2, 3, 4, 5, 6] });
    const big = scriptedFetch([{ body: chatBody(VALID_GENERATED_PLAN) }]);
    await generatePlan(env, db, userId, bigBrief, CATALOG, big.fetchImpl);
    const bigMaxTokens = big.calls[0]!.body.max_tokens as number;

    // Never-truncate rule: the cap doesn't scale with brief size (max_tokens
    // also covers adaptive thinking on Opus-5-class models, so a "right
    // sized" cap was live-verified to cut off real plans).
    expect(smallMaxTokens).toBe(bigMaxTokens);
    expect(bigMaxTokens).toBeGreaterThanOrEqual(64000);
  });

  it("reports output_truncated (not invalid_output) when the response was cut off by the token cap", async () => {
    const env = makeEnv();
    const { fetchImpl, calls } = scriptedFetch([{ body: truncatedChatBody() }, { body: truncatedChatBody() }]);
    const result = await generatePlan(env, db, userId, brief(), CATALOG, fetchImpl);

    expect(result).toEqual({ plan: null, reason: "output_truncated" });
    expect(calls).toHaveLength(2); // still gets exactly one retry, like any validation failure
  });

  it("does NOT report output_truncated for ordinary invalid JSON with a normal finish_reason", async () => {
    const env = makeEnv();
    const { fetchImpl } = scriptedFetch([{ body: chatBody("not json at all") }, { body: chatBody("still not json") }]);
    const result = await generatePlan(env, db, userId, brief(), CATALOG, fetchImpl);

    expect(result).toEqual({ plan: null, reason: "invalid_output" });
  });

  it("never throws on a network error — retries once, then returns llm_error", async () => {
    const env = makeEnv();
    const { fetchImpl, calls } = scriptedFetch([{ throws: true }, { throws: true }]);
    const result = await generatePlan(env, db, userId, brief(), CATALOG, fetchImpl);

    expect(result).toEqual({ plan: null, reason: "llm_error" });
    expect(calls).toHaveLength(2); // one in-place transient retry, then honest failure
  });

  it("recovers when a dropped connection is followed by a good response", async () => {
    const env = makeEnv();
    const { fetchImpl, calls } = scriptedFetch([{ throws: true }, { body: chatBody(VALID_GENERATED_PLAN) }]);
    const result = await generatePlan(env, db, userId, brief(), CATALOG, fetchImpl);

    expect(result.plan).not.toBeNull();
    expect(calls).toHaveLength(2);
  });

  it("assembles a plan from an SSE stream (the wire format the gateway actually sends)", async () => {
    const env = makeEnv();
    const json = JSON.stringify(VALID_GENERATED_PLAN);
    // Split the plan JSON across several delta chunks, then finish with
    // usage — the shape of an OpenAI-compatible streaming response.
    const mid = Math.floor(json.length / 2);
    const sse =
      `data: ${JSON.stringify({ choices: [{ delta: { content: json.slice(0, mid) } }] })}\n\n` +
      `data: ${JSON.stringify({ choices: [{ delta: { content: json.slice(mid) } }] })}\n\n` +
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 500, completion_tokens: 900 } })}\n\n` +
      "data: [DONE]\n\n";
    const calls: Array<{ body: Record<string, unknown> }> = [];
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ body: JSON.parse(init?.body as string) as Record<string, unknown> });
      return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;

    const result = await generatePlan(env, db, userId, brief(), CATALOG, fetchImpl);

    expect(result.plan).not.toBeNull();
    expect(calls[0]!.body.stream).toBe(true);
    const rows = await db.select().from(llmUsage);
    expect(rows[0]).toMatchObject({ inputTokens: 500, outputTokens: 900 });
  });

  it("reports output_truncated when an SSE stream ends with finish_reason length", async () => {
    const env = makeEnv();
    const sse =
      `data: ${JSON.stringify({ choices: [{ delta: { content: '{"name": "cut off' } }] })}\n\n` +
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "length" }] })}\n\n` +
      "data: [DONE]\n\n";
    const fetchImpl = (async () =>
      new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })) as typeof fetch;

    const result = await generatePlan(env, db, userId, brief(), CATALOG, fetchImpl);

    expect(result).toEqual({ plan: null, reason: "output_truncated" });
  });
});

// ─────────────────────────────────────────────────────────────────────────

describe("editPlan — minor edit (cheap tier, ops)", () => {
  it("applies the model's ops server-side and records a studio_edit usage row on the cheap model", async () => {
    const env = makeEnv();
    const base = plan();
    const { fetchImpl } = scriptedFetch([
      { body: chatBody({ ops: [{ op: "replace", path: "/weeks/0/sessions/0/exercises/0/reps", value: 12 }] }) },
    ]);
    const result = await editPlan(env, db, userId, base, "make week 1 heavier on reps", false, CATALOG, fetchImpl);

    expect(result.plan?.weeks[0]!.sessions[0]!.exercises[0]!.reps).toBe(12);
    // Everything else carried over untouched.
    expect(result.plan?.weeks[1]!.sessions[0]!.exercises[0]!.reps).toBe(8);

    const rows = await db.select().from(llmUsage);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "studio_edit",
      model: "anthropic/claude-haiku-4.5",
      costMicros: 100 * 1 + 200 * 5, // edit-tier: $1/$5 per 1M input/output tokens
    });
  });

  it("sends stable-prefix-first messages with the plan + request as the volatile user turn", async () => {
    const env = makeEnv();
    const { fetchImpl, calls } = scriptedFetch([
      { body: chatBody({ ops: [{ op: "replace", path: "/name", value: "Renamed" }] }) },
    ]);
    await editPlan(env, db, userId, plan(), "rename it", false, CATALOG, fetchImpl);

    const messages = calls[0]!.body.messages as Array<{ role: string; content: string }>;
    expect(messages[0]!.role).toBe("system");
    expect(messages[0]!.content).not.toContain("rename it");
    expect(messages[1]!.role).toBe("user");
    expect(messages[1]!.content).toContain("rename it");
  });

  it("retries once when the ops themselves are malformed (applyOps rejects), then succeeds", async () => {
    const env = makeEnv();
    const { fetchImpl, calls } = scriptedFetch([
      { body: chatBody({ ops: [{ op: "replace", path: "/weeks/0/sessions/0/exercises/99/reps", value: 1 }] }) },
      { body: chatBody({ ops: [{ op: "replace", path: "/weeks/0/sessions/0/exercises/0/reps", value: 1 }] }) },
    ]);
    const result = await editPlan(env, db, userId, plan(), "reduce reps", false, CATALOG, fetchImpl);

    expect(result.plan?.weeks[0]!.sessions[0]!.exercises[0]!.reps).toBe(1);
    expect(calls).toHaveLength(2);
  });

  it("fails honestly (invalid_ops) when the ops are malformed on both attempts", async () => {
    const env = makeEnv();
    const { fetchImpl, calls } = scriptedFetch([
      { body: chatBody({ ops: [{ op: "bogus", path: "/name" }] }) },
      { body: chatBody({ ops: [{ op: "bogus", path: "/name" }] }) },
    ]);
    const result = await editPlan(env, db, userId, plan(), "reduce reps", false, CATALOG, fetchImpl);

    expect(result).toEqual({ plan: null, reason: "invalid_ops" });
    expect(calls).toHaveLength(2);
  });

  it("rejects an edit that introduces an originId outside the catalog, after one retry", async () => {
    const env = makeEnv();
    const opsAddingBadExercise = {
      ops: [{ op: "replace", path: "/weeks/0/sessions/0/exercises/0/originId", value: "not-in-catalog" }],
    };
    const { fetchImpl, calls } = scriptedFetch([{ body: chatBody(opsAddingBadExercise) }, { body: chatBody(opsAddingBadExercise) }]);
    const result = await editPlan(env, db, userId, plan(), "swap the exercise", false, CATALOG, fetchImpl);

    expect(result).toEqual({ plan: null, reason: "unknown_exercise" });
    expect(calls).toHaveLength(2);
  });

  it("fails invalid_output when applied ops break full-schema validation (e.g. weeks.length no longer matches durationWeeks)", async () => {
    const env = makeEnv();
    const { fetchImpl, calls } = scriptedFetch([
      { body: chatBody({ ops: [{ op: "remove", path: "/weeks/1" }] }) },
      { body: chatBody({ ops: [{ op: "remove", path: "/weeks/1" }] }) },
    ]);
    const result = await editPlan(env, db, userId, plan(), "delete week 2", false, CATALOG, fetchImpl);

    expect(result).toEqual({ plan: null, reason: "invalid_output" });
    expect(calls).toHaveLength(2);
  });

  it("reports output_truncated (not invalid_output) when the ops response was cut off by the token cap", async () => {
    const env = makeEnv();
    const { fetchImpl, calls } = scriptedFetch([{ body: truncatedChatBody() }, { body: truncatedChatBody() }]);
    const result = await editPlan(env, db, userId, plan(), "reduce reps", false, CATALOG, fetchImpl);

    expect(result).toEqual({ plan: null, reason: "output_truncated" });
    expect(calls).toHaveLength(2);
  });
});

describe("editPlan — major revision (strong tier, full regenerate)", () => {
  it("uses the strong model and validates a full replacement plan, kind studio_edit", async () => {
    const env = makeEnv();
    const revised = { ...VALID_GENERATED_PLAN, name: "Revised Plan" };
    const { fetchImpl, calls } = scriptedFetch([{ body: chatBody(revised) }]);
    const result = await editPlan(env, db, userId, plan(), "add a fourth week", true, CATALOG, fetchImpl);

    expect(result.plan).toEqual(revised);
    expect(calls[0]!.body.model).toBe("anthropic/claude-opus-5");
    const rows = await db.select().from(llmUsage);
    expect(rows[0]).toMatchObject({ kind: "studio_edit", model: "anthropic/claude-opus-5" });
  });

  it("uses the same flat never-truncate max_tokens for a major edit as generatePlan", async () => {
    const env = makeEnv();
    const smallPlan = plan({ brief: brief({ durationWeeks: 2, sessionsPerWeek: 1 }), weeks: [{ sessions: [] }, { sessions: [] }] });
    const small = scriptedFetch([{ body: chatBody(VALID_GENERATED_PLAN) }]);
    await editPlan(env, db, userId, smallPlan, "revise", true, CATALOG, small.fetchImpl);

    const bigBrief = brief({ durationWeeks: 16, sessionsPerWeek: 6, preferredDays: [1, 2, 3, 4, 5, 6] });
    const bigPlan = plan({ brief: bigBrief, weeks: Array.from({ length: 16 }, () => ({ sessions: [] })) });
    const big = scriptedFetch([{ body: chatBody(VALID_GENERATED_PLAN) }]);
    await editPlan(env, db, userId, bigPlan, "revise", true, CATALOG, big.fetchImpl);

    expect(small.calls[0]!.body.max_tokens).toBe(big.calls[0]!.body.max_tokens);
    expect(big.calls[0]!.body.max_tokens).toBeGreaterThanOrEqual(64000);
  });

  it("uses AI_STUDIO_MODEL_EDIT for the cheap tier and AI_STUDIO_MODEL_STRONG for major, independently", async () => {
    const env = makeEnv({ AI_STUDIO_MODEL_EDIT: "cheap-custom", AI_STUDIO_MODEL_STRONG: "strong-custom" });
    const minor = scriptedFetch([{ body: chatBody({ ops: [{ op: "replace", path: "/name", value: "x" }] }) }]);
    await editPlan(env, db, userId, plan(), "rename", false, CATALOG, minor.fetchImpl);
    expect(minor.calls[0]!.body.model).toBe("cheap-custom");

    const major = scriptedFetch([{ body: chatBody(VALID_GENERATED_PLAN) }]);
    await editPlan(env, db, userId, plan(), "regenerate", true, CATALOG, major.fetchImpl);
    expect(major.calls[0]!.body.model).toBe("strong-custom");
  });
});

describe("editPlan — budget gate and never-throws", () => {
  it("refuses with no_api_key before touching the gateway", async () => {
    const env = makeEnv({ AI_GATEWAY_API_KEY: undefined });
    const result = await editPlan(env, db, userId, plan(), "anything", false, CATALOG, failingFetch);
    expect(result).toEqual({ plan: null, reason: "no_api_key" });
  });

  it("refuses with budget_cutoff before touching the gateway", async () => {
    await db.insert(llmUsage).values({
      id: newId(),
      userId,
      kind: "weekly_review",
      model: "anthropic/claude-haiku-4.5",
      inputTokens: 0,
      outputTokens: 0,
      costMicros: LLM_BUDGET.cutoffMicros,
      cacheHit: false,
      requestFingerprint: null,
      createdAt: nowInstant(),
    });
    const env = makeEnv();
    const result = await editPlan(env, db, userId, plan(), "anything", false, CATALOG, failingFetch);
    expect(result).toEqual({ plan: null, reason: "budget_cutoff" });
  });

  it("never throws on a network error", async () => {
    const env = makeEnv();
    const { fetchImpl } = scriptedFetch([{ throws: true }]);
    await expect(editPlan(env, db, userId, plan(), "anything", false, CATALOG, fetchImpl)).resolves.toEqual({
      plan: null,
      reason: "llm_error",
    });
  });
});
