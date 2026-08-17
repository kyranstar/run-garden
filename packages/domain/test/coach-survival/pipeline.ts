/**
 * The four stages a coach's work has to survive, run end to end with no model
 * in the loop: `wakeOutputSchema` → `resolveOpsExercises` → `validateOps` →
 * `applyOps`. Each stage records WHY it failed, in a form that can be counted.
 *
 * The apply stage runs the real `applyOps` against real SQLite with the real
 * migrations and D1's 100-bound-variable ceiling installed, because "would
 * apply succeed" cannot be answered by reading the function.
 */
import { wakeOutputSchema, addOpDates, type CoachOp } from "../../src/coach.js";
import { validateOps } from "../../src/coach-guardrails.js";
import { schema } from "../../../database/src/index.js";
import { D1_BIND_LIMIT, makeTestDb, makeTestUser } from "../../../../apps/worker/test/helpers.js";
import { applyOps } from "../../../../apps/worker/src/services/coach-apply.js";
import { buildDossier } from "../../../../apps/worker/src/services/coach-context.js";
import { resolveOpsExercises, type ExerciseIndex } from "../../../../apps/worker/src/services/exercise-catalog.js";
import type { Db } from "../../../../apps/worker/src/services/db.js";
import type { AthleteState } from "./athletes.js";
import { TZ } from "./athletes.js";

export type Stage = "parse" | "resolve" | "guardrail" | "apply";

export interface SampleResult {
  athlete: string;
  intent: string;
  opKinds: string[];
  survived: boolean;
  failedAt: Stage | null;
  /** Ranked-countable cause keys, e.g. `fatal:unknown_workout`. */
  causes: string[];
  /** Athlete-readable detail for the first cause, for quoting. */
  detail: string;
  /** Failures nobody is told about: no throw, no violation, no effect. */
  silent: string[];
  /**
   * The same class of failure, but SAID OUT LOUD — an op that promised a
   * mutation and performed none, which `applyOps` now reports in
   * `ApplyResult.missed` so the receipt can carry it (2026-08-17).
   *
   * Counted apart from `silent` because the distinction is the whole point:
   * the plan still did not do what it said, but the athlete is told rather
   * than handed a success receipt for nothing. A disclosed miss keeps the
   * plan out of the survival count and out of the silent column.
   */
  disclosed: string[];
  exercises: number;
  offCatalog: number;
  /** Movements the athlete's synced catalog has no row for. */
  offCatalogNames: string[];
  /** "A" = the dialect the schema documents; "B" = one model-natural
   * variation on top of it (see REGISTER_B in plans.ts). */
  register: "A" | "B";
  /** Which register-B variation, if any. */
  variation: string;
  /**
   * ADVISORY rules the plan tripped. Since the 2026-08-17 split these do not
   * reject anything — they ride the proposal to the athlete as trade-off lines
   * — so they are counted separately from what actually kills a plan.
   */
  advisories: Array<{ rule: string; detail: string }>;
  /** True if this plan WOULD have been binned before the split, i.e. it
   * tripped any rule at all. The gap between this and `survived` is the
   * measured value of the fatal/advisory split. */
  diedPreSplit: boolean;
}

/** Array indices out of a zod path, so `ops.3.session…` and `ops.7.session…`
 * count as the same clause. The `proposals[].ops[]` prefix every path carries
 * is dropped: it is noise in a ranked table where every row has it. */
function clause(path: (string | number)[]): string {
  const s = path.map((p) => (typeof p === "number" ? "[]" : p)).join(".") || "(root)";
  return s.replace(/^proposals\.\[\]\.ops\.\[\]\.?/, "op.").replace(/^op\.$/, "op");
}

export interface ApplyHarness {
  db: Db;
  userId: string;
  prefs: Parameters<typeof applyOps>[2];
}

/** A database that matches the athlete state exactly. */
export async function seedAthlete(s: AthleteState, corosWritesEnabled = false): Promise<ApplyHarness> {
  const db = makeTestDb({ boundVariableCap: D1_BIND_LIMIT });
  const { userId, prefs } = await makeTestUser(db, { timezone: TZ, corosWritesEnabled });
  const now = new Date().toISOString();
  for (const p of s.coachPlans) {
    await db.insert(schema.coachPlans).values({
      id: p.id,
      userId,
      discipline: p.discipline,
      name: `Plan ${p.id}`,
      status: "active",
      startDate: s.A,
      endDate: s.ctx.firmHorizonEnd,
      raceDate: p.raceDate ?? null,
      stampPrefix: `Plan ${p.id}`,
      createdAt: now,
      updatedAt: now,
    });
  }
  for (const r of s.rows) {
    await db.insert(schema.plannedWorkouts).values({
      id: r.id,
      userId,
      planId: r.planId,
      sourceWorkoutId: `4738:${r.id}`,
      title: r.title,
      category: r.category,
      sport: r.discipline === "strength" ? "strength" : r.discipline === "yoga" ? "yoga" : "run",
      originalPlanDate: r.date,
      lastVerifiedCorosDate: r.date,
      effectiveDate: r.date,
      effectiveTime: "07:00",
      completionState: r.completionState,
      sourceContentFingerprint: `fp-${r.id}`,
      calendarBlockDurationSeconds: r.durationMinutes * 60,
      createdAt: now,
      updatedAt: now,
    });
  }
  return { db, userId, prefs };
}

/**
 * WHAT THE DOSSIER ACTUALLY OFFERS THE COACH TO NAME.
 *
 * Register B's reference variations used to draw their targets from the fixture
 * — `s.rows.filter(completed)` — which gave the generator knowledge no model
 * has and made "would a coach write this?" a question the harness answered by
 * assertion. It reads the REAL dossier instead: `buildDossier` against the
 * seeded database, every `[wo:...]` handle scraped out of the rendered text,
 * and each one checked against the predicate `validateOps` will apply.
 *
 * A handle in `leaked` is a session the dossier invited the coach to change and
 * the guardrails will refuse. That set is what "the context is ambiguous" means
 * concretely, and it is why the survival rate can move when the dossier gets
 * clearer: the mistake stops being available, rather than stopping being
 * counted.
 */
export interface DossierHandles {
  /** Every `[wo:...]` id the rendered dossier prints, anywhere. */
  offered: string[];
  /** Offered ids that are already resolved or whose day has gone — every one a
   * `fatal:touch_resolved` waiting for a coach to copy it. */
  leaked: string[];
}

export async function dossierHandles(s: AthleteState): Promise<DossierHandles> {
  const h = await seedAthlete(s);
  // `s.ctx.today` and `s.ctx` — one date, threaded, exactly as the wake does
  // it (ONE CLOCK PER WAKE, coach-wake.ts). A dossier reading its own clock is
  // how a handle the validator refuses gets printed as if it were offered.
  const d = await buildDossier(h.db, h.userId, h.prefs, s.ctx.today, s.ctx);
  // `[wo:...]` with a literal ellipsis is the prose that explains the
  // convention to the model, not a handle it can copy.
  const offered = [
    ...new Set([...d.text.matchAll(/\[wo:([^\]\s]+)\]/g)].map((m) => m[1]!).filter((id) => id !== "...")),
  ];
  const byId = new Map(s.ctx.workouts.map((w) => [w.id, w]));
  const leaked = offered.filter((id) => {
    const w = byId.get(id);
    if (!w) return true;
    const unresolved = w.completionState === "scheduled" || w.completionState === "planned";
    return !unresolved || w.date < s.ctx.today;
  });
  return { offered, leaked };
}

type Snapshot = { workouts: Map<string, string>; plans: Map<string, string>; weeks: Set<string> };

async function snapshot(db: Db): Promise<Snapshot> {
  const workouts = new Map<string, string>();
  for (const w of await db.select().from(schema.plannedWorkouts)) workouts.set(w.id, JSON.stringify(w));
  const plans = new Map<string, string>();
  for (const p of await db.select().from(schema.coachPlans)) plans.set(p.id, JSON.stringify(p));
  const weeks = new Set<string>();
  for (const w of await db.select().from(schema.coachPlanWeeks)) weeks.add(`${w.planId}|${w.weekStart}`);
  return { workouts, plans, weeks };
}

/**
 * What each op PROMISED, checked against what the database actually holds.
 * A promise the apply reported as kept but did not keep is the silent class —
 * `applyOps` pushes ids into `updated` before it knows whether anything moved.
 */
async function verifyApply(db: Db, ops: CoachOp[], before: Snapshot): Promise<string[]> {
  const after = await snapshot(db);
  const missed: string[] = [];
  const rowAt = (dates: string[]): boolean => {
    const fresh = [...after.workouts.keys()].filter((k) => !before.workouts.has(k));
    const freshDates = new Set(
      fresh.map((k) => (JSON.parse(after.workouts.get(k)!) as { effectiveDate: string }).effectiveDate),
    );
    return dates.every((x) => freshDates.has(x));
  };
  for (const op of ops) {
    switch (op.kind) {
      case "ease": {
        if (!after.workouts.has(op.workoutId)) missed.push("ease: no such workout, nothing changed");
        else if (after.workouts.get(op.workoutId) === before.workouts.get(op.workoutId)) {
          missed.push("ease: the row is byte-identical afterwards");
        }
        break;
      }
      case "skip": {
        const row = after.workouts.get(op.workoutId);
        if (!row) missed.push("skip: no such workout, nothing changed");
        else if ((JSON.parse(row) as { completionState: string }).completionState !== "skipped") {
          missed.push("skip: the session is still scheduled");
        }
        break;
      }
      case "move": {
        const row = after.workouts.get(op.workoutId);
        if (!row) missed.push("move: no such workout, nothing changed");
        else if ((JSON.parse(row) as { effectiveDate: string }).effectiveDate !== op.toDate) {
          missed.push("move: the session did not land on the target date");
        }
        break;
      }
      case "swap": {
        const had = [...before.workouts.values()].some((v) => {
          const r = JSON.parse(v) as { effectiveDate: string };
          return r.effectiveDate === op.dayA || r.effectiveDate === op.dayB;
        });
        const changed = [...after.workouts.entries()].some(([k, v]) => before.workouts.get(k) !== v);
        if (had && !changed) missed.push("swap: both days still hold what they held");
        break;
      }
      case "add":
        if (!rowAt(addOpDates(op))) missed.push("add: not every date got a session");
        break;
      case "reshapeWeek":
      case "firmUp":
      case "windDown":
        if (!rowAt(op.sessions.map((x) => x.date))) missed.push(`${op.kind}: not every session was written`);
        break;
      case "createPlan":
        if (after.plans.size === before.plans.size) missed.push("createPlan: no plan row appeared");
        if (!rowAt(op.firmSessions.map((x) => x.date))) missed.push("createPlan: firm sessions missing");
        break;
      case "extendPlan":
        if ([...after.weeks].length === [...before.weeks].length) missed.push("extendPlan: no shape weeks appeared");
        break;
      case "retirePlan": {
        const p = after.plans.get(op.planId);
        if (!p) missed.push("retirePlan: no such plan, nothing retired");
        else if ((JSON.parse(p) as { status: string }).status !== "retired") {
          missed.push("retirePlan: the plan is still active");
        }
        break;
      }
      case "resolveRaceConflict":
        break;
    }
  }
  return [...new Set(missed)];
}

export interface RunOptions {
  index: ExerciseIndex;
  /** Skip the (expensive) apply stage. */
  skipApply?: boolean;
  corosWritesEnabled?: boolean;
  register?: "A" | "B";
  variation?: string;
}

export async function runSample(
  s: AthleteState,
  intent: string,
  envelope: unknown,
  opts: RunOptions,
): Promise<SampleResult> {
  const base: SampleResult = {
    athlete: s.key,
    intent,
    opKinds: [],
    survived: false,
    failedAt: null,
    causes: [],
    detail: "",
    silent: [],
    disclosed: [],
    exercises: 0,
    offCatalog: 0,
    offCatalogNames: [],
    register: opts.register ?? "A",
    variation: opts.variation ?? "",
    advisories: [],
    diedPreSplit: false,
  };
  const rawOps = ((envelope as { proposals: Array<{ ops: Array<{ kind: string }> }> }).proposals[0]?.ops ?? []);
  base.opKinds = rawOps.map((o) => o.kind);

  // ── stage 1: parse ────────────────────────────────────────────────────
  const parsed = wakeOutputSchema.safeParse(envelope);
  if (!parsed.success) {
    const first = parsed.error.issues[0]!;
    return {
      ...base,
      failedAt: "parse",
      causes: [...new Set(parsed.error.issues.map((i) => `parse:${clause(i.path)} — ${i.message}`))].slice(0, 4),
      detail: `${clause(first.path)}: ${first.message}`,
    };
  }
  const ops = parsed.data.proposals[0]?.ops ?? [];

  // ── stage 2: exercise resolution ──────────────────────────────────────
  const before = JSON.stringify(ops);
  let report;
  try {
    report = resolveOpsExercises(ops, opts.index);
  } catch (e) {
    return { ...base, failedAt: "resolve", causes: ["resolve:threw"], detail: String(e) };
  }
  base.exercises = report.length;
  base.offCatalog = report.filter((r) => !r.originId).length;
  base.offCatalogNames = report.filter((r) => !r.originId).map((r) => r.name);
  const nameCount = (json: string): number => (json.match(/"name":/g) ?? []).length;
  if (nameCount(before) !== nameCount(JSON.stringify(ops))) {
    return { ...base, failedAt: "resolve", causes: ["resolve:dropped an exercise"], detail: "exercise count changed" };
  }

  // ── stage 3: guardrails ───────────────────────────────────────────────
  const { fatal, advisory, soft } = validateOps(ops, s.ctx);
  const seenRule = new Set<string>();
  base.advisories = [
    ...advisory.map((a) => ({ rule: a.rule, detail: a.detail })),
    ...soft.map((a) => ({ rule: "standing_rule", detail: a.detail })),
  ].filter((a) => !seenRule.has(a.rule) && (seenRule.add(a.rule), true));
  base.diedPreSplit = fatal.length + advisory.length > 0;
  if (fatal.length > 0) {
    return {
      ...base,
      failedAt: "guardrail",
      causes: [...new Set(fatal.map((h) => `fatal:${h.rule}`))],
      detail: fatal.map((h) => h.detail).join("; "),
    };
  }

  // ── stage 4: apply ────────────────────────────────────────────────────
  if (opts.skipApply) return { ...base, survived: true };
  const h = await seedAthlete(s, opts.corosWritesEnabled ?? false);
  const snap = await snapshot(h.db);
  let applied;
  try {
    applied = await applyOps(h.db, h.userId, h.prefs, `prop-${s.key}-${intent}`, ops);
  } catch (e) {
    return { ...base, failedAt: "apply", causes: [`apply:threw — ${String(e).slice(0, 120)}`], detail: String(e) };
  }
  const missed = await verifyApply(h.db, ops, snap);
  if (missed.length > 0) {
    // Whether the apply TOLD anyone is the difference between a bad receipt
    // and a lying one, so the two are counted separately. `applied.missed` is
    // the apply's own account of what it could not do; anything the verifier
    // found that the apply did not mention is still silent.
    return {
      ...base,
      failedAt: "apply",
      causes: missed.map((m) => `apply:${m}`),
      detail: missed.join("; "),
      silent: applied.missed.length > 0 ? [] : missed,
      disclosed: applied.missed,
    };
  }
  return { ...base, survived: true, disclosed: applied.missed };
}
