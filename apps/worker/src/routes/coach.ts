import { Hono } from "hono";
import { and, desc, eq, isNull, lt } from "drizzle-orm";
import {
  activities,
  coachMemory,
  coachMessages,
  coachPlans,
  coachPlanWeeks,
  coachProposals,
  coachQuestions,
  plannedWorkouts,
  studioPlans,
  studioPlanPushes,
  workoutCompletionMatches,
} from "@rg/database";
import {
  addDays,
  humanizeWorkoutTitle,
  newId,
  nowInstant,
  startOfIsoWeek,
  todayInZone,
  type CoachOp,
  type LiftingPlan,
} from "@rg/domain";
import type { AppContext } from "../auth/middleware.js";
import { requireUser } from "../auth/middleware.js";
import { loadPreferences } from "../services/calendar-sync.js";
import { ensureRead } from "../services/coach-reads.js";
import { exerciseNameMap, resolveExerciseName } from "../services/exercise-catalog.js";
import { liftProgressions, liftWeekSummary, runProgressions } from "../services/plan-progressions.js";
import { applyOps } from "../services/coach-apply.js";
import { evaluateTriggers, pendingTriggers } from "../services/coach-triggers.js";
import { coachBlockAdherence, plansEndedOn } from "../services/coach-plans.js";
import { openWakeIsFresh, wake } from "../services/coach-wake.js";
import type { Db } from "../services/db.js";

/**
 * The coach's HTTP surface (Plan A Tasks A7+A9). Proposals are STATE with a
 * strict lifecycle: pending is the only actionable status, everything else
 * is inert history — approve/decline 409 anything stale, and the expiry
 * sweep (cron + inline on state reads) closes what the calendar outran.
 */

export const coachRoutes = new Hono<AppContext>();
coachRoutes.use("*", requireUser);

async function receipt(
  db: Db,
  userId: string,
  body: string,
  proposalId?: string,
): Promise<void> {
  await db.insert(coachMessages).values({
    id: newId(),
    userId,
    role: "receipt",
    body,
    refs: proposalId ? { proposalId } : {},
    at: nowInstant(),
  });
}

/** Expire pending proposals whose day passed or TTL lapsed (spec §3). */
export async function sweepExpiredProposals(db: Db, userId: string, today: string): Promise<number> {
  const stale = await db
    .select()
    .from(coachProposals)
    .where(
      and(
        eq(coachProposals.userId, userId),
        eq(coachProposals.status, "pending"),
        lt(coachProposals.expiresAt, today),
      ),
    );
  const now = nowInstant();
  for (const p of stale) {
    await db
      .update(coachProposals)
      .set({ status: "expired", resolvedAt: now })
      .where(eq(coachProposals.id, p.id));
    await receipt(db, userId, `Expired — the moment passed: ${p.title}`, p.id);
  }
  return stale.length;
}

coachRoutes.get("/state", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const prefs = await loadPreferences(db, userId);
  const today = todayInZone(prefs.timezone);
  await sweepExpiredProposals(db, userId, today);
  await evaluateTriggers(db, userId, prefs, today).catch(() => []);

  const before = c.req.query("before");
  const msgs = await db
    .select()
    .from(coachMessages)
    .where(
      before
        ? and(eq(coachMessages.userId, userId), lt(coachMessages.at, before))
        : eq(coachMessages.userId, userId),
    )
    .orderBy(desc(coachMessages.at))
    .limit(30);
  const pending = await db
    .select()
    .from(coachProposals)
    .where(and(eq(coachProposals.userId, userId), eq(coachProposals.status, "pending")))
    .orderBy(coachProposals.expiresAt);
  const [openQuestion] = await db
    .select()
    .from(coachQuestions)
    .where(and(eq(coachQuestions.userId, userId), isNull(coachQuestions.answeredAt)))
    .limit(1);
  const memoryRows = await db
    .select()
    .from(coachMemory)
    .where(and(eq(coachMemory.userId, userId), eq(coachMemory.active, true)));
  const triggers = await pendingTriggers(db, userId);
  const [lastCoach] = await db
    .select()
    .from(coachMessages)
    .where(and(eq(coachMessages.userId, userId), eq(coachMessages.role, "coach")))
    .orderBy(desc(coachMessages.at))
    .limit(1);
  // Shares the wake pipeline's own "would an open wake be redundant?" check
  // (audit C4/C14): a recent failed/resting attempt wins over a pending
  // trigger (triggers stay unconsumed until a wake succeeds, so without this
  // a missed-workout trigger alone would force a retry on every single Plan
  // visit during an outage); short of that, a trigger always outweighs a
  // fresh existing briefing.
  const wakeAdvised = !(await openWakeIsFresh(db, userId, triggers.length));

  return c.json({
    messages: [...msgs].reverse(),
    pendingProposals: pending,
    openQuestion: openQuestion ?? null,
    memoryCount: memoryRows.length,
    lastCoachAt: lastCoach?.at ?? null,
    wakeAdvised,
  });
});

coachRoutes.post("/wake", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const { force } = await c.req.json<{ force?: boolean }>().catch(() => ({ force: false }));
  const prefs = await loadPreferences(db, userId);
  // force = the user's own "Check in" button: bypasses the skip rule (a
  // fresh briefing doesn't matter — they asked), never the budget gate.
  const result = await wake(db, c.env, userId, prefs, { kind: force ? "manual" : "open" });
  return c.json(result);
});

coachRoutes.post("/analyze/:activityId", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const { force } = await c.req.json<{ force?: boolean }>().catch(() => ({ force: false }));
  const prefs = await loadPreferences(db, userId);
  // Read-through on the perception ledger (rework spec §2): the ledger is
  // the single source of truth, so a user tap and the ambient pipeline can
  // never double-read the same effort.
  const r = await ensureRead(db, c.env, userId, prefs, c.req.param("activityId"), {
    force: force === true,
  });
  if (r.status === "not_found") return c.json({ error: "not_found" }, 404);
  if (r.status === "working") return c.json({ status: "working" }, 202);
  if (r.status === "resting") {
    return c.json({ error: "resting", detail: "Weekly coach budget reached — try next week." }, 429);
  }
  if (r.status === "ai_disabled") return c.json({ error: "ai_disabled" }, 503);
  if (r.status === "error" || !r.read) return c.json({ error: "llm_error" }, 502);
  return c.json({ read: r.read, cached: r.cached === true });
});

coachRoutes.post("/message", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const { body } = await c.req.json<{ body?: string }>().catch(() => ({ body: undefined }));
  if (!body || typeof body !== "string" || body.length > 4000) {
    return c.json({ error: "bad_request" }, 400);
  }
  const prefs = await loadPreferences(db, userId);
  const result = await wake(db, c.env, userId, prefs, { kind: "message", body });
  return c.json(result);
});

coachRoutes.post("/proposals/:id/approve", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const id = c.req.param("id");
  const [p] = await db
    .select()
    .from(coachProposals)
    .where(and(eq(coachProposals.id, id), eq(coachProposals.userId, userId)))
    .limit(1);
  if (!p) return c.json({ error: "not_found" }, 404);
  if (p.status !== "pending") return c.json({ error: "not_pending", status: p.status }, 409);

  const prefs = await loadPreferences(db, userId);
  const applied = await applyOps(db, userId, prefs, p.id, p.ops as CoachOp[]);
  await db
    .update(coachProposals)
    .set({ status: "approved", resolvedAt: nowInstant() })
    .where(eq(coachProposals.id, id));
  await receipt(db, userId, `✓ approved — ${p.title}`, p.id);
  return c.json({ ok: true, applied });
});

coachRoutes.post("/proposals/:id/decline", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const id = c.req.param("id");
  const [p] = await db
    .select()
    .from(coachProposals)
    .where(and(eq(coachProposals.id, id), eq(coachProposals.userId, userId)))
    .limit(1);
  if (!p) return c.json({ error: "not_found" }, 404);
  if (p.status !== "pending") return c.json({ error: "not_pending", status: p.status }, 409);
  await db
    .update(coachProposals)
    .set({ status: "declined", resolvedAt: nowInstant() })
    .where(eq(coachProposals.id, id));
  await receipt(db, userId, `Left as planned — ${p.title}`, p.id);
  return c.json({ ok: true });
});

coachRoutes.post("/questions/:id/answer", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const id = c.req.param("id");
  const { answer } = await c.req.json<{ answer?: string }>().catch(() => ({ answer: undefined }));
  if (!answer || answer.length > 500) return c.json({ error: "bad_request" }, 400);
  const [q] = await db
    .select()
    .from(coachQuestions)
    .where(and(eq(coachQuestions.id, id), eq(coachQuestions.userId, userId)))
    .limit(1);
  if (!q) return c.json({ error: "not_found" }, 404);
  if (q.answeredAt) return c.json({ error: "already_answered" }, 409);
  const now = nowInstant();
  const memoryId = newId();
  await db.insert(coachMemory).values({
    id: memoryId,
    userId,
    kind: "fact",
    body: `${q.body} → ${answer}`,
    provenance: { source: "question", messageId: q.id, at: now },
    learnedAt: now,
    active: true,
  });
  await db
    .update(coachQuestions)
    .set({ answeredAt: now, memoryId })
    .where(eq(coachQuestions.id, id));
  // The answer continues the conversation like any message.
  const prefs = await loadPreferences(db, userId);
  const result = await wake(db, c.env, userId, prefs, { kind: "message", body: answer });
  return c.json({ ok: true, memoryId, wake: result });
});

coachRoutes.get("/memory", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const rows = await db
    .select()
    .from(coachMemory)
    .where(and(eq(coachMemory.userId, userId), eq(coachMemory.active, true)))
    .orderBy(desc(coachMemory.learnedAt));
  return c.json({ memory: rows });
});

coachRoutes.patch("/memory/:id", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const { body } = await c.req.json<{ body?: string }>().catch(() => ({ body: undefined }));
  if (!body || body.length > 300) return c.json({ error: "bad_request" }, 400);
  await db
    .update(coachMemory)
    .set({ body })
    .where(and(eq(coachMemory.id, c.req.param("id")), eq(coachMemory.userId, userId)));
  return c.json({ ok: true });
});

coachRoutes.delete("/memory/:id", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  // Immediate and total (spec §5): the next dossier simply lacks the item.
  await db
    .update(coachMemory)
    .set({ active: false })
    .where(and(eq(coachMemory.id, c.req.param("id")), eq(coachMemory.userId, userId)));
  return c.json({ ok: true });
});

coachRoutes.get("/plans", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const rows = await db.select().from(coachPlans).where(eq(coachPlans.userId, userId));
  // Studio-authored lifting plans are real plans this app created and wrote
  // to COROS — "Manage plans" claiming "no plans" while one is live on the
  // watch reads as a lie. They carry source:"studio" so the UI renders them
  // with Studio affordances instead of coach ones.
  // Newest studio plan only: generate keeps full history and each replace
  // retires the previous plan's COROS sessions — listing superseded rows as
  // live would be the same lie pointed the other way.
  const studio = (
    await db
      .select()
      .from(studioPlans)
      .where(eq(studioPlans.userId, userId))
      .orderBy(desc(studioPlans.createdAt))
      .limit(1)
  )[0];
  const studioEntries = [];
  if (studio) {
    // "Written to COROS" only when a push has actually materialized there —
    // generate and push are separate actions.
    const pushed = (
      await db
        .select({ id: studioPlanPushes.id })
        .from(studioPlanPushes)
        .where(and(eq(studioPlanPushes.planId, studio.id), eq(studioPlanPushes.status, "verified")))
        .limit(1)
    )[0];
    studioEntries.push({
      id: studio.id,
      discipline: "lift" as const,
      name: ((studio.plan as { name?: string })?.name ?? "Lifting plan"),
      status: (pushed ? "active" : "draft") as "active" | "draft",
      startDate: studio.createdAt.slice(0, 10),
      endDate: studio.createdAt.slice(0, 10),
      raceDate: null,
      source: "studio" as const,
    });
  }
  return c.json({
    plans: [...rows.map((r) => ({ ...r, source: "coach" as const })), ...studioEntries],
  });
});

/** Plan detail: weeks (firm/shape), prescribed progressions with series,
 * session counts (rework spec §4). Accepts coach- and studio-plan ids. */
coachRoutes.get("/plans/:id/detail", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const id = c.req.param("id");
  const prefs = await loadPreferences(db, userId);
  const today = todayInZone(prefs.timezone);
  const thisMonday = startOfIsoWeek(today);
  const weekIndexOf = (planW1: string, date: string): number =>
    Math.floor((Date.parse(startOfIsoWeek(date)) - Date.parse(planW1)) / (7 * 86_400_000)) + 1;

  const [cp] = await db
    .select()
    .from(coachPlans)
    .where(and(eq(coachPlans.id, id), eq(coachPlans.userId, userId)))
    .limit(1);
  if (cp) {
    const planW1 = startOfIsoWeek(cp.startDate);
    const weekTotal = weekIndexOf(planW1, cp.endDate);
    const currentWeek =
      thisMonday >= planW1 && weekIndexOf(planW1, today) <= weekTotal
        ? weekIndexOf(planW1, today)
        : null;

    const shapeRows = await db.select().from(coachPlanWeeks).where(eq(coachPlanWeeks.planId, cp.id));
    const shapeByWeek = new Map(shapeRows.map((w) => [w.weekStart, w]));
    const workouts = await db
      .select()
      .from(plannedWorkouts)
      .where(
        and(
          eq(plannedWorkouts.userId, userId),
          eq(plannedWorkouts.planId, cp.id),
          isNull(plannedWorkouts.archivedAt),
        ),
      );
    const matches = workouts.length
      ? await db
          .select()
          .from(workoutCompletionMatches)
          .where(and(isNull(workoutCompletionMatches.undoneAt)))
      : [];
    const matchByWorkout = new Map(matches.map((m) => [m.workoutId, m]));
    const actIds = [...new Set(matches.map((m) => m.activityId))];
    const actRows = actIds.length ? await db.select().from(activities).where(eq(activities.userId, userId)) : [];
    const actById = new Map(actRows.map((a) => [a.id, a]));

    const weeks = [];
    const facts = [];
    for (let i = 1; i <= weekTotal; i++) {
      const weekStart = addDays(planW1, (i - 1) * 7);
      const weekEnd = addDays(weekStart, 6);
      const inWeek = workouts.filter((w) => w.effectiveDate >= weekStart && w.effectiveDate <= weekEnd);
      const nonRest = inWeek.filter((w) => w.category !== "rest");
      const shape = shapeByWeek.get(weekStart);
      const state: "firm" | "shape" = shape?.state === "shape" ? "shape" : "firm";
      const done = weekEnd < today && nonRest.length > 0 && nonRest.every((w) => w.completionState === "completed");
      const longRunMeters = nonRest.reduce<number | null>(
        (m, w) => (w.expectedDistanceMeters ? Math.max(m ?? 0, w.expectedDistanceMeters) : m),
        null,
      );
      const plannedSeconds = nonRest.reduce(
        (s, w) => s + (w.sourceEstimatedDurationSeconds ?? w.fallbackEstimatedDurationSeconds ?? 0),
        0,
      );
      let actualSeconds: number | null = null;
      for (const w of nonRest) {
        const m = matchByWorkout.get(w.id);
        const a = m ? actById.get(m.activityId) : undefined;
        if (a) actualSeconds = (actualSeconds ?? 0) + a.durationSeconds;
      }
      // COROS structured names are frequently opaque codes ("T1004") — the
      // weeks list speaks category words instead when the title is one.
      const keyTitles = nonRest
        .filter((w) => w.category === "long" || w.category === "quality" || w.sport === "strength")
        .map((w) => humanizeWorkoutTitle(w.title, w.category, w.qualitySubtype))
        .slice(0, 2);
      const summary =
        state === "shape"
          ? (shape?.shape?.volumeTarget ?? "outline — the coach firms this up as it approaches")
          : keyTitles.length
            ? keyTitles.join(" · ")
            : nonRest.length
              ? `${nonRest.length} sessions`
              : "quiet week";
      weeks.push({
        weekStart,
        index: i,
        state,
        volumeTarget: shape?.shape?.volumeTarget ?? null,
        keySessions: shape?.shape?.keySessions ?? [],
        summary,
        done,
        current: currentWeek === i,
      });
      facts.push({ week: i, longRunMeters, plannedSeconds, actualSeconds, done });
    }

    // Coach-authored lift plans keep their structure (spec §5) — graph it.
    let progressions;
    if (cp.discipline === "lift") {
      // The actual exercise name, every place (round 3): code-named
      // exercises resolve through the COROS catalog before anything graphs
      // or summarizes them.
      const catalog = await exerciseNameMap(db);
      const liftWeeks = weeks.map((wk) => ({
        sessions: workouts
          .filter(
            (w) =>
              w.effectiveDate >= wk.weekStart &&
              w.effectiveDate <= addDays(wk.weekStart, 6) &&
              w.structuredJson?.exercises,
          )
          .map((w) => ({
            title: w.title,
            weekday: 1,
            exercises: (
              (w.structuredJson?.exercises ?? []) as LiftingPlan["weeks"][number]["sessions"][number]["exercises"]
            ).map((ex) => ({ ...ex, name: resolveExerciseName(ex.name, ex.originId, catalog) })),
          })),
      }));
      const doneWeeks = new Set(facts.filter((f) => f.done).map((f) => f.week));
      progressions = liftProgressions({ weeks: liftWeeks }, doneWeeks, currentWeek);
    } else {
      progressions = runProgressions(facts, currentWeek);
    }

    const nonRestAll = workouts.filter((w) => w.category !== "rest");
    const adh = await coachBlockAdherence(db, userId, cp.id, cp.startDate, cp.endDate);
    return c.json({
      plan: { ...cp, source: "coach" as const },
      weeks,
      progressions,
      sessions: {
        planned: nonRestAll.length,
        done: nonRestAll.filter((w) => w.completionState === "completed").length,
      },
      adherencePct: adh === null ? null : Math.round(adh * 100),
    });
  }

  const [sp] = await db
    .select()
    .from(studioPlans)
    .where(and(eq(studioPlans.id, id), eq(studioPlans.userId, userId)))
    .limit(1);
  if (sp) {
    // Same rule as the coach branch: real exercise names before graphing.
    const catalog = await exerciseNameMap(db);
    const raw = sp.plan as LiftingPlan;
    const plan: LiftingPlan = {
      ...raw,
      weeks: raw.weeks.map((wk) => ({
        ...wk,
        sessions: wk.sessions.map((s) => ({
          ...s,
          exercises: s.exercises.map((ex) => ({
            ...ex,
            name: resolveExerciseName(ex.name, ex.originId, catalog),
          })),
        })),
      })),
    };
    const planW1 = startOfIsoWeek(plan.brief.startDate);
    const weekTotal = plan.brief.durationWeeks;
    const endDate = addDays(planW1, weekTotal * 7 - 1);
    const currentWeek =
      thisMonday >= planW1 && weekIndexOf(planW1, today) <= weekTotal
        ? weekIndexOf(planW1, today)
        : null;

    const pushes = await db.select().from(studioPlanPushes).where(eq(studioPlanPushes.planId, sp.id));
    // A push materializes on COROS and comes back as a planned workout keyed
    // `${corosPlanId}:${idInPlan}` — that row's completionState is the truth.
    const keys = pushes
      .filter((p) => p.corosPlanId && p.corosIdInPlan)
      .map((p) => ({ push: p, key: `${p.corosPlanId}:${p.corosIdInPlan}` }));
    const linked = keys.length
      ? await db
          .select()
          .from(plannedWorkouts)
          .where(and(eq(plannedWorkouts.userId, userId), isNull(plannedWorkouts.archivedAt)))
      : [];
    const bySourceId = new Map(linked.map((w) => [w.sourceWorkoutId, w]));
    const doneWeeks = new Set<number>();
    const pushesByWeek = new Map<number, { total: number; completed: number }>();
    for (const { push, key } of keys) {
      const week = weekIndexOf(planW1, push.corosHappenDay ?? push.happenDay);
      const entry = pushesByWeek.get(week) ?? { total: 0, completed: 0 };
      entry.total += 1;
      if (bySourceId.get(key)?.completionState === "completed") entry.completed += 1;
      pushesByWeek.set(week, entry);
    }
    for (const [week, entry] of pushesByWeek) {
      if (entry.total > 0 && entry.completed === entry.total) doneWeeks.add(week);
    }

    const progressions = liftProgressions(plan, doneWeeks, currentWeek);
    const weeks = Array.from({ length: weekTotal }, (_, i) => ({
      weekStart: addDays(planW1, i * 7),
      index: i + 1,
      state: "firm" as const,
      volumeTarget: null,
      keySessions: [],
      summary: liftWeekSummary(plan, i + 1),
      done: doneWeeks.has(i + 1),
      current: currentWeek === i + 1,
    }));

    const [pushed] = pushes.filter((p) => p.status === "verified").slice(0, 1);
    const duePushes = keys.filter(({ push }) => (push.corosHappenDay ?? push.happenDay) <= today);
    const doneCount = duePushes.filter(({ key }) => bySourceId.get(key)?.completionState === "completed").length;
    return c.json({
      plan: {
        id: sp.id,
        discipline: "lift" as const,
        name: plan.name ?? "Lifting plan",
        status: (pushed ? "active" : "draft") as "active" | "draft",
        startDate: plan.brief.startDate,
        endDate,
        raceDate: null,
        source: "studio" as const,
      },
      weeks,
      progressions,
      sessions: {
        planned: plan.weeks.reduce((s, w) => s + w.sessions.length, 0),
        done: keys.filter(({ key }) => bySourceId.get(key)?.completionState === "completed").length,
      },
      adherencePct: duePushes.length > 0 ? Math.round((doneCount / duePushes.length) * 100) : null,
    });
  }

  return c.json({ error: "not_found" }, 404);
});

coachRoutes.post("/plans/:id/rename", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const { name } = await c.req.json<{ name?: string }>().catch(() => ({ name: undefined }));
  if (!name || name.length > 60) return c.json({ error: "bad_request" }, 400);
  await db
    .update(coachPlans)
    .set({ name, updatedAt: nowInstant() })
    .where(and(eq(coachPlans.id, c.req.param("id")), eq(coachPlans.userId, userId)));
  return c.json({ ok: true });
});

coachRoutes.post("/plans/:id/retire", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const prefs = await loadPreferences(db, userId);
  const applied = await applyOps(db, userId, prefs, `retire-${c.req.param("id")}`, [
    { kind: "retirePlan", planId: c.req.param("id") },
  ]);
  await receipt(db, userId, "Plan retired — completed history stays.");
  return c.json({ ok: true, applied });
});

/** Expiry sweep for the hourly cron (all users handled by the caller). */
export async function sweepUserProposals(db: Db, userId: string, timezone: string): Promise<void> {
  await sweepExpiredProposals(db, userId, todayInZone(timezone)).catch(() => 0);
  // Coached plans past their final day flip to completed, with a receipt
  // carrying the block's adherence (fairness spec §4).
  const today = todayInZone(timezone);
  const ended = await db
    .select()
    .from(coachPlans)
    .where(and(eq(coachPlans.userId, userId), eq(coachPlans.status, "active"), lt(coachPlans.endDate, today)));
  for (const p of ended) {
    await db
      .update(coachPlans)
      .set({ status: "completed", updatedAt: nowInstant() })
      .where(eq(coachPlans.id, p.id));
    const adh = await coachBlockAdherence(db, userId, p.id, p.startDate, p.endDate);
    await receipt(
      db,
      userId,
      `Block complete: ${p.name}${adh !== null ? ` — ${Math.round(adh * 100)}% adherence` : ""}`,
    );
  }
  // Expire lapsed time-boxed memory notes with a receipt (spec §5).
  const lapsed = await db
    .select()
    .from(coachMemory)
    .where(
      and(
        eq(coachMemory.userId, userId),
        eq(coachMemory.active, true),
        lt(coachMemory.expiresAt, addDays(today, 0)),
      ),
    );
  for (const m of lapsed) {
    await db.update(coachMemory).set({ active: false }).where(eq(coachMemory.id, m.id));
    await receipt(db, userId, `Note expired: ${m.body}`);
  }
}
