import { z } from "zod";

/**
 * The coach's typed vocabulary (spec: docs/superpowers/specs/2026-08-06-
 * coach-intelligence-design.md §3). Everything the model may output is
 * bounded and strict — the wake pipeline parses with one repair retry and
 * the guardrail validator runs on ops before anything persists.
 */

/**
 * Calendar date, tolerantly parsed: the model is told "end of first affected
 * day", which invites a full timestamp — accept it and truncate rather than
 * fail the whole wake over a suffix that changes nothing.
 */
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}(T[\d:.+Zz-]*)?$/)
  .transform((s) => s.slice(0, 10));

/**
 * Entity ids as the model echoes them back. The dossier renders handles as
 * `[wo:abc]` / `plan [cp1]` / `fact [mem1]`; a faithful copy including the
 * decoration must resolve to the same row, not become a dud op.
 */
/** Optional-field discipline for MODEL-authored JSON (live failures
 * 2026-08-12/13): models habitually emit `"raceDate": null` where a field
 * is optional — a bare `.optional()` rejects that, and the coach's
 * plan-drafting failed three times in a row on exactly this. null and
 * undefined mean the same thing here. */
const orNull = <T extends z.ZodTypeAny>(schema: T) =>
  schema
    .nullish()
    .transform((v: z.infer<T> | null | undefined) => (v === null ? undefined : v));

const echoedId = z
  .string()
  .min(1)
  .transform((s) =>
    s
      .trim()
      .replace(/^\[/, "")
      .replace(/\]$/, "")
      .replace(/^(wo|plan|mem):/, ""),
  );

/**
 * Prose fields truncate at their cap instead of rejecting: a verbose model
 * must never kill a whole wake over sentence length. Enums, counts, and
 * structure stay strict — vocabulary is bounded, prose is trimmed.
 */
const prose = (max: number) => z.string().min(1).transform((s) => (s.length > max ? s.slice(0, max) : s));

/**
 * Model-natural integer. A coach that writes `"reps": "8"`, `"sets": 3.0` or
 * `"holdSeconds": "45s"` means the number in all three cases; the studio's
 * bare `z.number().int()` rejected two of them. Non-numeric input falls
 * through unchanged so the real error still names the real problem.
 */
const intish = (min: number, max: number) =>
  z.preprocess((v) => {
    if (typeof v === "number") return Math.round(v);
    if (typeof v === "string") {
      const m = v.match(/-?\d+(?:\.\d+)?/);
      return m ? Math.round(Number(m[0])) : v;
    }
    return v;
  }, z.number().int().min(min).max(max));

const MAX_SETS = 10;
/** 100, not the studio's 50: "50 skater bounds per side" is a real drill. */
const MAX_REPS = 100;
/** 20 minutes — a farmer's-carry / ruck block is still one "set". */
const MAX_HOLD_SECONDS = 1200;
const MAX_REST_SECONDS = 900;
/** A tempo prescription past this is a hold, and holdSeconds says it better. */
const MAX_ECCENTRIC_SECONDS = 15;
const MAX_WEIGHT_KG = 500;
/** Two weeks of a genuinely daily piece in one op — past that it is a plan,
 * and `createPlan` is the op for a plan. */
const MAX_ADD_DATES = 14;
/** What a coach means by "short rest" when it doesn't say. */
const DEFAULT_REST_SECONDS = 60;
const LB_TO_KG = 0.45359237;

/**
 * Load, as a coach actually writes it. The studio's discriminated union is
 * unproducible without being told the shape — the live 2026-08-16 failure
 * rejected three exercises for a missing `weight` on a WALL SIT, where the
 * only true answer is "your body". So: absent means bodyweight, a bare
 * number means kilos, and the common prose forms are understood. The studio
 * union itself still parses, so a model that copies that shape is right too.
 */
export const coachWeightSchema = z
  .preprocess(
    (v) => {
      if (v === null || v === undefined) return { type: "bodyweight" };
      if (typeof v === "number") return v > 0 ? { type: "kg", value: v } : { type: "bodyweight" };
      if (typeof v === "string") {
        const s = v.trim().toLowerCase();
        const m = s.match(/(\d+(?:\.\d+)?)\s*(kgs?|kilos?|lbs?|pounds?)?/);
        if (!m) return { type: "bodyweight" }; // "heavy", "moderate" — say it in `note`
        const n = Number(m[1]);
        const lb = /lb|pound/.test(m[2] ?? "");
        return { type: "kg", value: lb ? Math.round(n * LB_TO_KG * 10) / 10 : n };
      }
      return v;
    },
    z.discriminatedUnion("type", [
      z.object({ type: z.literal("bodyweight") }).strict(),
      z.object({ type: z.literal("kg"), value: z.number().min(0).max(MAX_WEIGHT_KG) }).strict(),
    ]),
  )
  .default({ type: "bodyweight" });
export type CoachWeight = z.infer<typeof coachWeightSchema>;

/**
 * The coach's exercise vocabulary — deliberately NOT `studioExerciseSchema`.
 *
 * The studio's schema is written for the plan-generation path, where the
 * model is HANDED the COROS catalog (jobs.ts: "catalog is only the entries
 * THIS session needs"). It requires `originId`, `weight` and `restSeconds`.
 * The coach wake gets no catalog, so `originId` is unproducible — and on
 * 2026-08-16 a real ski-prep session (wall sits + leg work) was rejected on
 * exactly those three fields and silently dropped, prose intact, ops gone.
 *
 * What the model must supply is only what a coach knows without a catalog:
 * the name, and the work. Everything else has a defensible default, and
 * `originId` is resolved SERVER-side from the name (exercise-catalog.ts) —
 * a model-supplied value is always overwritten, never trusted.
 *
 * The work itself is `reps` OR `holdSeconds`, because the studio's sets+reps
 * could not express a wall sit at all — a 45-second hold had to be faked as
 * reps or dropped. `perSide` and `eccentricSeconds` are here for the same
 * reason: unilateral work and a slow lowering are the substance of ski prep
 * and of injury-resistant strength generally, and neither had a home.
 */
export const coachExerciseSchema = z
  .object({
    /** What the coach calls it. Resolved to a catalog id server-side. */
    name: prose(60),
    sets: intish(1, MAX_SETS),
    /** Reps per set — PER SIDE when `perSide`. One of reps/holdSeconds. */
    reps: orNull(intish(1, MAX_REPS).optional()),
    /** Seconds of work per set: a hold (wall sit, plank, Copenhagen) or a
     * timed effort (30s skier hops). One of reps/holdSeconds. */
    holdSeconds: orNull(intish(3, MAX_HOLD_SECONDS).optional()),
    /** The prescription happens on EACH leg/arm — sets × reps per side. */
    perSide: orNull(z.boolean().optional()),
    /** Seconds to lower under control. The eccentric is the point of a
     * ski-prep squat; "4s down" had no field before this. */
    eccentricSeconds: orNull(intish(1, MAX_ECCENTRIC_SECONDS).optional()),
    weight: coachWeightSchema,
    restSeconds: z
      .preprocess(
        (v) => (v === null || v === undefined ? DEFAULT_REST_SECONDS : v),
        intish(0, MAX_REST_SECONDS),
      )
      .default(DEFAULT_REST_SECONDS),
    /** Cueing, or anything the fields above can't hold ("pause at the
     * bottom", "heavy enough that set 3 is hard"). */
    note: orNull(prose(160)),
    /**
     * SERVER-FILLED, never the model's job: the `coros_exercises` id this
     * name resolved to. Absent after a wake means the athlete's synced
     * catalog has no match — the session still persists and still shows,
     * it just can never be written to the watch. Optional in the schema so
     * a model that omits it (it always will) parses cleanly.
     */
    originId: orNull(z.string().min(1).optional()),
  })
  .strict()
  .refine((e) => e.reps !== undefined || e.holdSeconds !== undefined, {
    message: "exercise needs reps or holdSeconds — how much work is one set?",
    path: ["reps"],
  });
export type CoachExercise = z.infer<typeof coachExerciseSchema>;

/**
 * One exercise as a line of text — the single formatter, so the stage
 * summary the worker stores, the coach's own dossier, and the session sheet
 * cannot disagree about what "3×8/side @ 4s down" means.
 */
export function formatExercise(e: CoachExercise): string {
  const work =
    e.holdSeconds !== undefined
      ? `${e.sets}×${e.holdSeconds}s`
      : `${e.sets}×${e.reps}`;
  const side = e.perSide ? "/side" : "";
  const load = e.weight.type === "kg" ? ` @ ${e.weight.value} kg` : "";
  const tempo = e.eccentricSeconds !== undefined ? ` (${e.eccentricSeconds}s down)` : "";
  return `${e.name} ${work}${side}${load}${tempo}`;
}

/** One structured run block — the COROS-write-confirmed topology. */
export const coachRunBlockSchema = z
  .object({
    kind: z.enum(["duration", "distance"]),
    /** Minutes for duration blocks; meters for distance blocks. */
    value: z.number().int().min(1).max(100_000),
    intensity: orNull(z.enum(["easy", "steady", "threshold", "interval", "rest"]).optional()),
  })
  .strict();

/**
 * A list of exercises and how it is performed.
 *
 * `rounds` is what makes a CIRCUIT expressible. Without it the only shape
 * available was straight sets, so the athlete's literal ask — "12-minute
 * wall-sit-and-core fillers" — had to be faked as three separate sets-of-one
 * exercises or hidden in the title where nothing can read it. With it,
 * "3 rounds of wall sit 45s / plank 45s / side plank 30s per side" is one
 * honest object, and each exercise's `sets` is the work done PER ROUND
 * (almost always 1). Absent = straight sets, exercise by exercise.
 */
export const coachExerciseBlockSchema = z
  .object({
    rounds: orNull(intish(1, 20).optional()),
    exercises: z.array(coachExerciseSchema).min(1).max(12),
  })
  .strict();
export type CoachExerciseBlock = z.infer<typeof coachExerciseBlockSchema>;

/**
 * A discipline-generic planned session. AT MOST ONE discipline body.
 *
 * `mobility` is the third body (2026-08-16): the app has three first-class
 * disciplines (run/strength/yoga) and the coach could speak two, so every
 * mobility or yoga session it wrote was stored as `sport: "run"` by
 * coach-apply's `session.lift ? "strength" : "run"` — growing the garden's
 * run bar and feeding false running volume into load and insights. Its
 * content is movements and holds, which the exercise vocabulary above
 * already covers exactly, so it shares the block shape rather than
 * inventing a parallel one.
 */
export const coachSessionSchema = z
  .object({
    category: z.enum(["easy", "long", "quality", "recovery", "race", "rest", "strength", "yoga"]),
    title: prose(80),
    durationMinutes: z.number().int().min(5).max(360),
    run: orNull(z.object({ blocks: z.array(coachRunBlockSchema).min(1).max(12) }).strict().optional()),
    lift: orNull(coachExerciseBlockSchema.optional()),
    mobility: orNull(coachExerciseBlockSchema.optional()),
  })
  .strict()
  .refine((s) => [s.run, s.lift, s.mobility].filter(Boolean).length <= 1, {
    message: "a session has at most one discipline body (run, lift or mobility)",
  });
export type CoachSession = z.infer<typeof coachSessionSchema>;

/**
 * The `planned_workouts.sport` this session belongs to — TOTAL, by
 * construction. The old `session.lift ? "strength" : "run"` was a binary
 * fallback masquerading as a mapping: it filed every non-lift session,
 * including mobility and rest, under running.
 *
 * The switch is exhaustive over the category enum with a `never` check, so
 * adding a category without deciding its discipline is a compile error
 * rather than a silent "run". The runtime throw only fires for data that
 * bypassed zod entirely — loudly, which is the point.
 */
export function sessionSport(s: CoachSession): "run" | "strength" | "yoga" {
  if (s.lift) return "strength";
  if (s.mobility) return "yoga";
  if (s.run) return "run";
  // Bodyless: the category is the only evidence there is.
  switch (s.category) {
    case "strength":
      return "strength";
    case "yoga":
      return "yoga";
    // Rest has no discipline at all. "run" matches how every imported COROS
    // rest day is already stored (COROS's plan namespace has no rest sport),
    // and `disciplineOf` reads category first, so nothing counts it as
    // running volume — analytics filter `category !== "rest"` upstream.
    case "rest":
    case "easy":
    case "long":
    case "quality":
    case "recovery":
    case "race":
      return "run";
    default: {
      const never: never = s.category;
      throw new Error(`session category has no discipline mapping: ${String(never)}`);
    }
  }
}

/** The session's exercise block, whichever body carries it. */
export function sessionExercises(s: CoachSession): CoachExercise[] {
  return s.lift?.exercises ?? s.mobility?.exercises ?? [];
}

/**
 * Exercise names that found no match in the athlete's synced COROS catalog
 * (see exercise-catalog.ts). Empty for a run or a rest day. A non-empty
 * result is NOT a failure — it is the honest reason a session can live in
 * the app and never reach the watch.
 */
export function offCatalogExercises(s: CoachSession): string[] {
  return sessionExercises(s)
    .filter((e) => !e.originId)
    .map((e) => e.name);
}

/** A whole block as one line — "3 rounds: Wall sit 1×45s · Plank 1×45s". */
export function formatExerciseBlock(b: CoachExerciseBlock): string {
  const line = b.exercises.map(formatExercise).join(" · ");
  return b.rounds ? `${b.rounds} rounds: ${line}` : line;
}

const datedSession = z.object({ date: isoDate, session: coachSessionSchema }).strict();

export const coachShapeWeekSchema = z
  .object({
    weekStart: isoDate,
    // Truncate, never reject: these are display strings, and a 53-char
    // volume target killed three plan drafts in a row (audit follow-up).
    volumeTarget: prose(40),
    keySessions: z.array(prose(60)).max(4),
  })
  .strict();
export type CoachShapeWeek = z.infer<typeof coachShapeWeekSchema>;

/** The ONLY ways the coach can touch a plan. */
export const coachOpSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ease"), workoutId: echoedId, session: coachSessionSchema }).strict(),
  z.object({ kind: z.literal("move"), workoutId: echoedId, toDate: isoDate }).strict(),
  z.object({ kind: z.literal("swap"), dayA: isoDate, dayB: isoDate }).strict(),
  z.object({ kind: z.literal("skip"), workoutId: echoedId, reason: prose(200) }).strict(),
  z
    .object({
      kind: z.literal("add"),
      date: isoDate,
      /**
       * The OTHER dates this same session happens on — a recurring piece is
       * ONE op, not one op per day (2026-08-17).
       *
       * A daily ten-minute mobility piece across a ten-day block used to cost
       * ten `add` ops, each re-serialising the whole exercise list; a live
       * wake wrote 16k output tokens and 3.5 minutes trying. The session is
       * identical on every date, so the dates are the only thing that varies
       * and the only thing worth repeating.
       *
       * `date` stays required and stays the first date, so every op ever
       * persisted still reads correctly and every consumer that only knows
       * `date` still gets a real one. Read the full set through `addOpDates`,
       * which unions and de-duplicates — a model that repeats the primary
       * date inside `dates` and one that omits it both mean the same thing.
       */
      dates: orNull(z.array(isoDate).min(1).max(MAX_ADD_DATES).optional()),
      session: coachSessionSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("reshapeWeek"),
      planId: echoedId,
      weekStart: isoDate,
      sessions: z.array(datedSession).max(10),
    })
    .strict(),
  z
    .object({
      kind: z.literal("firmUp"),
      planId: echoedId,
      weekStart: isoDate,
      sessions: z.array(datedSession).min(1).max(10),
    })
    .strict(),
  z
    .object({
      kind: z.literal("extendPlan"),
      planId: echoedId,
      shapeWeeks: z.array(coachShapeWeekSchema).min(1).max(8),
    })
    .strict(),
  z.object({ kind: z.literal("windDown"), planId: echoedId, sessions: z.array(datedSession).max(10) }).strict(),
  z
    .object({
      kind: z.literal("createPlan"),
      discipline: z.enum(["run", "lift"]),
      name: z.string().min(1).max(60),
      startDate: isoDate,
      endDate: isoDate,
      raceDate: orNull(isoDate.optional()),
      firmSessions: z.array(datedSession).min(1).max(30),
      shapeWeeks: z.array(coachShapeWeekSchema).max(14),
    })
    .strict(),
  z.object({ kind: z.literal("retirePlan"), planId: echoedId }).strict(),
  // Converges the two race truths (imported plan's race-labeled row vs the
  // athlete's stated race day) once the athlete confirms which is right:
  // "settings" demotes the plan's row to a regular quality session,
  // "plan" moves the athlete's race-day setting to the plan's date.
  z.object({ kind: z.literal("resolveRaceConflict"), keep: z.enum(["settings", "plan"]) }).strict(),
]);
export type CoachOp = z.infer<typeof coachOpSchema>;

/** An `add` op's full date set — the ONE reader of `date`+`dates`, so the
 * calendar the guardrails simulate, the days a proposal supersedes, and the
 * sessions `applyOps` actually writes can never disagree about how many
 * sessions one op means. Unioned, de-duplicated, in date order. */
export function addOpDates(op: Extract<CoachOp, { kind: "add" }>): string[] {
  return [...new Set([op.date, ...(op.dates ?? [])])].sort();
}

export const coachProposalDraftSchema = z
  .object({
    title: prose(80),
    evidence: prose(200),
    rationale: prose(2000),
    /** min(end of first affected day, +72h) — enforced downstream too. */
    expiresAt: isoDate,
    flags: z.array(prose(120)).max(6),
    ops: z.array(coachOpSchema).min(1).max(20),
  })
  .strict();
export type CoachProposalDraft = z.infer<typeof coachProposalDraftSchema>;

export const coachMemoryOpSchema = z.discriminatedUnion("op", [
  z
    .object({
      op: z.literal("add"),
      kind: z.enum(["fact", "rule", "note"]),
      text: prose(300),
      expiresAt: orNull(isoDate.optional()),
    })
    .strict(),
  z.object({ op: z.literal("update"), id: echoedId, text: prose(300) }).strict(),
  z.object({ op: z.literal("expire"), id: echoedId }).strict(),
]);
export type CoachMemoryOp = z.infer<typeof coachMemoryOpSchema>;

/** One wake's complete structured output. Restraint is first-class: an
 * all-null/empty output is a fully successful wake. */
export const wakeOutputSchema = z
  .object({
    briefing: z.string().transform((s) => (s.length > 4000 ? s.slice(0, 4000) : s)).nullable(),
    proposals: z.array(coachProposalDraftSchema).max(6),
    question: z
      .object({ text: prose(300), chips: z.array(z.string().min(1).max(60)).max(5) })
      .strict()
      .nullable(),
    memoryOps: z.array(coachMemoryOpSchema).max(12),
    /** The week's one action line (rework spec §3) — shown on the plan
     * page's brief. Optional so older cached outputs stay valid. */
    focus: z
      .string()
      .transform((s) => (s.length > 200 ? `${s.slice(0, 199)}…` : s))
      .nullable()
      .default(null),
    /** The race-scale sibling of `focus` (race hub 2026-08-14): one
     * sentence on the build toward race day, pinned in the plan page's race
     * strip. Null-tolerant and defaulted so every historical output parses. */
    raceLine: orNull(
      z
        .string()
        .transform((s) => (s.length > 200 ? `${s.slice(0, 199)}…` : s))
        .optional(),
    ),
  })
  .strict();
export type WakeOutput = z.infer<typeof wakeOutputSchema>;
