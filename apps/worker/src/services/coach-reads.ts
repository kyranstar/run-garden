import { and, desc, eq, lte } from "drizzle-orm";
import { activities, coachReads } from "@rg/database";
import { addDays, newId, nowInstant, type LocalDate, type UserPreferences } from "@rg/domain";
import { z } from "zod";
import type { Env } from "../env.js";
import { fixtureModeEnabled } from "../env.js";
import type { Db } from "./db.js";
import { llmBudgetStatus } from "./llm.js";
import { chatCompletion, DEFAULT_MODEL_STRONG, extractJson, recordUsage } from "./studio-llm.js";
import { buildEffortPackage } from "./coach-effort.js";

/**
 * The perception layer (rework spec §1): every activity gets exactly one
 * ambient LLM read. Exactly-once is structural, not hopeful — a unique
 * (user, activity) row, an atomic claim-token handoff, and token-guarded
 * completion. Two racers can both SELECT the same queued row; only the one
 * whose token survives the conditional UPDATE calls the model.
 */

export const AUTO_READ_RESERVE_MICROS = 12_000_000; // auto-reads stop at $12; interactive keeps $8 headroom
export const READ_MAX_ATTEMPTS = 5;
export const READ_RECLAIM_MINUTES = 10;
export const READ_WINDOW_DAYS = 14;
export const BACKFILL_DIGEST_MIN = 5;
const MAX_OUTPUT_TOKENS_READ = 8_000;

export const READ_SYSTEM_PROMPT = `You are the athlete's coach, reading ONE completed effort. Reply with ONE JSON object, nothing else:
{"glance": string, "body": string, "flags": string[]}
- glance: ≤90 characters, one observation a tired athlete absorbs at a glance. An observation, not a grade ("HR drifted 6% late — fueling, not fitness").
- body: the full read, ≤180 words, plain prose. Same honesty rules as always: never invent data; conditions before conclusions; a rough day gets context, never judgment; close with one earned, specific encouragement.
- flags: zero or more of "hr_drift","strain_high","breakthrough","pace_regression","fueling","comeback". Empty array when nothing stands out. A flag means "the coach should mention this at the next briefing" — be sparing.`;

export const DIGEST_SYSTEM_PROMPT = `You are the athlete's coach, reading a SUMMARY of their imported training history (a backfill just landed). Reply with ONE JSON object, nothing else:
{"glance": string, "body": string, "flags": []}
- glance: ≤90 characters — the one thing this history says about them.
- body: ≤180 words on what their history shows: consistency patterns, range, anything worth carrying into coaching. Never invent data; observations, not grades.
- flags: always [] for a digest.`;

const readOutputSchema = z.object({
  glance: z
    .string()
    .min(1)
    .transform((s) => (s.length > 90 ? `${s.slice(0, 89)}…` : s)),
  body: z.string().min(1),
  flags: z
    .array(z.enum(["hr_drift", "strain_high", "breakthrough", "pace_regression", "fueling", "comeback"]))
    .max(6)
    .default([]),
});

export type ReadGateReason = "fixture" | "no_key" | "ai_disabled" | "budget_reserve";

export interface ReadRow {
  id: string;
  glance: string;
  body: string;
  flags: string[];
  at: string;
}

export interface ReadResult {
  status: "done" | "working" | "resting" | "error" | "not_found" | "ai_disabled";
  read?: ReadRow;
  cached?: boolean;
}

function localDateOf(a: { startTime: string; startTimeLocal: string | null }): string {
  return (a.startTimeLocal ?? a.startTime).slice(0, 10);
}

/** Insert-or-ignore queued rows for un-read activities inside the auto-read
 * window. Re-running is free: the unique index makes it a no-op. */
export async function enqueueCoachReads(db: Db, userId: string, today: LocalDate): Promise<number> {
  const cutoff = addDays(today, -READ_WINDOW_DAYS);
  const acts = await db
    .select({ id: activities.id, startTime: activities.startTime, startTimeLocal: activities.startTimeLocal })
    .from(activities)
    .where(eq(activities.userId, userId));
  const recent = acts.filter((a) => localDateOf(a) >= cutoff);
  if (recent.length === 0) return 0;
  const existing = new Set(
    (
      await db
        .select({ activityId: coachReads.activityId })
        .from(coachReads)
        .where(eq(coachReads.userId, userId))
    ).map((r) => r.activityId),
  );
  const fresh = recent.filter((a) => !existing.has(a.id));
  const now = nowInstant();
  for (const a of fresh) {
    await db
      .insert(coachReads)
      .values({
        id: newId(),
        userId,
        activityId: a.id,
        status: "queued",
        attempt: 0,
        nextAttemptAt: now,
        claimToken: null,
        claimedAt: null,
        glance: null,
        body: null,
        flags: [],
        model: null,
        createdAt: now,
        completedAt: null,
      })
      .onConflictDoNothing();
  }
  return fresh.length;
}

/** One digest read per completed backfill covering the pre-window history —
 * the coach learns the athlete's past for one call, not hundreds. */
export async function enqueueBackfillDigest(
  db: Db,
  userId: string,
  runKey: string,
  oldCount: number,
): Promise<boolean> {
  if (oldCount <= BACKFILL_DIGEST_MIN) return false;
  const now = nowInstant();
  await db
    .insert(coachReads)
    .values({
      id: newId(),
      userId,
      activityId: `digest:${runKey}`,
      status: "queued",
      attempt: 0,
      nextAttemptAt: now,
      claimToken: null,
      claimedAt: null,
      glance: null,
      body: null,
      flags: [],
      model: null,
      createdAt: now,
      completedAt: null,
    })
    .onConflictDoNothing();
  return true;
}

/** Atomically claim one due row via the token pattern. A `running` row whose
 * claim is older than READ_RECLAIM_MINUTES is reclaimable (crash recovery);
 * its abandoned call fails the token check if it ever tries to complete. */
async function claimRead(
  db: Db,
  userId: string,
  row: { id: string; status: string; claimedAt: string | null; attempt: number },
  now: string,
): Promise<string | null> {
  const staleBefore = new Date(Date.parse(now) - READ_RECLAIM_MINUTES * 60_000).toISOString();
  if (row.status !== "queued" && !(row.status === "running" && (row.claimedAt ?? "") < staleBefore)) {
    return null;
  }
  const token = newId();
  await db
    .update(coachReads)
    .set({ status: "running", claimToken: token, claimedAt: now, attempt: row.attempt + 1 })
    .where(
      and(
        eq(coachReads.id, row.id),
        row.status === "queued"
          ? eq(coachReads.status, "queued")
          : and(eq(coachReads.status, "running"), lte(coachReads.claimedAt, staleBefore)),
      ),
    );
  const [after] = await db.select().from(coachReads).where(eq(coachReads.id, row.id)).limit(1);
  return after?.claimToken === token ? token : null;
}

async function completeRead(
  db: Db,
  id: string,
  token: string,
  out: { glance: string; body: string; flags: string[] },
  model: string,
): Promise<boolean> {
  const now = nowInstant();
  await db
    .update(coachReads)
    .set({
      status: "done",
      glance: out.glance,
      body: out.body,
      flags: out.flags,
      model,
      completedAt: now,
      claimToken: null,
      claimedAt: null,
    })
    .where(and(eq(coachReads.id, id), eq(coachReads.claimToken, token)));
  const [after] = await db.select().from(coachReads).where(eq(coachReads.id, id)).limit(1);
  return after?.status === "done";
}

async function failRead(db: Db, id: string, token: string, attempt: number): Promise<void> {
  const now = nowInstant();
  const backoffMs = Math.min(2 ** attempt * 15 * 60_000, 24 * 3600_000);
  await db
    .update(coachReads)
    .set(
      attempt >= READ_MAX_ATTEMPTS
        ? { status: "failed", claimToken: null, claimedAt: null }
        : {
            status: "queued",
            nextAttemptAt: new Date(Date.parse(now) + backoffMs).toISOString(),
            claimToken: null,
            claimedAt: null,
          },
    )
    .where(and(eq(coachReads.id, id), eq(coachReads.claimToken, token)));
}

/** Deterministic history summary for a digest read — assembled from the
 * activities table, no per-activity LLM calls. */
async function buildDigestPackage(db: Db, userId: string): Promise<string> {
  const acts = await db
    .select({
      sport: activities.sport,
      startTime: activities.startTime,
      startTimeLocal: activities.startTimeLocal,
      durationSeconds: activities.durationSeconds,
      distanceMeters: activities.distanceMeters,
      trainingLoad: activities.trainingLoad,
    })
    .from(activities)
    .where(eq(activities.userId, userId));
  if (acts.length === 0) return "TRAINING HISTORY\n(no activities on record)";
  const bySport = new Map<string, number>();
  for (const a of acts) bySport.set(a.sport, (bySport.get(a.sport) ?? 0) + 1);
  const dates = acts.map(localDateOf).sort();
  const longestRun = acts
    .filter((a) => a.sport === "run" && a.distanceMeters != null)
    .reduce((m, a) => Math.max(m, a.distanceMeters ?? 0), 0);
  const weekly = new Map<string, number>();
  for (const a of acts) {
    const wk = localDateOf(a).slice(0, 7);
    weekly.set(wk, (weekly.get(wk) ?? 0) + a.durationSeconds / 3600);
  }
  const biggestMonth = [...weekly.entries()].sort((a, b) => b[1] - a[1])[0];
  const lines = [
    "TRAINING HISTORY (imported)",
    `- span: ${dates[0]} → ${dates[dates.length - 1]} · ${acts.length} activities`,
    `- by sport: ${[...bySport.entries()].map(([s, n]) => `${s} ${n}`).join(" · ")}`,
  ];
  if (longestRun > 0) lines.push(`- longest run: ${(longestRun / 1609.34).toFixed(1)} mi`);
  if (biggestMonth) lines.push(`- biggest month: ${biggestMonth[0]} · ${biggestMonth[1].toFixed(0)} h`);
  return lines.join("\n");
}

interface GenerateOutcome {
  ok: boolean;
  out?: { glance: string; body: string; flags: string[] };
}

/** One claimed read → one model call (plus one schema-repair round-trip). */
async function generateRead(
  db: Db,
  env: Env,
  userId: string,
  activityId: string,
  fetchImpl: typeof fetch,
): Promise<GenerateOutcome> {
  const isDigest = activityId.startsWith("digest:");
  const packageText = isDigest
    ? await buildDigestPackage(db, userId)
    : (await buildEffortPackage(db, userId, activityId))?.text;
  if (!packageText) return { ok: false };

  const model = env.AI_COACH_READ_MODEL || env.AI_STUDIO_MODEL_STRONG || DEFAULT_MODEL_STRONG;
  const system = isDigest ? DIGEST_SYSTEM_PROMPT : READ_SYSTEM_PROMPT;
  type ChatMsg = { role: "system" | "user" | "assistant"; content: string };
  const messages: ChatMsg[] = [
    { role: "system", content: system },
    { role: "user", content: packageText },
  ];

  const attempt = async (msgs: ChatMsg[]) => {
    const chat = await chatCompletion(env, fetchImpl, model, MAX_OUTPUT_TOKENS_READ, msgs);
    if (!chat.ok) return { out: null, raw: "", issues: "" };
    await recordUsage(db, userId, "coach_read", model, "strong", chat, `read:${activityId}`);
    const parsed = readOutputSchema.safeParse(extractJson(chat.content));
    if (parsed.success) return { out: parsed.data, raw: chat.content, issues: "" };
    const issues = parsed.error.issues
      .slice(0, 8)
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    return { out: null, raw: chat.content, issues };
  };

  let { out, raw, issues } = await attempt(messages);
  if (!out && raw) {
    ({ out } = await attempt([
      ...messages,
      { role: "assistant", content: raw },
      {
        role: "user",
        content: `That did not match the required JSON schema. Problems:\n${issues || "no JSON object found"}\nReply with ONLY the corrected JSON object — same content, valid shape.`,
      },
    ]));
  }
  return out ? { ok: true, out } : { ok: false };
}

function gateReason(env: Env, prefs: UserPreferences): ReadGateReason | null {
  if (fixtureModeEnabled(env)) return "fixture";
  if (!env.AI_GATEWAY_API_KEY) return "no_key";
  if (!(prefs.aiEnabled && env.AI_DEFAULT_ENABLED !== "0")) return "ai_disabled";
  return null;
}

/** Ambient driver (post-ingest waitUntil + hourly cron). Cap keeps a cron
 * tick bounded; the queue drains across ticks. */
export async function processCoachReads(
  db: Db,
  env: Env,
  userId: string,
  prefs: UserPreferences,
  opts: { cap?: number; fetchImpl?: typeof fetch } = {},
): Promise<{ processed: number; skipped: ReadGateReason | "budget_reserve" | null }> {
  const cap = opts.cap ?? 2;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const gate = gateReason(env, prefs);
  if (gate) return { processed: 0, skipped: gate };
  const budget = await llmBudgetStatus(db, userId);
  if (budget.spentMicros >= AUTO_READ_RESERVE_MICROS) return { processed: 0, skipped: "budget_reserve" };

  let processed = 0;
  for (let i = 0; i < cap; i++) {
    const now = nowInstant();
    const due = await db
      .select()
      .from(coachReads)
      .where(and(eq(coachReads.userId, userId), lte(coachReads.nextAttemptAt, now)))
      .orderBy(coachReads.createdAt);
    const staleBefore = new Date(Date.parse(now) - READ_RECLAIM_MINUTES * 60_000).toISOString();
    const candidate = due.find(
      (r) => r.status === "queued" || (r.status === "running" && (r.claimedAt ?? "") < staleBefore),
    );
    if (!candidate) break;
    const token = await claimRead(db, userId, candidate, now);
    if (!token) continue; // lost the race for this row — try the next
    const gen = await generateRead(db, env, userId, candidate.activityId, fetchImpl);
    if (gen.ok && gen.out) {
      const model = env.AI_COACH_READ_MODEL || env.AI_STUDIO_MODEL_STRONG || DEFAULT_MODEL_STRONG;
      if (await completeRead(db, candidate.id, token, gen.out, model)) processed += 1;
    } else {
      await failRead(db, candidate.id, token, candidate.attempt + 1);
    }
  }
  return { processed, skipped: null };
}

/** User-initiated read-through (the analyze route, rework spec §2): serve the
 * ledger, or generate synchronously under the same claim discipline. Uses the
 * full budget cutoff, not the auto-read reserve — the athlete asked. */
export async function ensureRead(
  db: Db,
  env: Env,
  userId: string,
  prefs: UserPreferences,
  activityId: string,
  opts: { force?: boolean; fetchImpl?: typeof fetch } = {},
): Promise<ReadResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const force = opts.force === true;

  const [existing] = await db
    .select()
    .from(coachReads)
    .where(and(eq(coachReads.userId, userId), eq(coachReads.activityId, activityId)))
    .limit(1);

  if (existing?.status === "done" && !force) {
    return {
      status: "done",
      cached: true,
      read: {
        id: existing.id,
        glance: existing.glance ?? "",
        body: existing.body ?? "",
        flags: existing.flags,
        at: existing.completedAt ?? existing.createdAt,
      },
    };
  }

  const gate = gateReason(env, prefs);
  if (gate === "ai_disabled" || gate === "fixture") return { status: "ai_disabled" };
  if (gate === "no_key") return { status: "error" };

  // Someone else is generating right now — don't double-call, let them finish.
  const now = nowInstant();
  const staleBefore = new Date(Date.parse(now) - READ_RECLAIM_MINUTES * 60_000).toISOString();
  if (existing?.status === "running" && (existing.claimedAt ?? "") >= staleBefore) {
    return { status: "working" };
  }

  const budget = await llmBudgetStatus(db, userId);
  if (budget.cutoff) return { status: "resting" };

  // The activity must exist before we mint a ledger row for it.
  if (!activityId.startsWith("digest:")) {
    const [act] = await db
      .select({ id: activities.id })
      .from(activities)
      .where(and(eq(activities.userId, userId), eq(activities.id, activityId)))
      .limit(1);
    if (!act) return { status: "not_found" };
  }

  let row = existing;
  if (!row) {
    await db
      .insert(coachReads)
      .values({
        id: newId(),
        userId,
        activityId,
        status: "queued",
        attempt: 0,
        nextAttemptAt: now,
        claimToken: null,
        claimedAt: null,
        glance: null,
        body: null,
        flags: [],
        model: null,
        createdAt: now,
        completedAt: null,
      })
      .onConflictDoNothing();
    [row] = await db
      .select()
      .from(coachReads)
      .where(and(eq(coachReads.userId, userId), eq(coachReads.activityId, activityId)))
      .limit(1);
    if (!row) return { status: "error" };
  } else if (force || row.status === "failed") {
    // Regenerate in place: same row, fresh attempt budget. Token-free reset is
    // safe — claimRead below still races atomically on the queued status.
    await db
      .update(coachReads)
      .set({ status: "queued", attempt: 0, nextAttemptAt: now, claimToken: null, claimedAt: null })
      .where(and(eq(coachReads.id, row.id), eq(coachReads.userId, userId)));
    [row] = await db.select().from(coachReads).where(eq(coachReads.id, row.id)).limit(1);
    if (!row) return { status: "error" };
  }

  const token = await claimRead(db, userId, row, now);
  if (!token) return { status: "working" };

  const gen = await generateRead(db, env, userId, activityId, fetchImpl);
  if (!gen.ok || !gen.out) {
    await failRead(db, row.id, token, row.attempt + 1);
    return { status: "error" };
  }
  const model = env.AI_COACH_READ_MODEL || env.AI_STUDIO_MODEL_STRONG || DEFAULT_MODEL_STRONG;
  if (!(await completeRead(db, row.id, token, gen.out, model))) return { status: "working" };
  const [after] = await db.select().from(coachReads).where(eq(coachReads.id, row.id)).limit(1);
  if (!after) return { status: "error" };
  return {
    status: "done",
    cached: false,
    read: {
      id: after.id,
      glance: after.glance ?? "",
      body: after.body ?? "",
      flags: after.flags,
      at: after.completedAt ?? after.createdAt,
    },
  };
}
