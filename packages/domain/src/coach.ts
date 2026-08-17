import { z } from "zod";

/**
 * The coach's typed vocabulary (spec: docs/superpowers/specs/2026-08-06-
 * coach-intelligence-design.md §3). Everything the model may output is
 * bounded — the wake pipeline parses with one repair retry and the guardrail
 * validator runs on ops before anything persists.
 *
 * THE SCHEMA'S JOB IS TO REJECT INCOHERENCE, NOT VOCABULARY (2026-08-17).
 *
 * A survival harness ran 800 plans a competent coach would actually write
 * through parse → resolve → guardrail → apply. Plans written in exactly the
 * dialect this file documents survived 100% of the time; plans carrying ONE
 * model-natural variation survived 11.3%. The gap was not danger, it was
 * spelling: a stray `rationale` on an op, the word "tempo", a rest day that is
 * honestly zero minutes long, 12×400m written as its 26 real blocks.
 *
 * A parse failure is the most expensive failure in this pipeline — it kills
 * the WHOLE wake, briefing and all, not one proposal. So every clause here is
 * asked one question: does violating it make the plan UNEXECUTABLE, or merely
 * UNUSUAL? Unexecutable still fails. Unusual is accepted and normalised:
 *
 *   - unknown keys are stripped, not fatal (`strippedPaths` reports them)
 *   - enums map the synonyms a coach writes (`enumish`); an unknown value in
 *     an OPTIONAL enum is dropped rather than thrown
 *   - caps are sized so real work fits under them, and the runaway they
 *     existed to stop is caught by `runaway_size` in coach-guardrails.ts,
 *     which refuses one proposal instead of the whole wake
 *   - empty and absent agree: `exercises: []` parses exactly like no `lift`
 *   - display lists truncate (like `prose`) rather than reject
 *
 * This lesson was already learned three times in this file before it was
 * applied here — `orNull`, `prose()` and `intish` are all the same lesson.
 */

/**
 * Calendar date, tolerantly parsed: the model is told "end of first affected
 * day", which invites a full timestamp — accept it and truncate rather than
 * fail the whole wake over a suffix that changes nothing.
 *
 * YEAR-FIRST FORMS ARE NORMALISED (2026-08-17): `2026-8-5` and `2026/08/05`
 * are the same day as `2026-08-05` and cannot be read as anything else, so
 * they are padded rather than refused. Day-first and month-first forms
 * (`05/08/2026`) are deliberately NOT accepted — that one is ambiguous by
 * nationality, and guessing it would move a session by three months.
 */
const isoDate = z.preprocess((v) => {
  if (typeof v !== "string") return v;
  const m = v.trim().match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(.*)$/);
  if (!m) return v;
  return `${m[1]}-${m[2]!.padStart(2, "0")}-${m[3]!.padStart(2, "0")}${m[4] ?? ""}`;
}, z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}([T ][\d:.+Zz-]*)?$/)
  .transform((s) => s.slice(0, 10)));

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

/**
 * A word the coach writes → the word this schema stores.
 *
 * An enum's job is to bound what the app must be able to render and file, not
 * to test the model's memory of a word list. "tempo" is the most common word
 * in running and the enum did not have it; "mobility" is the word the PRODUCT
 * uses for the discipline and the enum had "yoga" instead. Neither is a
 * malformed plan — they are the same session under the name a coach uses, and
 * the whole wake died on both.
 *
 * Case and punctuation fold first ("Easy", "TEMPO", "long_run" all land), then
 * the value itself, then the synonym table. A word in neither is returned
 * UNCHANGED so the zod error still names the real word rather than a mangled
 * one — and for optional enums the caller drops it instead of throwing.
 *
 * Synonyms are only added where the mapping is unambiguous. Where two readings
 * are genuinely available the word is deliberately absent (see the tables).
 */
const enumish = <U extends string, T extends [U, ...U[]]>(values: T, synonyms: Record<string, U>) =>
  z.preprocess((v) => {
    if (typeof v !== "string") return v;
    const folded = v.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if ((values as readonly string[]).includes(folded)) return folded;
    return synonyms[folded] ?? synonyms[folded.replace(/ /g, "")] ?? v;
  }, z.enum(values));

/**
 * A list that TRUNCATES at its cap instead of rejecting — the array form of
 * `prose`, and used for the same reason: a fifth key session or a seventh flag
 * is a verbose model, not a broken plan, and losing the tail of a display list
 * is enormously cheaper than losing the wake.
 *
 * NEVER used for `ops`: silently dropping the tail of a plan would apply half
 * an intention, which is worse than refusing it.
 */
const capped = <T extends z.ZodTypeAny>(schema: T, max: number) =>
  z.array(schema).transform((a) => (a.length > max ? a.slice(0, max) : a));

const MAX_SETS = 30;
/** 500: a 200-rep skipping block or 50 skater bounds per side are real; past
 * this the number is a typo, not a prescription. */
const MAX_REPS = 500;
/** An hour — a long ruck or carry piece is still one "set". */
const MAX_HOLD_SECONDS = 3600;
const MAX_REST_SECONDS = 1800;
/** A slow lowering past half a minute is a hold, and holdSeconds says it
 * better — but 20s eccentrics exist, and 15 refused them. */
const MAX_ECCENTRIC_SECONDS = 30;
const MAX_WEIGHT_KG = 500;
/**
 * Two MONTHS of a genuinely daily piece in one op. Was 14, which refused
 * "ten minutes of mobility every day for three weeks" — 21 dates, an
 * unremarkable ask, and the whole wake died on it.
 *
 * The cap that remains is not the runaway protection; `runaway_size` in
 * coach-guardrails.ts is, because it counts the sessions of the WHOLE
 * proposal (20 ops × this cap is the number that actually matters) and
 * refuses one proposal rather than the entire output.
 */
const MAX_ADD_DATES = 60;
/** 12×400m off 60s is 26 blocks; 30×30/30 is 60. The old cap of 12 could not
 * hold a single honest interval session. */
const MAX_RUN_BLOCKS = 60;
/** A full-body circuit is fourteen stations, and a mobility flow can be
 * twenty. Twelve was a guess. */
const MAX_EXERCISES = 30;
/** A week's sessions in one structural op: seven days with doubles, and
 * headroom. */
const MAX_WEEK_SESSIONS = 21;
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
      z.object({ type: z.literal("bodyweight") }),
      z.object({ type: z.literal("kg"), value: z.number().min(0).max(MAX_WEIGHT_KG) }),
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
 *
 * NEITHER IS REQUIRED (2026-08-17). A `.refine()` used to insist on one of
 * them, and "three ramping sets of squats, stop when it gets heavy" was
 * refused: the set count IS the prescription there, and the load is the
 * athlete's judgement on the day. `formatExercise` renders "3 sets" for it,
 * so nothing downstream needs the number to exist.
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
  });
export type CoachExercise = z.infer<typeof coachExerciseSchema>;

/**
 * One exercise as a line of text — the single formatter, so the stage
 * summary the worker stores, the coach's own dossier, and the session sheet
 * cannot disagree about what "3×8/side @ 4s down" means.
 */
export function formatExercise(e: CoachExercise): string {
  // Sets alone is a legitimate prescription ("three ramping sets"), so the
  // reps-less case gets its own honest rendering rather than "3×undefined".
  const work =
    e.holdSeconds !== undefined
      ? `${e.sets}×${e.holdSeconds}s`
      : e.reps !== undefined
        ? `${e.sets}×${e.reps}`
        : `${e.sets} sets`;
  const side = e.perSide ? "/side" : "";
  const load = e.weight.type === "kg" ? ` @ ${e.weight.value} kg` : "";
  const tempo = e.eccentricSeconds !== undefined ? ` (${e.eccentricSeconds}s down)` : "";
  return `${e.name} ${work}${side}${load}${tempo}`;
}

/**
 * How a block is measured. Synonyms are UNIT-NEUTRAL only: "time"/"minutes"
 * mean the same as "duration", "meters" the same as "distance". "km" and
 * "miles" are deliberately absent — the value's unit is fixed by the kind, so
 * accepting `{kind:"km", value:5}` would silently prescribe five metres.
 */
const RUN_BLOCK_KIND_SYNONYMS: Record<string, "duration" | "distance"> = {
  time: "duration",
  minutes: "duration",
  minute: "duration",
  mins: "duration",
  min: "duration",
  timed: "duration",
  meters: "distance",
  metres: "distance",
  meter: "distance",
  metre: "distance",
  m: "distance",
};

/**
 * The effort of a block, in the words runners use. "tempo" is threshold —
 * that single missing word killed 7 plans in 800. Absent entries are the
 * ambiguous ones: "race pace" depends on the race, "fartlek" is a session
 * shape rather than one effort, and both are better dropped than guessed
 * (see `intensity` below — an unknown word is dropped, not fatal).
 */
const RUN_INTENSITY_SYNONYMS: Record<string, "easy" | "steady" | "threshold" | "interval" | "rest"> = {
  tempo: "threshold",
  lt: "threshold",
  "lactate threshold": "threshold",
  "comfortably hard": "threshold",
  sweetspot: "threshold",
  vo2: "interval",
  vo2max: "interval",
  "vo2 max": "interval",
  sprint: "interval",
  repetition: "interval",
  rep: "interval",
  reps: "interval",
  fast: "interval",
  hard: "interval",
  moderate: "steady",
  marathon: "steady",
  "marathon pace": "steady",
  "steady state": "steady",
  aerobic: "easy",
  base: "easy",
  conversational: "easy",
  recovery: "easy",
  jog: "easy",
  float: "easy",
  warmup: "easy",
  "warm up": "easy",
  cooldown: "easy",
  "cool down": "easy",
  z2: "easy",
  zone2: "easy",
  walk: "rest",
  standing: "rest",
  off: "rest",
};

/** One structured run block — the COROS-write-confirmed topology. */
export const coachRunBlockSchema = z.object({
  kind: enumish(["duration", "distance"], RUN_BLOCK_KIND_SYNONYMS),
  /** Minutes for duration blocks; meters for distance blocks. `intish` for the
   * same reason as everywhere else in this file: `"400"` and `2.5` are numbers
   * a coach writes, and a bare `z.number().int()` rejected both. */
  value: intish(1, 100_000),
  /**
   * Optional by design, and therefore DROPPED rather than fatal when the word
   * is one no synonym covers: a block with no stated intensity is a block the
   * athlete runs by feel, which is a real prescription and infinitely better
   * than losing the wake over "fartlek". `strippedPaths` reports the drop.
   */
  intensity: orNull(enumish(["easy", "steady", "threshold", "interval", "rest"], RUN_INTENSITY_SYNONYMS).optional()).catch(
    undefined,
  ),
});
export type CoachRunBlock = z.infer<typeof coachRunBlockSchema>;

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
export const coachExerciseBlockSchema = z.object({
  rounds: orNull(intish(1, 20).optional()),
  /**
   * EMPTY IS ALLOWED, because absent already was (2026-08-17). "Strength
   * Friday, we'll pick the movements on the day" is a real prescription — the
   * duration is the load — and omitting the whole `lift` key expressed it
   * perfectly while `lift: {exercises: []}` killed the wake. Two spellings of
   * one intention cannot have opposite fates; the session still files as
   * strength either way (`sessionSport` reads the body's presence).
   */
  exercises: z.array(coachExerciseSchema).max(MAX_EXERCISES),
});
export type CoachExerciseBlock = z.infer<typeof coachExerciseBlockSchema>;

/**
 * How the coach names a session's category → how the app files it.
 *
 * "mobility" is the headline case: it is the word this product uses for the
 * discipline, in the UI and in the prompt, and the enum had "yoga" and
 * "recovery" and not it. Every one of these mappings is a filing decision the
 * app is already making — `sessionSport` turns the category into a
 * discipline — so a wrong guess here corrupts the garden's balance. That is
 * why the ambiguous words are NOT in this table:
 *
 *   - "cross", "bike", "swim", "cardio": the app has three disciplines and
 *     none of them is cycling. Filing a bike ride as an easy RUN is exactly
 *     the corruption the mobility body was added to stop, so it is refused.
 *   - "time trial": a race effort that is not the goal race, and the `race`
 *     category drives taper logic. The coach can write `quality` and say so.
 *   - "double", "brick": a shape, not a category.
 */
const SESSION_CATEGORY_SYNONYMS: Record<
  string,
  "easy" | "long" | "quality" | "recovery" | "race" | "rest" | "strength" | "yoga"
> = {
  mobility: "yoga",
  stretch: "yoga",
  stretching: "yoga",
  flexibility: "yoga",
  prehab: "yoga",
  rehab: "yoga",
  pilates: "yoga",
  tempo: "quality",
  threshold: "quality",
  interval: "quality",
  intervals: "quality",
  speed: "quality",
  track: "quality",
  workout: "quality",
  hills: "quality",
  hill: "quality",
  fartlek: "quality",
  hard: "quality",
  "long run": "long",
  longrun: "long",
  endurance: "long",
  off: "rest",
  "rest day": "rest",
  "day off": "rest",
  aerobic: "easy",
  base: "easy",
  run: "easy",
  jog: "easy",
  shakeout: "recovery",
  regen: "recovery",
  "active recovery": "recovery",
  lift: "strength",
  lifting: "strength",
  gym: "strength",
  weights: "strength",
  resistance: "strength",
  "s c": "strength", // "S&C" — the ampersand folds to a space
  race: "race",
  event: "race",
};

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
 *
 * The one-body `.refine()` STAYS STRICT. A planned_workouts row has one sport
 * and one stage list; a session carrying both a run and a lift is two
 * sessions, and picking one of them by precedence would silently throw away
 * half of what the coach wrote. That is incoherence, not vocabulary.
 */
export const coachSessionSchema = z
  .object({
    category: enumish(
      ["easy", "long", "quality", "recovery", "race", "rest", "strength", "yoga"],
      SESSION_CATEGORY_SYNONYMS,
    ),
    title: prose(80),
    /**
     * ZERO IS A REAL SESSION: "take Sunday completely off" is a rest day, and
     * a rest day is zero minutes long. The old floor of 5 forced the coach to
     * invent five minutes of something or drop the day.
     *
     * The ceiling is a day, not six hours — a 380-minute ultra long run was
     * refused by a 360 cap, and nothing between "six hours" and "a whole day"
     * is incoherent enough to be worth killing a wake over.
     */
    durationMinutes: intish(0, 1440),
    /** Empty blocks = an unstructured run, the same as omitting `run`. */
    run: orNull(z.object({ blocks: z.array(coachRunBlockSchema).max(MAX_RUN_BLOCKS) }).optional()),
    lift: orNull(coachExerciseBlockSchema.optional()),
    mobility: orNull(coachExerciseBlockSchema.optional()),
  })
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

const datedSession = z.object({ date: isoDate, session: coachSessionSchema });

export const coachShapeWeekSchema = z.object({
  weekStart: isoDate,
  // Truncate, never reject: these are display strings, and a 53-char
  // volume target killed three plan drafts in a row (audit follow-up).
  volumeTarget: prose(40),
  // …and the list truncates for the same reason: naming the week's fifth
  // session is a thorough coach, not a broken plan.
  keySessions: capped(prose(60), 8),
});
export type CoachShapeWeek = z.infer<typeof coachShapeWeekSchema>;

/**
 * The ONLY ways the coach can touch a plan.
 *
 * NOTHING HERE IS `.strict()` ANY MORE (2026-08-17). The single biggest killer
 * in the survival harness was one unexpected key — 32 plans of 800, 22 of them
 * a `rationale` the model attached to an op because the schema gives it one
 * rationale for a whole proposal and it had a reason for THIS op. That is a
 * model being helpful, not a malformed plan, and it took the briefing down
 * with it. Unknown keys are now stripped; `strippedPaths` reports every one so
 * a key the coach keeps reaching for shows up in the logs as a schema gap
 * rather than as silence.
 */
export const coachOpSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ease"), workoutId: echoedId, session: coachSessionSchema }),
  z.object({ kind: z.literal("move"), workoutId: echoedId, toDate: isoDate }),
  z.object({ kind: z.literal("swap"), dayA: isoDate, dayB: isoDate }),
  // A skip with no stated reason is still a skip: the reason is for the
  // athlete to read, and its absence cannot stop the op being performed.
  z.object({ kind: z.literal("skip"), workoutId: echoedId, reason: orNull(prose(200).optional()) }),
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
      /** Empty means the same as absent — one date, the primary one. */
      dates: orNull(z.array(isoDate).max(MAX_ADD_DATES).optional()),
      session: coachSessionSchema,
    }),
  z.object({
    kind: z.literal("reshapeWeek"),
    planId: echoedId,
    weekStart: isoDate,
    sessions: z.array(datedSession).max(MAX_WEEK_SESSIONS),
  }),
  z.object({
    kind: z.literal("firmUp"),
    planId: echoedId,
    weekStart: isoDate,
    /**
     * `.min(1)` STAYS, unlike the exercise list. The whole content of a firmUp
     * IS its sessions: an empty one cannot do anything, and an op that applies
     * cleanly while changing nothing is the silent class this pipeline has
     * spent three audits removing. An empty `exercises` still puts a real
     * session on a real day; an empty firmUp puts nothing anywhere.
     */
    sessions: z.array(datedSession).min(1).max(MAX_WEEK_SESSIONS),
  }),
  z.object({
    kind: z.literal("extendPlan"),
    planId: echoedId,
    /** Same reasoning as firmUp: no weeks is no extension. */
    shapeWeeks: z.array(coachShapeWeekSchema).min(1).max(30),
  }),
  z.object({ kind: z.literal("windDown"), planId: echoedId, sessions: z.array(datedSession).max(MAX_WEEK_SESSIONS) }),
  z
    .object({
      kind: z.literal("createPlan"),
      discipline: enumish(["run", "lift"], {
        strength: "lift",
        lifting: "lift",
        weights: "lift",
        gym: "lift",
        resistance: "lift",
        running: "run",
        runs: "run",
      }),
      name: prose(60),
      startDate: isoDate,
      endDate: isoDate,
      raceDate: orNull(isoDate.optional()),
      /**
       * Four firm weeks at six sessions is 24; a six-week firm block is 42.
       *
       * The floor is gone: "draft me a twelve-week block, we'll firm each week
       * up as it comes" is a plan made entirely of shape weeks, and
       * `.min(1)` refused it. A createPlan carrying neither firm sessions nor
       * shape weeks is merely an empty plan — apply creates the row and
       * reports it in `created`, so nothing is silent — and the cross-field
       * check that would forbid it cannot live here anyway: a
       * discriminatedUnion member must be a plain object, never a `.refine()`.
       */
      firmSessions: z.array(datedSession).max(60),
      shapeWeeks: z.array(coachShapeWeekSchema).max(30),
    }),
  z.object({ kind: z.literal("retirePlan"), planId: echoedId }),
  // Converges the two race truths (imported plan's race-labeled row vs the
  // athlete's stated race day) once the athlete confirms which is right:
  // "settings" demotes the plan's row to a regular quality session,
  // "plan" moves the athlete's race-day setting to the plan's date.
  //
  // `keep` STAYS a bare enum: the two values are opposite mutations of the
  // athlete's race day, and there is no synonym for either that is not a
  // guess about which truth they meant.
  z.object({ kind: z.literal("resolveRaceConflict"), keep: z.enum(["settings", "plan"]) }),
]);
export type CoachOp = z.infer<typeof coachOpSchema>;

/** An `add` op's full date set — the ONE reader of `date`+`dates`, so the
 * calendar the guardrails simulate, the days a proposal supersedes, and the
 * sessions `applyOps` actually writes can never disagree about how many
 * sessions one op means. Unioned, de-duplicated, in date order. */
export function addOpDates(op: Extract<CoachOp, { kind: "add" }>): string[] {
  return [...new Set([op.date, ...(op.dates ?? [])])].sort();
}

export const coachProposalDraftSchema = z.object({
  /** The card's name. Required: a proposal the athlete cannot identify is not
   * one they can approve, and no default is better than the coach's own word. */
  title: prose(80),
  /** Supporting text. Missing supporting text is a thin card, not a broken
   * one — the ops are the proposal. */
  evidence: prose(200).nullish().transform((s) => s ?? ""),
  rationale: prose(2000).nullish().transform((s) => s ?? ""),
  /** min(end of first affected day, +72h). The cap is applied downstream
   * (coach-wake), which also supplies the default when this is absent — so an
   * omitted expiry costs the proposal nothing. */
  expiresAt: orNull(isoDate.optional()),
  flags: capped(prose(120), 10).default([]),
  /**
   * `ops` NEVER truncates and keeps its floor. A proposal with no ops is prose
   * wearing an approve button, and dropping the tail of a plan would apply
   * half an intention — the one thing worse than refusing it. 20 is well past
   * any real proposal (a whole week of restructuring is one op).
   */
  ops: z.array(coachOpSchema).min(1).max(20),
});
export type CoachProposalDraft = z.infer<typeof coachProposalDraftSchema>;

export const coachMemoryOpSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("add"),
    /**
     * What kind of thing this is worth remembering. The synonyms are the words
     * a model reaches for; anything else is NOT rejected but filed as a
     * `note`, the least-committal of the three — a memory the coach thought
     * worth keeping should never cost the athlete their whole wake over the
     * label it arrived under.
     */
    kind: enumish(["fact", "rule", "note"], {
      preference: "rule",
      constraint: "rule",
      rules: "rule",
      standing: "rule",
      facts: "fact",
      observation: "note",
      reminder: "note",
      event: "note",
      temporary: "note",
      profile: "fact",
      about: "fact",
      goal: "fact",
    }).catch("note"),
    text: prose(300),
    expiresAt: orNull(isoDate.optional()),
  }),
  z.object({ op: z.literal("update"), id: echoedId, text: prose(300) }),
  z.object({ op: z.literal("expire"), id: echoedId }),
]);
export type CoachMemoryOp = z.infer<typeof coachMemoryOpSchema>;

/** One wake's complete structured output. Restraint is first-class: an
 * all-null/empty output is a fully successful wake — which is exactly why
 * every field here is also OPTIONAL. A model that writes only a briefing and
 * a proposal has said everything it had to say; making it also type
 * `"question": null, "memoryOps": []` to be understood was a formality with
 * the whole wake riding on it. */
export const wakeOutputSchema = z
  .object({
    briefing: z
      .string()
      .transform((s) => (s.length > 4000 ? s.slice(0, 4000) : s))
      .nullish()
      .default(null),
    /** Truncated, not refused: an eighth proposal is a model that would not
     * stop, and losing it is better than losing the seven before it. */
    proposals: capped(coachProposalDraftSchema, 8).default([]),
    question: z
      .object({ text: prose(300), chips: capped(z.string().min(1).max(60), 6).default([]) })
      .nullish()
      .default(null),
    memoryOps: capped(coachMemoryOpSchema, 24).default([]),
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
  });
export type WakeOutput = z.infer<typeof wakeOutputSchema>;

/**
 * EVERYTHING THE PARSE THREW AWAY, as dotted paths — the price of not being
 * strict, paid in observability instead of in dead wakes.
 *
 * Stripping unknown keys is right (a `rationale` on an op must not kill a
 * briefing) but stripping them SILENTLY would be a second mistake: a key the
 * coach reaches for every wake is a schema gap, and the only way to learn
 * that is to see it. So the wake logs this diff after a successful parse, and
 * it catches three kinds of loss in one walk — an unknown key, an optional
 * enum whose word no synonym covered, and the tail of a truncated list.
 *
 * Cheap by construction: it walks the RAW value, not the schema, and stops at
 * `limit` paths. Values that were null or undefined to begin with are not
 * losses and are not reported.
 */
export function strippedPaths(raw: unknown, parsed: unknown, limit = 40): string[] {
  const out: string[] = [];
  const isObj = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v);
  const walk = (a: unknown, b: unknown, path: string): void => {
    if (out.length >= limit) return;
    if (Array.isArray(a) && Array.isArray(b)) {
      for (let i = 0; i < a.length; i++) {
        if (i >= b.length) out.push(`${path}[${i}]`);
        else walk(a[i], b[i], `${path}[${i}]`);
        if (out.length >= limit) return;
      }
      return;
    }
    if (isObj(a) && isObj(b)) {
      for (const [k, v] of Object.entries(a)) {
        if (v === null || v === undefined) continue; // absent on purpose
        const here = path ? `${path}.${k}` : k;
        if (!(k in b) || b[k] === undefined) out.push(here);
        else walk(v, b[k], here);
        if (out.length >= limit) return;
      }
    }
  };
  walk(raw, parsed, "");
  return out;
}
