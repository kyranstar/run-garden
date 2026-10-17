/**
 * COACH EVERYWHERE, PHASE A1 — a run's structured focus (`POST /api/coach/runs { focus: { kind, id } }`): what the
 * athlete was looking at when they asked. The route validates it with zod (400 `bad_focus`), the create checks it is the
 * signed-in athlete's in one statement (404 `focus_not_found` for another athlete's or a missing one; none for a day or
 * a move), a day is held to the run's horizon (400 `focus_out_of_range`, in words), and a set's suggestion is refused
 * (400 `focus_is_set`, in words). The focus is kept in the run's state (`settings.focus`, no migration) and handed to
 * the opening context of the main run only.
 *
 * The model is scripted; no key, no network. Synthetic data only (design-read-fixture.ts's made-up athletes).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, dayLabel, todayInZone } from "@rg/domain";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { makeCoachRunRoutes } from "../src/routes/coach-runs.js";
import { newRunState, type ContextBuilder, type ContextRun, type RunDeps } from "../src/services/coach-runs.js";
import { FOCUS_KINDS, FOCUS_SET_LINE } from "../src/services/design-focus.js";
import type { MessagesRequest, MessagesResult } from "../src/services/llm-messages.js";
import { seedOtherAthlete, seedRichAthlete, TZ } from "./design-read-fixture.js";
import { makeTestDb, mountRoutes } from "./helpers.js";

const ON = {
  DB: {} as unknown as Env["DB"],
  ASSETS: {} as unknown as Env["ASSETS"],
  APP_URL: "https://app.test",
  FIXTURE_MODE: "0",
  AI_DEFAULT_ENABLED: "1",
  SESSION_SECRET: "s",
  TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  ALLOWED_GOOGLE_EMAIL: "runner@example.com",
  GOOGLE_CLIENT_ID: "c",
  GOOGLE_CLIENT_SECRET: "c",
  COACH_DESIGNER: "1",
} as Env;

let db: Db;
let statements = 0;
let built: ContextRun[] = [];

const context: ContextBuilder = {
  statementCost: 1,
  async build(_db, _env, _userId, run) {
    built.push(run);
    return { system: [{ type: "text", text: "SYSTEM" }], header: "HEADER" };
  },
};
const deps = (): RunDeps => ({
  callModel: async (_env: Env, _req: MessagesRequest): Promise<MessagesResult> => {
    throw new Error("no model call in these tests");
  },
  buildContext: context,
  tools: [],
});

interface Athlete {
  userId: string;
  cookie: string;
  ids: Awaited<ReturnType<typeof seedRichAthlete>>;
}

async function signedIn(seed: (db: Db) => ReturnType<typeof seedRichAthlete>): Promise<Athlete> {
  const ids = await seed(db);
  return { userId: ids.userId, cookie: `${SESSION_COOKIE}=${await createSession(db, ids.userId)}`, ids };
}

async function call(a: Athlete, method: string, path: string, body?: unknown) {
  const res = await mountRoutes(db, "/api/coach/runs", makeCoachRunRoutes(deps)).request(
    `/api/coach/runs${path}`,
    { method, headers: { Cookie: a.cookie, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
    ON,
  );
  return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, any> };
}

async function measured(a: Athlete, body: unknown) {
  statements = 0;
  const res = await call(a, "POST", "", body);
  return { ...res, statements };
}

const stateOf = async (runId: string) => {
  const [row] = await db.select({ state: schema.coachRuns.state }).from(schema.coachRuns).where(eq(schema.coachRuns.id, runId));
  return JSON.parse(row!.state!) as { settings: Record<string, unknown> };
};
/** The runs a create started (not the finished runs `suggestion` makes its suggestions with). */
const runCount = async (userId: string) =>
  (await db.select().from(schema.coachRuns).where(eq(schema.coachRuns.userId, userId))).filter((r) => !r.id.startsWith("r-")).length;

/** The athlete's real today (the route reads the real clock), in the fixture's zone. */
const realToday = () => todayInZone(TZ, new Date());

async function runActivity(userId: string): Promise<string> {
  const [a] = await db
    .select({ id: schema.activities.id })
    .from(schema.activities)
    .where(and(eq(schema.activities.userId, userId), eq(schema.activities.sport, "run")))
    .limit(1);
  return a!.id;
}

/** A designed suggestion and the main run that made it: `scope`'s, in `status`. */
async function suggestion(userId: string, scope: { kind: string; n?: number }, status = "pending"): Promise<string> {
  const runId = `r-${scope.kind}-${status}-${userId}`;
  const at = new Date(Date.now() - 3_600_000).toISOString();
  await db.insert(schema.coachRuns).values({
    id: runId, userId, parentId: null, role: "main", scope, request: "hips", status: "finished",
    state: null, steps: 3, costUsd: 0.4, createdAt: at, updatedAt: at, finishedAt: at,
  });
  const id = `dp-${runId}`;
  const date = realToday();
  await db.insert(schema.coachProposals).values({
    id, userId, title: "Hips, gently", evidence: "", rationale: "", flags: [], status, createdAt: at, expiresAt: addDays(date, 1),
    ops: [{ kind: "doc_workout", target: { kind: "new", date, atNow: true, notBefore: "09:00" }, date, doc: { title: "Hips, gently" }, derived: { estimatedMinutes: 25 }, by: { runId, role: "main" } }],
  });
  return id;
}

let me: Athlete;
let other: Athlete;

beforeEach(async () => {
  db = makeTestDb({ boundVariableCap: 100, onStatement: () => (statements += 1) });
  built = [];
  me = await signedIn(seedRichAthlete);
  other = await signedIn(seedOtherAthlete);
});

/** One focus of each kind the athlete owns; `of` the athlete whose objects they are. */
async function focusOf(kind: (typeof FOCUS_KINDS)[number], of: Athlete): Promise<{ kind: string; id: string }> {
  switch (kind) {
    case "workout":
      return { kind, id: of.ids.todayDocId };
    case "day":
      return { kind, id: realToday() };
    case "session":
      return { kind, id: of.ids.sessionDay3 };
    case "activity":
      return { kind, id: await runActivity(of.userId) };
    case "objective":
      return { kind, id: `${of.userId}-obj-hold` };
    case "move":
      return { kind, id: "gobletSquat" };
    case "proposal":
      return { kind, id: await suggestion(of.userId, { kind: "now" }) };
  }
}

describe("a run's focus: the athlete's own, kept with the run", () => {
  it("every kind of the athlete's own object starts a run that keeps it in its state, and its opening context is given it", async () => {
    expect([...FOCUS_KINDS]).toEqual(["workout", "day", "session", "activity", "objective", "move", "proposal"]);
    for (const kind of FOCUS_KINDS) {
      const focus = await focusOf(kind, me);
      const created = await call(me, "POST", "", { scope: { kind: "now" }, request: "help", focus });
      expect(created.status, kind).toBe(200);
      expect(created.body.existing, kind).toBe(false);
      const runId = created.body.run.id as string;
      expect((await stateOf(runId)).settings.focus, kind).toEqual(focus);
      // The run's read says what it was asked from.
      expect(created.body.run.focus, kind).toEqual(focus);
      built = [];
      expect((await call(me, "POST", `/${runId}/step`)).status, kind).toBe(200);
      expect(built.map((r) => r.focus), kind).toEqual([focus]);
      await call(me, "POST", `/${runId}/cancel`);
    }
  });

  it("no focus: none kept, none given — as before", async () => {
    const created = await call(me, "POST", "", { scope: { kind: "now" }, request: "help" });
    expect(created.status).toBe(200);
    expect((await stateOf(created.body.run.id)).settings).not.toHaveProperty("focus");
    expect(created.body.run).not.toHaveProperty("focus");
    await call(me, "POST", `/${created.body.run.id}/step`);
    expect(built).toHaveLength(1);
    expect(built[0]).not.toHaveProperty("focus");
  });

  it("another athlete's object, or one that isn't there: 404 focus_not_found, and nothing starts", async () => {
    for (const kind of FOCUS_KINDS) {
      if (kind === "day") continue; // a day is no one's: held to the horizon instead (below)
      const theirs = kind === "move" ? null : await focusOf(kind, other);
      const missing = { kind, id: kind === "move" ? "noSuchMove" : `missing-${kind}` };
      for (const focus of theirs ? [theirs, missing] : [missing]) {
        const res = await call(me, "POST", "", { scope: { kind: "now" }, request: "help", focus });
        expect(res.status, `${kind} ${focus.id}`).toBe(404);
        expect(res.body, `${kind} ${focus.id}`).toEqual({ error: "focus_not_found" });
      }
    }
    expect(await runCount(me.userId)).toBe(0);
  });

  it("an archived workout, a session still being written, a rehearsal's or a cancelled suggestion: not the athlete's to ask from", async () => {
    const archived = await call(me, "POST", "", { scope: { kind: "now" }, focus: { kind: "workout", id: me.ids.archivedDocId } });
    expect(archived.status).toBe(404);
    const [pending] = await db
      .select({ id: schema.performedSessions.id })
      .from(schema.performedSessions)
      .where(and(eq(schema.performedSessions.userId, me.userId), eq(schema.performedSessions.payloadHash, "pending")));
    expect((await call(me, "POST", "", { scope: { kind: "now" }, focus: { kind: "session", id: pending!.id } })).status).toBe(404);
    for (const status of ["rehearsal", "unreviewed", "cancelled"]) {
      const id = await suggestion(me.userId, { kind: "now" }, status);
      expect((await call(me, "POST", "", { scope: { kind: "now" }, focus: { kind: "proposal", id } })).status, status).toBe(404);
    }
    // A thread coach's proposal is no designed suggestion.
    expect((await call(me, "POST", "", { scope: { kind: "now" }, focus: { kind: "proposal", id: `${me.userId}-prop-6` } })).status).toBe(404);
    expect(await runCount(me.userId)).toBe(0);
  });

  it("a malformed focus is a 400 bad_focus, and nothing starts", async () => {
    for (const focus of [
      null,
      "workout",
      [],
      {},
      { kind: "plan", id: "x" },
      { kind: "workout" },
      { kind: "workout", id: "" },
      { kind: "workout", id: 7 },
      { kind: "workout", id: "x".repeat(201) },
      { kind: "workout", id: "w1", extra: true },
      { kind: "day", id: "2026-02-30" },
      { kind: "day", id: "tomorrow" },
    ]) {
      const res = await call(me, "POST", "", { scope: { kind: "now" }, focus });
      expect(res.status, JSON.stringify(focus)).toBe(400);
      expect(res.body.error, JSON.stringify(focus)).toBe("bad_focus");
    }
    expect(await runCount(me.userId)).toBe(0);
  });

  it("a day is held to what a run can plan — a week back to six days ahead, whatever the scope — and refused in words past it (the review, I1)", async () => {
    const today = realToday();
    // A week back is still a day to ask about; six days ahead is the last a run plans (Now's day, a set's seven days).
    for (const scope of [{ kind: "now" }, { kind: "week" }, { kind: "next_n", n: 7 }]) {
      for (const date of [addDays(today, -7), today, addDays(today, 6)]) {
        const res = await call(me, "POST", "", { scope, focus: { kind: "day", id: date } });
        expect(res.status, `${scope.kind} ${date}`).toBe(200);
        await call(me, "POST", `/${res.body.run.id}/cancel`);
      }
      // No button plans a day past +6: plan_set plans today to +6 (the review, I1) — a week's context reads further.
      for (const date of [addDays(today, -8), addDays(today, 7), addDays(today, 13), addDays(today, 400), "1999-01-01"]) {
        const res = await call(me, "POST", "", { scope, focus: { kind: "day", id: date } });
        expect(res.status, `${scope.kind} ${date}`).toBe(400);
        expect(res.body.error, date).toBe("focus_out_of_range");
        expect(res.body.why, date).toBe(`Ask about a day from ${dayLabel(addDays(today, -7))} to ${dayLabel(addDays(today, 6))}.`);
      }
    }
  });

  it("a set's suggestion is refused in words — Plan ahead changes a week plan; with no scope asked, a single one's follow-up is an auto run", async () => {
    for (const scope of [{ kind: "week" }, { kind: "next_n", n: 3 }]) {
      const id = await suggestion(me.userId, scope);
      const res = await call(me, "POST", "", { focus: { kind: "proposal", id }, request: "shorter" });
      expect(res.status, scope.kind).toBe(400);
      expect(res.body, scope.kind).toEqual({ error: "focus_is_set", why: FOCUS_SET_LINE });
    }
    expect(FOCUS_SET_LINE).toBe("Ask Plan ahead again to change a week plan.");
    const later = await suggestion(me.userId, { kind: "later_today" });
    const res = await call(me, "POST", "", { focus: { kind: "proposal", id: later }, request: "shorter" });
    expect(res.status).toBe(200);
    // No scope asked: an auto run (the new shape §5) — the coach reads the time frame from the words.
    expect(res.body.run.scope).toEqual({ kind: "auto" });
    await call(me, "POST", `/${res.body.run.id}/cancel`);
    // A scope asked for is the athlete's word: it stands.
    const asked = await call(me, "POST", "", { scope: { kind: "now" }, focus: { kind: "proposal", id: later }, request: "shorter" });
    expect(asked.body.run.scope).toEqual({ kind: "now" });
    await call(me, "POST", `/${asked.body.run.id}/cancel`);
    // A decided suggestion is still one to ask from (the follow-up then supersedes nothing: A2).
    const approved = await suggestion(me.userId, { kind: "now" }, "approved");
    expect((await call(me, "POST", "", { focus: { kind: "proposal", id: approved } })).status).toBe(200);
  });

  it("the check is one statement — none for a day or a move — on top of a create without one (pinned)", async () => {
    const base = await measured(me, { scope: { kind: "now" }, request: "help" });
    expect(base.status).toBe(200);
    await call(me, "POST", `/${base.body.run.id}/cancel`);
    for (const kind of FOCUS_KINDS) {
      const focus = await focusOf(kind, me);
      const res = await measured(me, { scope: { kind: "now" }, request: "help", focus });
      expect(res.status, kind).toBe(200);
      expect(res.statements, kind).toBe(base.statements + (kind === "day" || kind === "move" ? 0 : 1));
      expect(res.statements, kind).toBeLessThanOrEqual(45);
      await call(me, "POST", `/${res.body.run.id}/cancel`);
    }
    // A refusal costs no more than the check.
    const refused = await measured(me, { scope: { kind: "now" }, focus: { kind: "workout", id: "missing" } });
    expect(refused.status).toBe(404);
    expect(refused.statements).toBeLessThanOrEqual(base.statements);
  });

  it("a live run answered `existing` keeps its own focus; the words and the focus this tap carried are offered back", async () => {
    const first = await call(me, "POST", "", { scope: { kind: "now" }, request: "hips", focus: { kind: "move", id: "gobletSquat" } });
    const workout = { kind: "workout", id: me.ids.todayDocId };
    const again = await call(me, "POST", "", { scope: { kind: "now" }, request: "back", focus: workout });
    expect(again.body).toMatchObject({ existing: true, run: { id: first.body.run.id, focus: { kind: "move", id: "gobletSquat" } } });
    expect(again.body.ignoredRequest).toEqual({ scope: { kind: "now" }, request: "back", focus: workout });
    expect((await stateOf(first.body.run.id)).settings.focus).toEqual({ kind: "move", id: "gobletSquat" });
  });

  it("only a main run's state holds one: a designer's or a reviewer's is never given it", () => {
    const focus = { kind: "move", id: "gobletSquat" } as const;
    expect(newRunState("main", { kind: "now" }, { focus }).settings.focus).toEqual(focus);
    for (const role of ["designer", "reviewer"] as const) expect(newRunState(role, { kind: "now" }, { focus }).settings, role).not.toHaveProperty("focus");
  });
});
