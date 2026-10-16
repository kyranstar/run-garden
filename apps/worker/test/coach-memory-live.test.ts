/**
 * THE THREAD COACH READS ONLY LIVE MEMORY (Stage 3 fix wave 3A, A1; memory v2, memory-core.ts `liveMemoryWhere`).
 *
 * A rehearsal run's memory (`provenance.rehearsal`) is never the athlete's, and an item `remember(replaces)` superseded
 * is no longer what the coach knows. The designer's readers already hold to that; these are the thread coach's: the
 * dossier, the effort package, the wake's guardrails (its anchor-day rules and dated events), `/state`'s count and
 * `GET /memory`. Each reads the same statements as before.
 *
 * Synthetic data only.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { schema } from "@rg/database";
import { newId, nowInstant, todayInZone, type UserPreferences } from "@rg/domain";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { coachRoutes } from "../src/routes/coach.js";
import { buildDossier } from "../src/services/coach-context.js";
import { buildEffortPackage } from "../src/services/coach-effort.js";
import { guardrailCtx } from "../src/services/coach-wake.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";

const env = {
  DB: {} as unknown as Env["DB"],
  ASSETS: {} as unknown as Env["ASSETS"],
  APP_URL: "https://app.test",
  FIXTURE_MODE: "0",
  AI_DEFAULT_ENABLED: "1",
  SESSION_SECRET: "s",
  TOKEN_ENCRYPTION_KEY: "k",
  ALLOWED_GOOGLE_EMAIL: "runner@example.com",
  GOOGLE_CLIENT_ID: "c",
  GOOGLE_CLIENT_SECRET: "c",
  AI_GATEWAY_API_KEY: "test-key",
} as Env;

let db: Db;
let userId: string;
let prefs: UserPreferences;
let cookie: string;
let statements = 0;

beforeEach(async () => {
  db = makeTestDb({ onStatement: () => (statements += 1) });
  ({ userId, prefs } = await makeTestUser(db));
  cookie = `${SESSION_COOKIE}=${await createSession(db, userId)}`;
  const at = nowInstant();
  const row = (id: string, kind: string, body: string, o: { rehearsal?: boolean; supersededBy?: string } = {}) => ({
    id,
    userId,
    kind,
    body,
    provenance: { source: "message", at, ...(o.rehearsal ? { rehearsal: true } : {}) },
    learnedAt: at,
    active: true,
    ...(o.supersededBy ? { supersededBy: o.supersededBy } : {}),
  });
  await db.insert(schema.coachMemory).values([
    row("live-rule", "rule", "Long runs on Sunday"),
    row("live-note", "note", "Ski trip 2031-02-26"),
    row("rehearsal-rule", "rule", "Quality sessions on Tuesday", { rehearsal: true }),
    row("rehearsal-note", "note", "Rehearsal trip 2031-02-20", { rehearsal: true }),
    row("superseded-rule", "rule", "Strength on Thursday", { supersededBy: "live-rule" }),
    row("superseded-note", "note", "Old trip 2031-02-21", { supersededBy: "live-note" }),
  ]);
  statements = 0;
});

const LIVE = ["Long runs on Sunday", "Ski trip 2031-02-26"];
const GONE = ["Quality sessions on Tuesday", "Rehearsal trip 2031-02-20", "Strength on Thursday", "Old trip 2031-02-21"];

/** Statements one call runs. */
async function counted<T>(f: () => Promise<T>): Promise<{ value: T; statements: number }> {
  statements = 0;
  const value = await f();
  return { value, statements };
}

describe("a rehearsal's memory and a superseded item never reach the thread coach", () => {
  it("the dossier lists only live items", async () => {
    const today = todayInZone(prefs.timezone);
    const { value: dossier, statements: n } = await counted(() => buildDossier(db, userId, prefs, today));
    for (const body of LIVE) expect(dossier.text).toContain(body);
    for (const body of GONE) expect(dossier.text).not.toContain(body);
    expect(n).toBe(DOSSIER_STATEMENTS);
  });

  it("the effort package's memory section lists only live items", async () => {
    const activityId = newId();
    await db.insert(schema.activities).values({
      id: activityId,
      userId,
      startTime: "2026-08-06T12:08:02Z",
      startTimeLocal: "2026-08-06T05:08:02",
      sport: "run",
      durationSeconds: 1800,
      elapsedSeconds: 1800,
      distanceMeters: 5000,
      title: "Easy run",
      sourceMergeConfidence: 1,
      createdAt: nowInstant(),
      updatedAt: nowInstant(),
    });
    const { value: pkg, statements: n } = await counted(() => buildEffortPackage(db, userId, activityId));
    for (const body of LIVE) expect(pkg!.text).toContain(body);
    for (const body of GONE) expect(pkg!.text).not.toContain(body);
    expect(n).toBe(EFFORT_STATEMENTS);
  });

  it("the wake's guardrails take anchor days and dated events from live items only", async () => {
    const today = todayInZone(prefs.timezone);
    const { value: ctx, statements: n } = await counted(() => guardrailCtx(db, userId, prefs, today));
    expect(ctx.rules.map((r) => r.id)).toEqual(["live-rule"]);
    expect(ctx.datedEvents.map((e) => e.id)).toEqual(["live-note"]);
    expect(n).toBe(GUARDRAIL_STATEMENTS);
  });

  it("/state counts only live items, and GET /memory lists only them", async () => {
    const app = mountRoutes(db, "/api/coach", coachRoutes);
    const { value: state, statements: s } = await counted(async () => app.request("/api/coach/state", { headers: { Cookie: cookie } }, env));
    expect(((await state.json()) as { memoryCount: number }).memoryCount).toBe(2);
    expect(s).toBe(STATE_STATEMENTS);
    const { value: list, statements: m } = await counted(async () => app.request("/api/coach/memory", { headers: { Cookie: cookie } }, env));
    const memory = ((await list.json()) as { memory: Array<{ id: string }> }).memory;
    expect(memory.map((r) => r.id).sort()).toEqual(["live-note", "live-rule"]);
    expect(m).toBe(MEMORY_STATEMENTS);
  });
});

// The statements each reader ran before this change, measured on this seed: unchanged.
const DOSSIER_STATEMENTS = 23;
const EFFORT_STATEMENTS = 13;
const GUARDRAIL_STATEMENTS = 4;
const STATE_STATEMENTS = 24;
const MEMORY_STATEMENTS = 2;
