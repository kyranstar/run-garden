/**
 * COACH EVERYWHERE, PHASE A1 — the opening context's "The athlete asked from: …" block (design-context.ts). A main run
 * asked from something the athlete was looking at gets a short block of the facts the coach needs to act on it, in the
 * context's own words, read in ONE added statement (none for a move: the library is bundled) — and the line of the
 * prompt that says what the athlete most likely wants from there (design-prompt.ts `FOCUS_LINES`). The athlete's own
 * text — titles, notes, words, an objective's — is marked untrusted, as everywhere in the context; a coach's suggestion
 * title as a designer run's words.
 *
 * Synthetic data only: design-read-fixture.ts's made-up athlete, on its fixed clock (Wed 13 May 2026, 09:30 in LA).
 */
import { beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { newId } from "@rg/domain";
import { EXERCISES } from "@rg/exercise-library";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { buildDesignContext, contextStatements, DESIGN_CONTEXT_STATEMENTS, type DesignRun } from "../src/services/design-context.js";
import { FOCUS_KINDS, type RunFocus } from "../src/services/design-focus.js";
import { FOCUS_LINES, markUntrusted } from "../src/services/design-prompt.js";
import { day, NOW, seedOtherAthlete, seedRichAthlete, TODAY } from "./design-read-fixture.js";
import { makeTestDb } from "./helpers.js";

const ENV = {} as Env;

let db: Db;
let statements = 0;
let me: Awaited<ReturnType<typeof seedRichAthlete>>;
let other: Awaited<ReturnType<typeof seedRichAthlete>>;

beforeAll(async () => {
  db = makeTestDb({ boundVariableCap: 100, onStatement: () => (statements += 1) });
  me = await seedRichAthlete(db);
  other = await seedOtherAthlete(db);
});

const run = (focus: RunFocus | undefined, over: Partial<DesignRun> = {}): DesignRun => ({
  id: "run-focus",
  role: "main",
  scope: { kind: "now" },
  request: "Something for this.",
  parentId: null,
  ...(focus ? { focus } : {}),
  ...over,
});

async function header(focus: RunFocus | undefined, over: Partial<DesignRun> = {}, userId = me.userId): Promise<{ header: string; statements: number; system: string }> {
  statements = 0;
  const ctx = await buildDesignContext(db, ENV, userId, run(focus, over), NOW);
  return { header: ctx.header, statements, system: ctx.system.map((b) => b.text).join("\n") };
}

/** The block, from its first line to the line before the request. */
function block(h: string): string {
  const from = h.indexOf("The athlete asked from:");
  expect(from, "the block is there").toBeGreaterThan(-1);
  const to = h.indexOf("\n\nThe athlete's request", from);
  return h.slice(from, to < 0 ? undefined : to);
}

const athlete = (text: string) => markUntrusted("athlete", text);

async function runActivity(): Promise<{ id: string; date: string }> {
  const rows = await db
    .select({ id: schema.activities.id, local: schema.activities.startTimeLocal })
    .from(schema.activities)
    .where(and(eq(schema.activities.userId, me.userId), eq(schema.activities.sport, "run"), eq(schema.activities.startTimeLocal, `${day(2)}T18:00:00`)));
  return { id: rows[0]!.id, date: day(2) };
}

describe("the block, kind by kind", () => {
  it("workout: its title, day, time, minutes, kind, state and its document's intent — the title and intent marked as the athlete's", async () => {
    const { header: h } = await header({ kind: "workout", id: me.todayDocId });
    const b = block(h);
    expect(b).toContain(`The athlete asked from: a planned workout (id ${me.todayDocId}) — Wed 13 May · today, 18:00 strength, Studio workout (about 40 min) — scheduled.`);
    expect(b).toContain(`- Its title: ${athlete("Strong hips, easy back")}`);
    expect(b).toContain(`- What it is for: ${athlete("Wake the glutes, then load the squat; finish by opening the hips.")}`);
    expect(b).toContain("- Its document is at rev 2: get_workout reads it whole.");
    expect(b).toContain(FOCUS_LINES.workout);
  });

  it("workout: one gone from the plan says so; a done one says done", async () => {
    expect(block((await header({ kind: "workout", id: me.archivedDocId })).header)).toContain(
      `The athlete asked from: a planned workout that is no longer on the plan (id ${me.archivedDocId}).`,
    );
    const done = block((await header({ kind: "workout", id: me.pastDocId })).header);
    expect(done).toContain(`a planned workout (id ${me.pastDocId}) — Sun 10 May · 3 d ago, 07:00 strength, Studio workout (about 40 min) — done.`);
  });

  it("day: the plan's rows that day, each with its id and words, the titles marked", async () => {
    const b = block((await header({ kind: "day", id: TODAY })).header);
    expect(b).toContain("The athlete asked from: a day on the plan — Wed 13 May · today.");
    expect(b).toContain(`- id ${me.outlineToday}: 07:00 strength, programme session (about 35 min) — its time passed, nothing logged; titled ${athlete("Strength")}`);
    expect(b).toContain(`- id ${me.todayDocId}: 18:00 strength, Studio workout (about 40 min) — scheduled; titled ${athlete("Strong hips, easy back")}`);
    expect(b).toContain(FOCUS_LINES.day);
    // A day with nothing on it says so (day(-1) holds nothing: the fixture plans every second and third day).
    expect(block((await header({ kind: "day", id: day(-1) })).header)).toContain("- nothing planned");
  });

  it("session: its day, minutes, what was done in counts (never every set), the checks, and the athlete's ratings and words marked", async () => {
    await db.insert(schema.athleteAnswers).values([
      {
        id: newId(), userId: me.userId, questionId: "workout_feedback", subjectKind: "performed_session", subjectId: me.sessionDay3, valueNum: 4,
        valueChoice: "too_hard", text: "Squats felt heavy today", source: "review", localDate: day(3), at: NOW.toISOString(), performedSessionId: me.sessionDay3,
      },
      {
        id: newId(), userId: me.userId, questionId: "exercise_feedback", subjectKind: "exercise", subjectId: "gobletSquat", valueNum: 1, source: "review",
        localDate: day(3), at: NOW.toISOString(), performedSessionId: me.sessionDay3,
      },
      {
        id: newId(), userId: me.userId, questionId: "exercise_feedback", subjectKind: "exercise", subjectId: "wallSit", valueNum: -1, source: "review",
        localDate: day(3), at: NOW.toISOString(), performedSessionId: me.sessionDay3,
      },
    ]);
    await db.update(schema.performedSessions).set({ note: "Knees fine" }).where(eq(schema.performedSessions.id, me.sessionDay3));
    const b = block((await header({ kind: "session", id: me.sessionDay3 })).header);
    expect(b).toContain(`The athlete asked from: a session they did (id ${me.sessionDay3}) — Sun 10 May · 3 d ago, 31 min, consistent, Full-body strength: 4 moves, 11 sets done, 1 move played without sets.`);
    expect(b).toContain("- Checks: TMJ 2 before, 2 after.");
    expect(b).toContain("- Their ratings: the session 4 of 5, too hard; liked Goblet squat; didn't like Wall sit.");
    expect(b).toContain(`- Their words: ${athlete("Squats felt heavy today")}`);
    expect(b).toContain(`- Their note: ${athlete("Knees fine")}`);
    expect(b).toContain("- read_history has its sets.");
    // Counts, not every set: no dose of any move.
    expect(b).not.toMatch(/× 8|35 lb/);
    expect(b).toContain(FOCUS_LINES.session);
  });

  it("activity: its sport, day, distance, time, pace and effort — its note marked, its imported title left out", async () => {
    const a = await runActivity();
    const b = block((await header({ kind: "activity", id: a.id })).header);
    expect(b).toContain(`The athlete asked from: an activity (id ${a.id}) — Mon 11 May · 2 d ago: run, 8.0 km, 45 min, pace 5:40 /km, heart rate 148, load 62, felt 4 of 5.`);
    expect(b).toContain(`- Their note: ${athlete("Legs heavy on the hills")}`);
    expect(b).not.toContain("Evening run");
    expect(b).toContain(FOCUS_LINES.activity);
  });

  it("objective: its title, why and status, and each measure with its start, target and date — the athlete's words marked; progress one read away", async () => {
    const b = block((await header({ kind: "objective", id: `${me.userId}-obj-hold` })).header);
    expect(b).toContain(`The athlete asked from: an objective (id ${me.userId}-obj-hold, active) — ${athlete("Hold a strong wall sit")}; why: ${athlete("Ski legs")}.`);
    expect(b).toMatch(new RegExp(`- Measure ${escape(athlete("Wall sit hold"))} \\(id [^)]+\\): from 40 to 90 s\\.`));
    expect(b).toMatch(new RegExp(`- Measure ${escape(athlete("Goblet squat estimated max"))} \\(id [^)]+\\): target 60 lb\\.`));
    expect(b).toContain("- Progress: read_objectives measures each one from the log.");
    expect(b).toContain(FOCUS_LINES.objective);
  });

  it("move: its name, what it is for and where it works — from the bundled library, no statement", async () => {
    const goblet = EXERCISES.find((e) => e.id === "gobletSquat")!;
    const { header: h, statements: n } = await header({ kind: "move", id: "gobletSquat" });
    const b = block(h);
    expect(b).toContain(`The athlete asked from: a move in the library — ${goblet.name} (id gobletSquat): ${goblet.text.summary}`);
    expect(b).toMatch(/- For: [A-Z][^.]+; regions: [A-Z][^.]+; difficulty \d of 5\./);
    expect(b).toContain(FOCUS_LINES.move);
    expect(n).toBe(contextStatements("main"));
  });

  it("proposal: its title, status, and each workout as day, time, title and minutes — the titles a designer run's words", async () => {
    const id = `dp-run-${newId()}`;
    await db.insert(schema.coachProposals).values({
      id, userId: me.userId, title: "Hips, gently", evidence: "", rationale: "", flags: [], status: "pending", createdAt: NOW.toISOString(), expiresAt: day(-1),
      ops: [
        { kind: "doc_workout", target: { kind: "new", date: TODAY, atNow: true, notBefore: "09:45" }, date: TODAY, doc: { title: "Hips, gently" }, derived: { estimatedMinutes: 25 } },
        { kind: "doc_workout", target: { kind: "new", date: day(-2) }, date: day(-2), time: "18:00", doc: { title: "Upper back" }, derived: { estimatedMinutes: 30 }, outcome: { status: "declined", at: NOW.toISOString() } },
        { kind: "plan_adjust", op: { kind: "skip", workoutId: me.outlineToday, reason: null } },
      ],
    });
    const b = block((await header({ kind: "proposal", id })).header);
    const designer = (text: string) => markUntrusted("designer run", text);
    expect(b).toContain(`The athlete asked from: your suggestion (id ${id}), pending — ${designer("Hips, gently")}:`);
    expect(b).toContain(`- Wed 13 May · today, now: ${designer("Hips, gently")} (25 min) — open`);
    expect(b).toContain(`- Fri 15 May · in 2 d, 18:00: ${designer("Upper back")} (30 min) — declined`);
    expect(b).toContain(`- a change to the plan: skip workout ${me.outlineToday} — open`);
    expect(b).toContain(FOCUS_LINES.proposal);
  });

  it("another athlete's object is never read into the block, whatever the id (the read is the athlete's)", async () => {
    for (const focus of [
      { kind: "workout", id: other.todayDocId },
      { kind: "session", id: other.sessionDay3 },
      { kind: "objective", id: `${other.userId}-obj-hold` },
    ] as RunFocus[]) {
      const b = block((await header(focus)).header);
      expect(b, focus.kind).not.toContain("OTHER-SENTINEL");
      expect(b, focus.kind).toMatch(/no longer|isn't there/);
    }
  });
});

describe("where it sits, and what it costs", () => {
  it("one statement more for every kind but a move; the main run's builds stay within DESIGN_CONTEXT_STATEMENTS (pinned)", async () => {
    const base = await header(undefined);
    expect(base.statements).toBe(contextStatements("main"));
    expect(base.header).not.toContain("The athlete asked from:");
    const ids: Record<string, string> = {
      workout: me.todayDocId,
      day: TODAY,
      session: me.sessionDay3,
      activity: (await runActivity()).id,
      objective: `${me.userId}-obj-hold`,
      move: "gobletSquat",
      proposal: `${me.userId}-prop-6`,
    };
    for (const kind of FOCUS_KINDS) {
      const focus = { kind, id: ids[kind]! } as RunFocus;
      const h = await header(focus);
      const added = kind === "move" ? 0 : 1;
      expect(h.statements, kind).toBe(base.statements + added);
      expect(contextStatements("main", focus), kind).toBe(base.statements + added);
      expect(h.statements, kind).toBeLessThanOrEqual(DESIGN_CONTEXT_STATEMENTS);
    }
    expect(DESIGN_CONTEXT_STATEMENTS).toBe(12);
  });

  it("in the opening message — after the index, before the request — never in the cached system blocks", async () => {
    const h = await header({ kind: "workout", id: me.todayDocId });
    const at = h.header.indexOf("The athlete asked from:");
    expect(at).toBeGreaterThan(h.header.indexOf("What the tools can reach"));
    expect(at).toBeLessThan(h.header.indexOf("The athlete's request, in their own words:"));
    expect(h.system).not.toContain("The athlete asked from:");
    for (const kind of FOCUS_KINDS) expect(h.system, kind).not.toContain(FOCUS_LINES[kind]);
  });

  it("only the focus's own kind's line, once", async () => {
    const h = (await header({ kind: "move", id: "gobletSquat" })).header;
    for (const kind of FOCUS_KINDS) expect(h.split(FOCUS_LINES[kind]).length - 1, kind).toBe(kind === "move" ? 1 : 0);
  });

  it("a designer or a reviewer is never given one (a sub-run's run carries none; given one, it is ignored)", async () => {
    for (const role of ["designer", "reviewer"] as const) {
      const h = await header({ kind: "workout", id: me.todayDocId }, { role, brief: "A calm session." });
      expect(h.header, role).not.toContain("The athlete asked from:");
      // No statement for it: a designer's 11, and this reviewer's too (its draft isn't found, so no days around it).
      expect(h.statements, role).toBe(11);
    }
  });
});

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
