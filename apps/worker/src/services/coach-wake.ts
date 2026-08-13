import { and, desc, eq, isNull, sql } from "drizzle-orm";
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
import { consumeTriggers, pendingTriggers, recordUnansweredMessage } from "./coach-triggers.js";
import { claimUserLock, releaseUserLock } from "./locks.js";
import { disciplineOf } from "@rg/analytics";

/**
 * One wake = one judgment (spec §§0,3): budget gate → skip-rule → dossier →
 * ONE strong-model call → zod (one repair) → guardrails (one repair) →
 * atomic persistence. Restraint is first-class: an all-empty output that
 * only consumes triggers is a fully successful wake.
 */

export type WakeCause =
  | { kind: "message"; body: string }
  | { kind: "open" }
  | { kind: "manual" }; // user-invoked check-in: never skipped, still budget-gated

export interface WakeResult {
  status: "ok" | "skipped" | "busy" | "resting" | "error";
  coachMessageId?: string;
  proposalIds?: string[];
}

const MAX_OUTPUT_TOKENS_WAKE = 64_000; // a wake may draft a whole plan
const STALE_BRIEFING_HOURS = 20;
/** How long a failed/resting wake counts as "already tried" for the "open"
 * skip rule (audit C4/C14): without this, an "open" cause never sees a
 * role='coach' message while the LLM is down, so wakeAdvised stays true and
 * every Plan visit re-fires (and re-fails) the wake. */
export const WAKE_FAILURE_BACKOFF_MINUTES = 30;

/** A complete, schema-valid example output — embedded in the prompt AND
 * parsed in a test (coach-wake.test.ts) so prompt and schema can never
 * drift apart. Complex ops (add/createPlan sessions) are where live wakes
 * kept failing validation (2026-08-12). */
export const WAKE_EXAMPLE_OUTPUT = JSON.stringify({
  briefing: "Adding a taper shakeout Friday and a recovery block after the race.",
  proposals: [
    {
      title: "Shakeout before race day",
      evidence: "race in 2 days · 7d load 1.1× base",
      rationale: "20 easy minutes with 4 strides keeps legs alive without cost.",
      expiresAt: "2026-10-22",
      flags: [],
      ops: [
        {
          kind: "add",
          date: "2026-10-22",
          session: {
            category: "easy",
            title: "Race-week shakeout",
            durationMinutes: 25,
            run: {
              blocks: [
                { kind: "duration", value: 10, intensity: "easy" },
                { kind: "duration", value: 10, intensity: "steady" },
                { kind: "duration", value: 5, intensity: "easy" },
              ],
            },
          },
        },
      ],
    },
  ],
  question: null,
  memoryOps: [],
  focus: "Race week: everything easy except Saturday's shakeout strides.",
});

/** A second drift-tested example: createPlan is the op live wakes failed on
 * three times (2026-08-12/13) — models must see its exact working shape. */
export const WAKE_EXAMPLE_CREATE_PLAN = JSON.stringify({
  briefing: "Drafting the post-race recovery block as a proposal.",
  proposals: [
    {
      title: "4-week post-race block",
      evidence: "race 2026-10-23 · plan ends 2026-10-03",
      rationale: "One true recovery week written out; three sketched to shape after the race.",
      expiresAt: "2026-10-25",
      flags: [],
      ops: [
        {
          kind: "createPlan",
          discipline: "run",
          name: "Post-race recovery block",
          startDate: "2026-10-24",
          endDate: "2026-11-20",
          raceDate: null,
          firmSessions: [
            {
              date: "2026-10-26",
              session: {
                category: "recovery",
                title: "Legs-back jog",
                durationMinutes: 25,
                run: { blocks: [{ kind: "duration", value: 25, intensity: "easy" }] },
              },
            },
          ],
          shapeWeeks: [
            {
              weekStart: "2026-11-02",
              volumeTarget: "rebuild easy volume",
              keySessions: ["one long run", "strides midweek"],
            },
          ],
        },
      ],
    },
  ],
  question: null,
  memoryOps: [],
  focus: null,
});

export const WAKE_SYSTEM_PROMPT = `You are the athlete's running and lifting coach inside Run Garden. You read one dossier and reply with ONE JSON object — nothing else.

Your contract:
- PROPOSE, never act. Every plan change you want is a proposal the athlete taps to approve. Nothing you say changes anything by itself.
- SCOPE — you can fulfil essentially any plan request, and you must never claim otherwise:
  · ease/move/skip/swap work on ANY session in UPCOMING or LAST 14 DAYS via its [wo:...] id, imported COROS sessions included. Approved moves of imported sessions ARE written to the watch and verified.
  · add creates a new session on any date. Approved run sessions built from DURATION blocks are written to the athlete's COROS watch and verified; distance-block runs and lift adds land on the app calendar + Google Calendar only (mention that only when it matters).
  · Imported/studio plan STRUCTURE is edited by COMPOSITION: skip or move its sessions and add your own around them. "Extend the plan" = add sessions (or createPlan a coached block) after it ends; "add a taper" = ease/skip its final sessions and add what's missing. reshapeWeek/firmUp/extendPlan/windDown/retirePlan additionally work on plans you authored.
  · NEVER say a plan is read-only or that you can't restructure it — describe the composition you propose instead.
- RESTRAINT IS A COMPLETE ANSWER. Propose only when a change genuinely beats the current plan. Acknowledging a missed workout kindly, or saying nothing (briefing: null), is often correct. Never invent work for yourself.
- NEVER ask what the dossier's ATHLETE section already answers, and never repeat a question listed in OPEN ITEMS. At most ONE question, only when the answer would change your coaching, with short tappable chips.
- MEMORY: when the athlete tells you something durable, record it via memoryOps (kind: fact = who they are, rule = a standing preference, note = time-boxed, with expiresAt). Prefer update over add for near-duplicates; ids are in the dossier.
- FLAGS: if a proposal goes against a standing rule, say so in its flags array ("moves your Saturday long run"). Hard safety limits (weekly ramp >10%, hard sessions back-to-back, race-week intensity, editing the past) are enforced outside you — stay inside them.
- EVIDENCE: every proposal's evidence cites dossier data ("slept 5h avg · HRV −9%"), and expiresAt is min(end of first affected day, +3 days).
- GARDEN VOICE: MILESTONES carries the garden's state. AT MOST ONE garden reference per briefing, always tied to a concrete action ("an easy 30 tomorrow brings the rain back"), never guilt. Say nothing about the garden during rest mode or taper, or when its forecast stage is already a loss stage — one loss voice at a time.
- SKIP TREATMENT: when proposing a skip, state in the rationale what the garden will see: the first sanctioned skip in a rolling week counts as a genuine rest day; further ones are merely neutral. OPEN ITEMS shows current mercy usage.
- VOICE: brief, warm, specific. A coach, not an app. No headers, no bullet-point walls in briefings; 1–4 sentences unless the athlete asked for detail.

- FOCUS: one sentence (≤160 chars) naming the week's anchor and at most one adjustment — the plan page shows it as "the coach's line". null when you have nothing genuinely useful to say.

Output JSON exactly matching:
{"briefing": string|null, "proposals": [{"title","evidence","rationale","expiresAt","flags":[],"ops":[...]}], "question": {"text","chips":[]}|null, "memoryOps": [...], "focus": string|null}

Op kinds: ease{workoutId,session} · move{workoutId,toDate} · swap{dayA,dayB} · skip{workoutId,reason} · add{date,session} · reshapeWeek{planId,weekStart,sessions} · firmUp{planId,weekStart,sessions} · extendPlan{planId,shapeWeeks} · windDown{planId,sessions} · createPlan{discipline,name,startDate,endDate,raceDate?,firmSessions,shapeWeeks} · retirePlan{planId}
A session is {category, title, durationMinutes, run?: {blocks:[{kind:"duration"|"distance", value, intensity?}]}, lift?: {exercises:[...]}} — runs use minutes (duration) / meters (distance) blocks; lifts use catalog exercises. Block values are INTEGERS; intensity ∈ easy|steady|threshold|interval|rest. shapeWeeks volumeTarget stays under ~6 words. Match these examples' shapes EXACTLY:
${WAKE_EXAMPLE_OUTPUT}
${WAKE_EXAMPLE_CREATE_PLAN}`;



async function persistMessage(
  db: Db,
  userId: string,
  role: "coach" | "user" | "receipt",
  body: string,
  refs: {
    proposalId?: string;
    memoryIds?: string[];
    questionId?: string;
    wakeFailure?: boolean;
    focus?: string;
  } = {},
): Promise<string> {
  const id = newId();
  await db.insert(coachMessages).values({ id, userId, role, body, refs, at: nowInstant() });
  return id;
}


/**
 * Persist a wake-failure receipt ("couldn't think" / "resting"), but never
 * as a duplicate of the thread's newest WAKE-FAILURE row (audit C4/C14
 * residual): while the LLM gateway is down, every "open" wake used to
 * append an identical row forever. Compares against the newest failure
 * specifically — not the newest row of any kind — so an unrelated receipt
 * landing in between (e.g. the expiry sweep's "Expired: …" line, or a
 * "Superseded: …" receipt) doesn't defeat the dedupe. Marked `wakeFailure`
 * so `openWakeIsFresh` can back off retries without depending on exact copy.
 */
async function persistWakeFailure(db: Db, userId: string, body: string): Promise<void> {
  const [latest] = await db
    .select()
    .from(coachMessages)
    .where(
      and(
        eq(coachMessages.userId, userId),
        eq(coachMessages.role, "receipt"),
        sql`json_extract(${coachMessages.refs}, '$.wakeFailure') = 1`,
      ),
    )
    .orderBy(desc(coachMessages.at))
    .limit(1);
  if (latest && latest.body === body) return; // already showing this failure
  await persistMessage(db, userId, "receipt", body, { wakeFailure: true });
}

/**
 * Whether a wake failed/rested recently enough that another "open" attempt
 * would just repeat it. This is checked BEFORE triggers (audit C14
 * residual): `consumeTriggers` only runs on a successful wake, so a
 * pending trigger stays pending through every failure — without gating on
 * this first, a single missed-workout trigger during an LLM outage forced
 * every single Plan visit to attempt (and burn) another LLM call, exactly
 * the harm the backoff was meant to prevent.
 */
async function recentWakeFailure(db: Db, userId: string): Promise<boolean> {
  const [lastFailure] = await db
    .select()
    .from(coachMessages)
    .where(
      and(
        eq(coachMessages.userId, userId),
        eq(coachMessages.role, "receipt"),
        sql`json_extract(${coachMessages.refs}, '$.wakeFailure') = 1`,
      ),
    )
    .orderBy(desc(coachMessages.at))
    .limit(1);
  return (
    !!lastFailure &&
    Date.parse(nowInstant()) - Date.parse(lastFailure.at) < WAKE_FAILURE_BACKOFF_MINUTES * 60 * 1000
  );
}

/** Whether the last coach briefing is still fresh enough that an "open"
 * wake with no new trigger would be redundant. Filters out legacy per-effort
 * analyses (refs.kind='analysis') — an ambient read is not a briefing, and
 * counting it silently muted the coach for 20h after every read. */
async function freshBriefing(db: Db, userId: string): Promise<boolean> {
  const [lastCoach] = await db
    .select()
    .from(coachMessages)
    .where(
      and(
        eq(coachMessages.userId, userId),
        eq(coachMessages.role, "coach"),
        sql`json_extract(${coachMessages.refs}, '$.kind') IS NULL`,
      ),
    )
    .orderBy(desc(coachMessages.at))
    .limit(1);
  return (
    !!lastCoach && Date.parse(nowInstant()) - Date.parse(lastCoach.at) < STALE_BRIEFING_HOURS * 3600 * 1000
  );
}

/**
 * Whether an "open" (auto) wake would be redundant right now (audit
 * C4/C14). A recent failure/rest wins over everything, INCLUDING pending
 * triggers — the whole point of the backoff is to stop retrying while the
 * coach just failed, and a trigger alone doesn't get to override that (it
 * stays unconsumed until a wake actually succeeds, so ungating it here
 * would mean the backoff never actually applies whenever anything is
 * pending — the common case during an outage). Short of a recent failure,
 * a pending trigger always makes a wake worth attempting; with no trigger,
 * a fresh existing briefing makes it redundant. Shared by the internal
 * "open" skip rule below and the `wakeAdvised` the client uses to decide
 * whether to bother calling wake at all.
 */
export async function openWakeIsFresh(db: Db, userId: string, triggerCount: number): Promise<boolean> {
  if (await recentWakeFailure(db, userId)) return true;
  if (triggerCount > 0) return false;
  return freshBriefing(db, userId);
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
        const arr = (weekly[w.discipline] ??= [0, 0, 0, 0]);
        arr[4 - k] = (arr[4 - k] ?? 0) + w.durationMinutes;
      }
    }
  }
  // Every coach-authored plan id regardless of status — H7's authorship test.
  const plans = await db.select().from(coachPlans).where(eq(coachPlans.userId, userId));
  const coachPlanIds = plans.map((p) => p.id);
  const raceDates = plans
    .filter((p) => p.status === "active")
    .map((p) => p.raceDate)
    .filter((d): d is string => !!d);
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
  return { today, workouts, weeklyMinutesByDiscipline: weekly, raceDates, firmHorizonEnd, rules, coachPlanIds };
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
  // The athlete's words are never lost — persist before anything can fail,
  // and mark the message as awaiting a reply. The marker is a pending
  // trigger consumed only by a successful wake: if THIS request dies
  // mid-call, the next open picks the reply up (user requirement:
  // navigating away must not lose the coach's answer).
  if (cause.kind === "message") {
    await persistMessage(db, userId, "user", cause.body);
    await recordUnansweredMessage(db, userId, cause.body);
  }

  const budget = await llmBudgetStatus(db, userId);
  if (budget.cutoff) {
    await persistWakeFailure(db, userId, "The coach is resting (weekly budget reached) — manual controls all work.");
    return { status: "resting" };
  }

  const triggers = await pendingTriggers(db, userId);
  if (cause.kind === "open") {
    if (await openWakeIsFresh(db, userId, triggers.length)) return { status: "skipped" };
  }

  // Single-flight (rework spec R2): claimed AFTER the cheap gates so quiet
  // opens never touch the lock, and AFTER the user's words are persisted so
  // a lost race can't drop them. A MESSAGE deserves a reply, though — the
  // user is watching (audit finding 16): wait out the holder for up to a
  // minute before giving up with an honest "busy" the client can surface.
  let lock = await claimUserLock(db, userId, "wake");
  if (!lock && cause.kind === "message") {
    for (let i = 0; i < 12 && !lock; i++) {
      await new Promise((r) => setTimeout(r, 5_000));
      lock = await claimUserLock(db, userId, "wake");
    }
  }
  if (!lock) return { status: cause.kind === "message" ? "busy" : "skipped" };

  try {
    const dossier = await buildDossier(db, userId, prefs);
    const causeBlock =
      cause.kind === "message"
        ? `The athlete just said:\n"""${cause.body}"""`
        : cause.kind === "manual"
          ? `The athlete pressed "Check in" — they want your read RIGHT NOW. Give a short, concrete briefing of where they stand today; propose only if genuinely warranted.`
          : `The athlete opened the plan page. Address pending SIGNALS if any; otherwise a short check-in or nothing.`;
    type ChatMsg = { role: "system" | "user" | "assistant"; content: string };
    const messages: ChatMsg[] = [
      { role: "system", content: WAKE_SYSTEM_PROMPT },
      { role: "user", content: `${dossier.text}\n\n---\n${causeBlock}\nToday is ${today}.` },
    ];
    const model = env.AI_STUDIO_MODEL_STRONG || DEFAULT_MODEL_STRONG;

    const attemptParse = async (
      msgs: ChatMsg[],
    ): Promise<{ out: WakeOutput | null; raw: string; issues: string }> => {
      const chat = await chatCompletion(env, fetchImpl, model, MAX_OUTPUT_TOKENS_WAKE, msgs);
      if (!chat.ok) {
        console.error(`[coach-wake] gateway failure: ${chat.reason}`);
        return { out: null, raw: "", issues: "" };
      }
      await recordUsage(db, userId, "coach_wake", model, "strong", chat, `wake:${userId}:${nowInstant()}`);
      const json = extractJson(chat.content);
      const parsed = wakeOutputSchema.safeParse(json);
      if (parsed.success) return { out: parsed.data, raw: chat.content, issues: "" };
      // The repair prompt needs the actual issues — "didn't match" alone
      // reproduces the same mistake (live-observed: two wakes, four calls,
      // zero corrections). Also logged so `wrangler tail` shows ground truth.
      const issues =
        json == null
          ? "no JSON object found in the reply"
          : parsed.error.issues
              .slice(0, 8)
              .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
              .join("\n");
      console.error(
        `[coach-wake] schema reject: ${issues.replaceAll("\n", " | ")} · raw head: ${chat.content.slice(0, 1200)}`,
      );
      return { out: null, raw: chat.content, issues };
    };

    let { out, raw, issues } = await attemptParse(messages);
    if (!out && !raw) {
      // Gateway/transport failure (nothing came back) — transient more often
      // than not; one retry before giving up ("the coach never errors" work,
      // 2026-08-12).
      await new Promise((r) => setTimeout(r, 2_000));
      ({ out, raw, issues } = await attemptParse(messages));
    }
    if (!out && raw) {
      ({ out } = await attemptParse([
        ...messages,
        { role: "assistant" as const, content: raw },
        {
          role: "user" as const,
          content: `That did not match the required JSON schema. Problems:\n${issues}\nReply with ONLY the corrected JSON object — same content, valid shape.`,
        },
      ]));
    }
    if (!out && raw) {
      // Salvage: the model twice produced JSON that misses the full schema —
      // usually complex plan ops. The BRIEFING prose is almost always intact;
      // losing it to a "couldn't think" receipt threw away a good answer
      // (live case: the plan-extension ask, 2026-08-12). Keep the words, drop
      // the malformed structure, and say so.
      const loose = extractJson(raw) as { briefing?: unknown } | null;
      const briefing = typeof loose?.briefing === "string" ? loose.briefing.trim() : "";
      if (briefing.length > 0) {
        const coachMessageId = await persistMessage(db, userId, "coach", briefing);
        await persistMessage(
          db,
          userId,
          "receipt",
          "The plan changes the coach drafted alongside this couldn't be formatted — ask again (smaller steps help) and it will draft them as proposals.",
          // Diagnosability: the zod issues ride the receipt's refs — three
          // live failures were unexplainable post-hoc without a running tail.
          { schemaIssues: issues.slice(0, 500) } as never,
        );
        await consumeTriggers(db, userId, triggers.map((t) => t.id), nowInstant());
        return { status: "ok", coachMessageId };
      }
    }
    if (!out) {
      await persistWakeFailure(db, userId, "The coach couldn't think just now — try again in a moment.");
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

    // A message-cause wake CLOSES any open question (audit finding 9): the
    // user replied in prose — the coach saw the question in its dossier and
    // captured whatever answer arrived via memoryOps. Before this, only the
    // chip endpoint could close a question, so one free-text reply pinned
    // the chips forever and hasOpen blocked every future question.
    if (cause.kind === "message") {
      await db
        .update(coachQuestions)
        .set({ answeredAt: now })
        .where(and(eq(coachQuestions.userId, userId), isNull(coachQuestions.answeredAt)));
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
        focus: out.focus ?? undefined,
      });
    }

    await consumeTriggers(db, userId, triggers.map((t) => t.id), now);
    return { status: "ok", coachMessageId, proposalIds };
  } catch {
    await persistWakeFailure(db, userId, "The coach couldn't think just now — try again in a moment.");
    return { status: "error" };
  } finally {
    await releaseUserLock(db, userId, "wake", lock).catch(() => undefined);
  }
}
