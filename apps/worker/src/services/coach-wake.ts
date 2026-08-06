import { and, desc, eq } from "drizzle-orm";
import {
  coachMemory,
  coachMessages,
  coachPlans,
  coachProposals,
  coachQuestions,
  plannedWorkouts,
} from "@rg/database";
import {
  addDays,
  newId,
  nowInstant,
  todayInZone,
  wakeOutputSchema,
  validateOps,
  type CoachOp,
  type GuardrailCtx,
  type UserPreferences,
  type WakeOutput,
} from "@rg/domain";
import type { Env } from "../env.js";
import type { Db } from "./db.js";
import { llmBudgetStatus } from "./llm.js";
import {
  chatCompletion,
  DEFAULT_MODEL_STRONG,
  extractJson,
  recordUsage,
} from "./studio-llm.js";
import { buildDossier } from "./coach-context.js";
import { consumeTriggers, pendingTriggers } from "./coach-triggers.js";
import { disciplineOf } from "@rg/analytics";

/**
 * One wake = one judgment (spec §§0,3): budget gate → skip-rule → dossier →
 * ONE strong-model call → zod (one repair) → guardrails (one repair) →
 * atomic persistence. Restraint is first-class: an all-empty output that
 * only consumes triggers is a fully successful wake.
 */

export type WakeCause = { kind: "message"; body: string } | { kind: "open" };

export interface WakeResult {
  status: "ok" | "skipped" | "resting" | "error";
  coachMessageId?: string;
  proposalIds?: string[];
}

const MAX_OUTPUT_TOKENS_WAKE = 64_000; // a wake may draft a whole plan
const STALE_BRIEFING_HOURS = 20;

export const WAKE_SYSTEM_PROMPT = `You are the athlete's running and lifting coach inside Run Garden. You read one dossier and reply with ONE JSON object — nothing else.

Your contract:
- PROPOSE, never act. Every plan change you want is a proposal the athlete taps to approve. Nothing you say changes anything by itself.
- RESTRAINT IS A COMPLETE ANSWER. Propose only when a change genuinely beats the current plan. Acknowledging a missed workout kindly, or saying nothing (briefing: null), is often correct. Never invent work for yourself.
- NEVER ask what the dossier's ATHLETE section already answers, and never repeat a question listed in OPEN ITEMS. At most ONE question, only when the answer would change your coaching, with short tappable chips.
- MEMORY: when the athlete tells you something durable, record it via memoryOps (kind: fact = who they are, rule = a standing preference, note = time-boxed, with expiresAt). Prefer update over add for near-duplicates; ids are in the dossier.
- FLAGS: if a proposal goes against a standing rule, say so in its flags array ("moves your Saturday long run"). Hard safety limits (weekly ramp >10%, hard sessions back-to-back, race-week intensity, editing the past) are enforced outside you — stay inside them.
- EVIDENCE: every proposal's evidence cites dossier data ("slept 5h avg · HRV −9%"), and expiresAt is min(end of first affected day, +3 days).
- VOICE: brief, warm, specific. A coach, not an app. No headers, no bullet-point walls in briefings; 1–4 sentences unless the athlete asked for detail.

Output JSON exactly matching:
{"briefing": string|null, "proposals": [{"title","evidence","rationale","expiresAt","flags":[],"ops":[...]}], "question": {"text","chips":[]}|null, "memoryOps": [...]}

Op kinds: ease{workoutId,session} · move{workoutId,toDate} · swap{dayA,dayB} · skip{workoutId,reason} · add{date,session} · reshapeWeek{planId,weekStart,sessions} · firmUp{planId,weekStart,sessions} · extendPlan{planId,shapeWeeks} · windDown{planId,sessions} · createPlan{discipline,name,startDate,endDate,raceDate?,firmSessions,shapeWeeks} · retirePlan{planId}
A session is {category, title, durationMinutes, run?: {blocks:[{kind:"duration"|"distance", value, intensity?}]}, lift?: {exercises:[...]}} — runs use minutes/meters blocks; lifts use catalog exercises.`;

async function persistMessage(
  db: Db,
  userId: string,
  role: "coach" | "user" | "receipt",
  body: string,
  refs: { proposalId?: string; memoryIds?: string[]; questionId?: string } = {},
): Promise<string> {
  const id = newId();
  await db.insert(coachMessages).values({ id, userId, role, body, refs, at: nowInstant() });
  return id;
}

/** Dates an op touches — for supersede matching. */
function opAffectedDates(op: CoachOp, workoutDates: Map<string, string>): string[] {
  switch (op.kind) {
    case "ease":
    case "skip":
      return [workoutDates.get(op.workoutId) ?? ""].filter(Boolean);
    case "move":
      return [workoutDates.get(op.workoutId) ?? "", op.toDate].filter(Boolean);
    case "swap":
      return [op.dayA, op.dayB];
    case "add":
      return [op.date];
    case "reshapeWeek":
    case "firmUp":
    case "windDown":
      return op.sessions.map((s) => s.date);
    case "createPlan":
      return op.firmSessions.map((s) => s.date);
    default:
      return [];
  }
}

async function guardrailCtx(
  db: Db,
  userId: string,
  prefs: UserPreferences,
): Promise<GuardrailCtx> {
  const today = todayInZone(prefs.timezone);
  const horizon = addDays(today, 60);
  const rows = await db
    .select()
    .from(plannedWorkouts)
    .where(and(eq(plannedWorkouts.userId, userId)));
  const workouts = rows
    .filter((w) => w.effectiveDate >= addDays(today, -35) && w.effectiveDate <= horizon)
    .map((w) => ({
      id: w.id,
      date: w.effectiveDate,
      category: w.category,
      completionState: w.completionState,
      durationMinutes: Math.round((w.calendarBlockDurationSeconds ?? 3600) / 60),
      discipline: disciplineOf(w.category, w.sport) as "run" | "strength" | "yoga",
    }));
  // Trailing 4 completed weeks of minutes per discipline.
  const weekly: Record<string, number[]> = {};
  for (let k = 4; k >= 1; k--) {
    const start = addDays(today, -7 * k);
    const end = addDays(start, 6);
    for (const w of workouts) {
      if (w.date >= start && w.date <= end && w.completionState === "completed" && w.category !== "rest") {
        (weekly[w.discipline] ??= [0, 0, 0, 0])[4 - k] += w.durationMinutes;
      }
    }
  }
  const plans = await db
    .select()
    .from(coachPlans)
    .where(and(eq(coachPlans.userId, userId), eq(coachPlans.status, "active")));
  const raceDates = plans.map((p) => p.raceDate).filter((d): d is string => !!d);
  // Firm horizon: latest scheduled workout date (imported or coached) —
  // beyond it only the structured ops may reach.
  const firmHorizonEnd =
    workouts
      .filter((w) => w.date >= today)
      .map((w) => w.date)
      .sort()
      .at(-1) ?? today;
  const rules = (
    await db
      .select()
      .from(coachMemory)
      .where(and(eq(coachMemory.userId, userId), eq(coachMemory.kind, "rule"), eq(coachMemory.active, true)))
  ).flatMap((r) => {
    // Structured matchers for the two v1 rule shapes; prose rules stay
    // model-flagged only.
    const m = r.body.toLowerCase().match(/(long|quality|easy|recovery|strength)[^]*?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)/);
    if (!m) return [];
    const weekday = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"].indexOf(m[2]!) + 1;
    return [{ id: r.id, kind: "anchor_day" as const, category: m[1]!, weekday }];
  });
  return { today, workouts, weeklyMinutesByDiscipline: weekly, raceDates, firmHorizonEnd, rules };
}

export async function wake(
  db: Db,
  env: Env,
  userId: string,
  prefs: UserPreferences,
  cause: WakeCause,
  fetchImpl: typeof fetch = fetch,
): Promise<WakeResult> {
  const today = todayInZone(prefs.timezone);
  // The athlete's words are never lost — persist before anything can fail.
  if (cause.kind === "message") await persistMessage(db, userId, "user", cause.body);

  const budget = await llmBudgetStatus(db, userId);
  if (budget.cutoff) {
    await persistMessage(db, userId, "receipt", "The coach is resting (weekly budget reached) — manual controls all work.");
    return { status: "resting" };
  }

  const triggers = await pendingTriggers(db, userId);
  if (cause.kind === "open") {
    const [lastCoach] = await db
      .select()
      .from(coachMessages)
      .where(and(eq(coachMessages.userId, userId), eq(coachMessages.role, "coach")))
      .orderBy(desc(coachMessages.at))
      .limit(1);
    const fresh =
      lastCoach && Date.parse(nowInstant()) - Date.parse(lastCoach.at) < STALE_BRIEFING_HOURS * 3600 * 1000;
    if (triggers.length === 0 && fresh) return { status: "skipped" };
  }

  try {
    const dossier = await buildDossier(db, userId, prefs);
    const causeBlock =
      cause.kind === "message"
        ? `The athlete just said:\n"""${cause.body}"""`
        : `The athlete opened the plan page. Address pending SIGNALS if any; otherwise a short check-in or nothing.`;
    const messages = [
      { role: "system" as const, content: WAKE_SYSTEM_PROMPT },
      { role: "user" as const, content: `${dossier.text}\n\n---\n${causeBlock}\nToday is ${today}.` },
    ];
    const model = env.AI_STUDIO_MODEL_STRONG || DEFAULT_MODEL_STRONG;

    const attemptParse = async (msgs: typeof messages): Promise<{ out: WakeOutput | null; raw: string }> => {
      const chat = await chatCompletion(env, fetchImpl, model, MAX_OUTPUT_TOKENS_WAKE, msgs);
      if (!chat.ok) return { out: null, raw: "" };
      await recordUsage(db, userId, "coach_wake", model, "strong", chat, `wake:${userId}:${nowInstant()}`);
      const parsed = wakeOutputSchema.safeParse(extractJson(chat.content));
      return { out: parsed.success ? parsed.data : null, raw: chat.content };
    };

    let { out, raw } = await attemptParse(messages);
    if (!out && raw) {
      ({ out } = await attemptParse([
        ...messages,
        { role: "assistant" as const, content: raw },
        { role: "user" as const, content: "That did not match the required JSON schema. Reply with ONLY the corrected JSON object." },
      ]));
    }
    if (!out) {
      await persistMessage(db, userId, "receipt", "The coach couldn't think just now — try again in a moment.");
      return { status: "error" };
    }

    // Guardrails: hard violations get one repair round-trip, then drop.
    const ctx = await guardrailCtx(db, userId, prefs);
    let proposals = out.proposals;
    const violated = proposals
      .map((p, i) => ({ i, v: validateOps(p.ops, ctx) }))
      .filter((x) => x.v.hard.length > 0);
    if (violated.length > 0) {
      const detail = violated
        .map((x) => `proposal ${x.i} ("${proposals[x.i]!.title}"): ${x.v.hard.map((h) => `${h.rule} — ${h.detail}`).join("; ")}`)
        .join("\n");
      const repair = await attemptParse([
        ...messages,
        { role: "assistant" as const, content: JSON.stringify(out) },
        { role: "user" as const, content: `These proposals violate hard safety rules and were rejected:\n${detail}\nReply with ONLY the corrected full JSON (fix or drop the violating proposals; keep everything else).` },
      ]);
      if (repair.out) {
        out = repair.out;
        proposals = out.proposals;
      }
      const stillBad = new Set(
        proposals
          .map((p, i) => ({ i, v: validateOps(p.ops, ctx) }))
          .filter((x) => x.v.hard.length > 0)
          .map((x) => x.i),
      );
      proposals = proposals.filter((_, i) => !stillBad.has(i));
    }

    // Union validator-found soft flags into each surviving proposal.
    const workoutDates = new Map(ctx.workouts.map((w) => [w.id, w.date]));
    const now = nowInstant();
    const proposalIds: string[] = [];
    for (const p of proposals) {
      const soft = validateOps(p.ops, ctx).soft;
      const ruleBodies = new Map(
        (await db.select().from(coachMemory).where(eq(coachMemory.userId, userId))).map((r) => [r.id, r.body]),
      );
      const flags = [...new Set([...p.flags, ...soft.map((v) => ruleBodies.get(v.rule) ?? v.rule)])];

      // Supersede: at most one live proposal per affected day.
      const affected = new Set(p.ops.flatMap((op) => opAffectedDates(op, workoutDates)));
      const live = await db
        .select()
        .from(coachProposals)
        .where(and(eq(coachProposals.userId, userId), eq(coachProposals.status, "pending")));
      const id = newId();
      for (const old of live) {
        const oldAffected = (old.ops as CoachOp[]).flatMap((op) => opAffectedDates(op, workoutDates));
        if (oldAffected.some((d) => affected.has(d))) {
          await db
            .update(coachProposals)
            .set({ status: "superseded", resolvedAt: now, supersededBy: id })
            .where(eq(coachProposals.id, old.id));
          await persistMessage(db, userId, "receipt", `Superseded: ${old.title}`, { proposalId: old.id });
        }
      }
      const firstDay = [...affected].sort()[0];
      const cappedExpiry = [p.expiresAt, firstDay ?? p.expiresAt, addDays(today, 3)].sort()[0]!;
      await db.insert(coachProposals).values({
        id,
        userId,
        planId: null,
        title: p.title,
        evidence: p.evidence,
        rationale: p.rationale,
        flags,
        ops: p.ops,
        status: "pending",
        createdAt: now,
        expiresAt: cappedExpiry < today ? today : cappedExpiry,
      });
      proposalIds.push(id);
    }

    // Memory ops — user deletions are never resurrected (update/expire of a
    // missing id is a no-op).
    const memoryIds: string[] = [];
    for (const m of out.memoryOps) {
      if (m.op === "add") {
        const id = newId();
        await db.insert(coachMemory).values({
          id,
          userId,
          kind: m.kind,
          body: m.text,
          provenance: { source: cause.kind, at: now },
          learnedAt: now,
          expiresAt: m.expiresAt ?? null,
          active: true,
        });
        memoryIds.push(id);
      } else if (m.op === "update") {
        await db.update(coachMemory).set({ body: m.text }).where(and(eq(coachMemory.id, m.id), eq(coachMemory.userId, userId)));
        memoryIds.push(m.id);
      } else {
        await db.update(coachMemory).set({ active: false }).where(and(eq(coachMemory.id, m.id), eq(coachMemory.userId, userId)));
      }
    }

    // Question: at most one open; exact-duplicate defense.
    let questionId: string | undefined;
    if (out.question) {
      const open = await db
        .select()
        .from(coachQuestions)
        .where(and(eq(coachQuestions.userId, userId)));
      const hasOpen = open.some((q) => q.answeredAt === null);
      const dup = open.some((q) => q.body.trim().toLowerCase() === out!.question!.text.trim().toLowerCase());
      if (!hasOpen && !dup) {
        questionId = newId();
        await db.insert(coachQuestions).values({
          id: questionId,
          userId,
          body: out.question.text,
          chips: out.question.chips,
          askedAt: now,
        });
      }
    }

    let coachMessageId: string | undefined;
    if (out.briefing) {
      coachMessageId = await persistMessage(db, userId, "coach", out.briefing, {
        memoryIds: memoryIds.length ? memoryIds : undefined,
        questionId,
      });
    }

    await consumeTriggers(db, userId, triggers.map((t) => t.id), now);
    return { status: "ok", coachMessageId, proposalIds };
  } catch {
    await persistMessage(db, userId, "receipt", "The coach couldn't think just now — try again in a moment.");
    return { status: "error" };
  }
}
