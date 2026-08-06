import { Hono } from "hono";
import { and, desc, eq, isNull, lt } from "drizzle-orm";
import {
  coachMemory,
  coachMessages,
  coachPlans,
  coachProposals,
  coachQuestions,
} from "@rg/database";
import { addDays, newId, nowInstant, todayInZone, type CoachOp } from "@rg/domain";
import type { AppContext } from "../auth/middleware.js";
import { requireUser } from "../auth/middleware.js";
import { loadPreferences } from "../services/calendar-sync.js";
import { applyOps } from "../services/coach-apply.js";
import { evaluateTriggers, pendingTriggers } from "../services/coach-triggers.js";
import { coachBlockAdherence, plansEndedOn } from "../services/coach-plans.js";
import { wake } from "../services/coach-wake.js";
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
  const staleBriefing =
    !lastCoach || Date.parse(nowInstant()) - Date.parse(lastCoach.at) > 20 * 3600 * 1000;

  return c.json({
    messages: [...msgs].reverse(),
    pendingProposals: pending,
    openQuestion: openQuestion ?? null,
    memoryCount: memoryRows.length,
    lastCoachAt: lastCoach?.at ?? null,
    wakeAdvised: triggers.length > 0 || staleBriefing,
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
  return c.json({ plans: rows });
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
