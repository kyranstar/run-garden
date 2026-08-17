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
 *
 * AND ITS LIMIT, LEARNED THE HARD WAY THE NEXT DAY (2026-08-17):
 *
 *   TOLERANCE MAY CHANGE A SPELLING. IT MAY NEVER CHANGE A NUMBER.
 *
 * `intish` was extended to unit-bearing fields, where reading the leading
 * digits and discarding the rest is not tolerance but a wrong number in
 * tolerance's clothing: `{kind:"distance", value:"1km"}` stored ONE METRE and
 * rendered "0.0km"; `durationMinutes: "1.5 hours"` stored 2, so the calendar
 * block was 120 seconds while the same row's summary said "90 min";
 * `restSeconds: "2 min"` stored two seconds; `weight: "2×20kg"` stored the
 * multiplier. Every one of them PARSED, passed the guardrails, and reached the
 * athlete's calendar — which is strictly worse than the rejection it replaced,
 * because a rejection gets a bounded repair retry and a stored number gets
 * trained on. So every field whose unit this schema fixes now goes through
 * {@link quantity}: a unit the coach writes is CONVERTED or REFUSED, never
 * dropped, and the two magnitudes that are nonsense in every context (a
 * one-metre rep, a thirteen-hour block) are bounded here rather than left to
 * an advisory the athlete would have to catch by eye.
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
 * Model-natural COUNT — a pure number with no unit: sets, reps, rounds.
 *
 * A coach that writes `"reps": "8"`, `"sets": 3.0` or `"reps": "8-12"` means
 * the number in all three cases, and the studio's bare `z.number().int()`
 * rejected two of them. A range keeps its LOW end, which is what a coach means
 * by "8–12": the number you are guaranteed to do.
 *
 * DELIBERATELY NOT USED FOR ANY FIELD WITH A UNIT (2026-08-17). `intish` reads
 * the leading digits and throws the rest away, which is right for a count and
 * catastrophic for a quantity: `"1km"` in a metres field became 1, `"2 min"` in
 * a seconds field became 2, `"1.5 hours"` in a minutes field became 2. Every
 * one of those parsed, passed the guardrails, and reached the athlete's
 * calendar as a number off by one to three orders of magnitude. Unit-bearing
 * fields go through {@link quantity}, which honours the unit or refuses it.
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

/* ======================================================================= *
 * UNITS — honour it or refuse it, never ignore it.
 *
 * Every field below whose unit is fixed by the schema (minutes, seconds,
 * metres, kilos) is read by {@link quantity} rather than by digit extraction.
 * The rule, and the reason:
 *
 *   A UNIT THE MODEL WROTE IS EITHER CONVERTED OR REFUSED. Never dropped.
 *
 * Dropping it is not tolerance, it is a wrong number wearing tolerance's
 * clothes — and a wrong number is worse than a retried wake, because the wake
 * has a bounded repair loop and the athlete's calendar does not. Measured on
 * 2026-08-17, all through parse → applyOps → the stored row: `{kind:"distance",
 * value:"1km"}` stored 1 metre and rendered "0.0km"; `durationMinutes:
 * "1.5 hours"` stored 2, so the calendar block was 120 seconds while the same
 * row's summary said "90 min"; `restSeconds: "2 min"` stored 2 seconds;
 * `restSeconds: "1:00"` stored 1; `weight: "2×20kg"` stored the multiplier.
 *
 * The irony this replaces: `RUN_BLOCK_KIND_SYNONYMS` refused `kind:"km"`
 * because it "would silently prescribe five metres", and the identical hazard
 * through `value` was wide open. Both are closed the same way now — whichever
 * of the two states a unit, it is honoured (see `coachRunBlockSchema`).
 * ======================================================================= */

type Dimension = "time" | "distance" | "mass";

const LB_TO_KG = 0.45359237;

/**
 * Every unit token this file understands, in BASE units: seconds, metres,
 * kilograms.
 *
 * Matched EXACTLY after folding, never by prefix — "min" and "mi" differ by
 * three orders of magnitude and a prefix match would read one as the other.
 * `m` is deliberately in two tables: it is minutes in a time field and metres
 * in a distance field, which is not ambiguity but context (see
 * {@link readQuantity}: the field's own dimension is looked up first).
 */
const UNIT_TOKENS: Record<Dimension, Record<string, number>> = {
  time: {
    s: 1, sec: 1, secs: 1, second: 1, seconds: 1, '"': 1,
    m: 60, min: 60, mins: 60, minute: 60, minutes: 60, "'": 60,
    h: 3600, hr: 3600, hrs: 3600, hour: 3600, hours: 3600,
  },
  distance: {
    m: 1, meter: 1, meters: 1, metre: 1, metres: 1,
    km: 1000, k: 1000, kilometer: 1000, kilometers: 1000, kilometre: 1000, kilometres: 1000,
    mi: 1609.344, mile: 1609.344, miles: 1609.344,
    yd: 0.9144, yds: 0.9144, yard: 0.9144, yards: 0.9144,
  },
  mass: {
    kg: 1, kgs: 1, kilo: 1, kilos: 1, kilogram: 1, kilograms: 1,
    lb: LB_TO_KG, lbs: LB_TO_KG, pound: LB_TO_KG, pounds: LB_TO_KG,
    g: 0.001, gram: 0.001, grams: 0.001,
  },
};

/**
 * How ONE field is measured: its dimension, what its own unit is worth in base
 * units, the resolution the stored number is snapped to, and how to tell the
 * model what to write when the value could not be read (the zod message goes
 * verbatim into the wake's repair prompt).
 */
interface FieldUnit {
  dim: Dimension;
  /** Base units in one of this field's units — a minutes field is 60. */
  per: number;
  /** Base units → the number this field stores. */
  quantise: (base: number) => number;
  name: string;
  hint: string;
}

/** Whole seconds. */
const SECONDS: FieldUnit = {
  dim: "time",
  per: 1,
  quantise: (base) => Math.round(base),
  name: "seconds",
  hint: `seconds as a number (45), or with a unit ("2 min", "1:30")`,
};
/** Whole minutes — a session's own length is a calendar block, and nothing
 * downstream can hold a fraction of a minute of it. */
const WHOLE_MINUTES: FieldUnit = {
  dim: "time",
  per: 60,
  quantise: (base) => Math.round(base / 60),
  name: "minutes",
  hint: `minutes as a number (90), or with a unit ("1.5 h")`,
};
/**
 * Minutes, TO THE SECOND — the run-block unit.
 *
 * The stored number is still minutes, because every consumer computes
 * `value * 60` (coach-apply's `durationSeconds`, create-executor's whole-second
 * `targetValue`, describeOps' `formatStageDuration`) and that arithmetic must
 * not change meaning. What changes is that the number no longer has to be a
 * WHOLE minute: 0.75 is a 45-second stride, and `0.75 * 60` is exactly 45.
 *
 * `seconds / 60` is exact in binary for every whole minute and for every
 * five-second step under a minute — i.e. for every value the athlete's real
 * library contains and every value a coach writes. For the 3.8% of whole
 * seconds where it is not (125/60 has no exact double), `value * 60` is that
 * second to within 2.3e-13, which every consumer rounds or formats away; the
 * test that pins this is in coach.test.ts. See the note on sub-minute blocks
 * in `coachRunBlockSchema`.
 */
const MINUTES_TO_THE_SECOND: FieldUnit = {
  dim: "time",
  per: 60,
  quantise: (base) => Math.round(base) / 60,
  name: "minutes",
  hint: `minutes as a number (40), seconds with their unit ("45s"), or a fraction (0.75)`,
};
/** Whole metres. */
const METRES: FieldUnit = {
  dim: "distance",
  per: 1,
  quantise: (base) => Math.round(base),
  name: "meters",
  hint: `meters as a number (400), or with a unit ("1km", "3 miles")`,
};
/** Kilos to a tenth — the resolution a plate exists in. */
const KILOS: FieldUnit = {
  dim: "mass",
  per: 1,
  quantise: (base) => Math.round(base * 10) / 10,
  name: "kilos",
  hint: `kilos as a number (20), or with a unit ("45lb") — "heavy" and "70% 1RM" belong in the note`,
};

interface Reading {
  dim: Dimension;
  /** Seconds, metres or kilograms. */
  base: number;
}
type ReadFailure = { error: string };
const failed = (r: Reading | ReadFailure): r is ReadFailure => "error" in r;

const NUMBER = String.raw`\d+(?:\.\d+)?`;
const UNIT = String.raw`[a-z%'"]*`;
const CLOCK = /^(\d{1,3}):([0-5]\d)(?::([0-5]\d))?$/;
const RANGE = new RegExp(String.raw`^(${NUMBER})\s*(${UNIT})\s*(?:-|to|~)\s*(${NUMBER})\s*(${UNIT})$`);
const TIMES = new RegExp(String.raw`^(${NUMBER})\s*(${UNIT})\s*x\s*(${NUMBER})\s*(${UNIT})$`);
const TOKENS = new RegExp(String.raw`(-?${NUMBER})\s*(${UNIT})`, "g");

/** Case, spacing, thousands commas and the four multiplication signs folded —
 * so `"2 × 20 KG"`, `"2x20kg"` and `"1,500m"` are the strings they mean. */
function foldQuantity(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/(\d),(?=\d{3}(?!\d))/g, "$1")
    .replace(/[×✕⨯*]/g, "x")
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ");
}

/**
 * THE READER. What the model wrote → a quantity in base units, a refusal with
 * a reason, or `undefined` for "this is not a number at all" (which the caller
 * decides about: a weight of "heavy" is bodyweight, everything else is a type
 * error naming its own field).
 *
 * `alt` is the OTHER dimension a unit may legitimately name — supplied only by
 * the run block, where the value's unit is allowed to overrule the block's
 * kind (`{kind:"duration", value:"5km"}` is a distance block, not five
 * minutes). Everywhere else a unit from another dimension is a refusal: a
 * `restSeconds` of "2 reps" is not two seconds, it is a mistake.
 */
function readQuantity(raw: unknown, u: FieldUnit, alt?: Dimension): Reading | ReadFailure | undefined {
  if (typeof raw === "number") return Number.isFinite(raw) ? { dim: u.dim, base: raw * u.per } : undefined;
  if (typeof raw !== "string") return undefined;
  const s = foldQuantity(raw);
  if (!/\d/.test(s)) return undefined;
  const quoted = JSON.stringify(raw);

  /** One number and the unit written against it. */
  const resolve = (n: number, token: string): Reading | ReadFailure => {
    if (!token) return { dim: u.dim, base: n * u.per };
    const here = UNIT_TOKENS[u.dim][token];
    if (here !== undefined) return { dim: u.dim, base: n * here };
    const there = alt === undefined ? undefined : UNIT_TOKENS[alt][token];
    if (there !== undefined) return { dim: alt!, base: n * there };
    return { error: `${quoted}: "${token}" is not ${u.name} — write ${u.hint}` };
  };

  // "1:30" / "1:30:00". Minutes:seconds where the field IS seconds, and
  // hours:minutes:seconds always. In a MINUTES field the two-part form is
  // refused rather than guessed: "1:30" is 90 minutes to one reader and 90
  // seconds to another, and that is a 60× error either way.
  const clock = CLOCK.exec(s);
  if (clock) {
    if (u.dim !== "time") return { error: `${quoted} is a clock time, not ${u.name} — write ${u.hint}` };
    const [a, b, c] = [Number(clock[1]), Number(clock[2]), clock[3] === undefined ? null : Number(clock[3])];
    if (c !== null) return { dim: "time", base: a * 3600 + b * 60 + c };
    if (u.per === 1) return { dim: "time", base: a * 60 + b };
    return { error: `${quoted} could be ${a}h${clock[2]} or ${a * 60 + b} seconds — write ${u.hint}` };
  }

  // "8-12", "20-24kg", "1.5-2 hours": the low end, carrying whichever side
  // stated the unit. Same reading `intish` already gives ranges of reps.
  const range = RANGE.exec(s);
  if (range) return resolve(Number(range[1]), range[2] || range[4] || "");

  // "2×20kg" — two twenties, so the LOAD is 20 and the 2 is a count. Only a
  // mass field reads it: "12x400m" in a run block is a rep scheme, and
  // collapsing it to one 400m block would silently drop eleven reps.
  const times = TIMES.exec(s);
  if (times) {
    if (u.dim !== "mass") {
      return { error: `${quoted} is a rep scheme, not one ${u.name} value — write one block per piece of work` };
    }
    const [n1, t1, n2, t2] = [Number(times[1]), times[2] ?? "", Number(times[3]), times[4] ?? ""];
    return t1 && !t2 ? resolve(n1, t1) : resolve(n2, t2 || t1);
  }

  const tokens = [...s.matchAll(TOKENS)].map((m) => ({ n: Number(m[1]), t: m[2] ?? "" }));
  if (tokens.length === 0) return undefined;

  // "1h30m", "2 min 30 s", "5'30\"" — a compound quantity, summed. Every part
  // must carry a unit: "1h30" is 60 or 90 depending on the reader, so it falls
  // through to the refusal below rather than being guessed.
  if (tokens.length > 1 && tokens.every((t) => t.t && UNIT_TOKENS[u.dim][t.t] !== undefined)) {
    return { dim: u.dim, base: tokens.reduce((sum, t) => sum + t.n * UNIT_TOKENS[u.dim][t.t]!, 0) };
  }
  if (tokens.length > 1) {
    return { error: `${quoted} holds more than one number — write a single ${u.name} value (${u.hint})` };
  }
  return resolve(tokens[0]!.n, tokens[0]!.t);
}

/**
 * A field measured in a fixed unit. Bounds are in the FIELD's unit; the stored
 * number is quantised to the field's resolution, so what the schema returns is
 * always a number every consumer can multiply by 60 and store.
 */
const quantity = (u: FieldUnit, min: number, max: number) =>
  z
    .union([z.number(), z.string()])
    .transform((v, ctx) => {
      const r = readQuantity(v, u);
      if (r === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${JSON.stringify(v)} is not a number of ${u.name} — write ${u.hint}`,
        });
        return z.NEVER;
      }
      if (failed(r)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: r.error });
        return z.NEVER;
      }
      return u.quantise(r.base);
    })
    .pipe(z.number().min(min).max(max));

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
/** Case and punctuation out of a word the model wrote, so "Long_Run", "long
 * run" and "LONG RUN" are one lookup. Shared with the run-block kind table,
 * which does the same folding against units rather than synonyms. */
const fold = (v: string): string =>
  v
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const enumish = <U extends string, T extends [U, ...U[]]>(values: T, synonyms: Record<string, U>) =>
  z.preprocess((v) => {
    if (typeof v !== "string") return v;
    const folded = fold(v);
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

/**
 * A RUN BLOCK'S PLAUSIBLE RANGE — the bounds that stop a unit error, or a
 * dropped "k", reaching the athlete's calendar as a prescription.
 *
 * These live in the SCHEMA rather than in coach-guardrails.ts, and the
 * placement is the argument: a guardrail is advisory, it exists so the ATHLETE
 * can weigh a training judgement, and "run one metre" is not a judgement they
 * can weigh — it is a typo wearing an approve button. The guardrails never see
 * a block value either (they read `durationMinutes` only), so a 1-metre rep is
 * invisible there. Refusing at the parse costs one repair round-trip, which
 * the wake can afford and a wrong calendar row cannot.
 */
/** Five seconds. Under it, a "block" is a movement rather than a piece of
 * work — and every value below it seen in the wild was a unit error. */
const MIN_BLOCK_SECONDS = 5;
/** Twelve hours in one continuous block: a hundred-miler, and headroom. The
 * old ceiling was 100_000, which as MINUTES is sixty-nine days. */
const MAX_BLOCK_MINUTES = 720;
/** Ten metres is a shuttle. One metre is not a rep, it is a dropped "k". */
const MIN_BLOCK_METERS = 10;
/** A hundred kilometres in one block. */
const MAX_BLOCK_METERS = 100_000;
/**
 * How much more work a block list may describe than the session it belongs to
 * before the two numbers stop being about the same session.
 *
 * A coach under-counts all the time (blocks for the interval set only, no
 * warm-up), and that is fine — this is one-sided. Over-counting is the unit
 * error: eight reps written as `{kind:"duration", value:45}` for a
 * 45-SECOND rep describe six hours of work inside a fifty-minute session,
 * which is 7× and up. Five is chosen with headroom over the worst legitimate
 * case the survival harness produces (a 61-minute 12×400m block list attached
 * to a 20-minute eased session, 3.05×) and well under every mis-scale.
 */
const MAX_BLOCK_OVERRUN = 5;

/**
 * Load, as a coach actually writes it. The studio's discriminated union is
 * unproducible without being told the shape — the live 2026-08-16 failure
 * rejected three exercises for a missing `weight` on a WALL SIT, where the
 * only true answer is "your body". So: absent means bodyweight, a bare
 * number means kilos, and the common prose forms are understood. The studio
 * union itself still parses, so a model that copies that shape is right too.
 *
 * THE UNIT IS READ, NOT SKIPPED (2026-08-17). The old regex took the first
 * number and an OPTIONAL trailing unit, so `"2×20kg"` — two twenty-kilo
 * dumbbells, the way every coach writes a pair — stored 2 kg, and `"70%"`
 * stored seventy kilos of nothing. Both go through {@link readQuantity} now:
 * a multiplier resolves to the load rather than the count, and a unit that is
 * not a mass is refused instead of dropped. Prose with no number at all
 * ("heavy", "moderate") still means bodyweight, because the honest place for
 * it is `note` and refusing it would cost a wake over a word.
 */
export type CoachWeight = { type: "bodyweight" } | { type: "kg"; value: number };

const weightObject = z.discriminatedUnion("type", [
  z.object({ type: z.literal("bodyweight") }),
  z.object({ type: z.literal("kg"), value: z.number().min(0).max(MAX_WEIGHT_KG) }),
]);

export const coachWeightSchema = z
  .unknown()
  .transform((v, ctx): CoachWeight => {
    if (v === null || v === undefined) return { type: "bodyweight" };
    if (typeof v === "object") {
      const parsed = weightObject.safeParse(v);
      if (parsed.success) return parsed.data;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${JSON.stringify(v)} is not a load — write kilos as a number (20), or {"type":"bodyweight"}`,
      });
      return z.NEVER;
    }
    const r = readQuantity(v, KILOS);
    // "heavy", "moderate", "bodyweight" — a real prescription with no number
    // in it. It belongs in `note`, and it is never worth a wake.
    if (r === undefined) return { type: "bodyweight" };
    if (failed(r)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: r.error });
      return z.NEVER;
    }
    const kg = KILOS.quantise(r.base);
    if (kg <= 0) return { type: "bodyweight" };
    if (kg > MAX_WEIGHT_KG) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${kg}kg is past the ${MAX_WEIGHT_KG}kg ceiling` });
      return z.NEVER;
    }
    return { type: "kg", value: kg };
  })
  .default({ type: "bodyweight" });

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
     * timed effort (30s skier hops). One of reps/holdSeconds. A unit is
     * honoured, so "45s", "1:30" and "2 min" are 45, 90 and 120. */
    holdSeconds: orNull(quantity(SECONDS, 3, MAX_HOLD_SECONDS).optional()),
    /** The prescription happens on EACH leg/arm — sets × reps per side. */
    perSide: orNull(z.boolean().optional()),
    /** Seconds to lower under control. The eccentric is the point of a
     * ski-prep squat; "4s down" had no field before this. */
    eccentricSeconds: orNull(quantity(SECONDS, 1, MAX_ECCENTRIC_SECONDS).optional()),
    weight: coachWeightSchema,
    /** Seconds between sets. "2 min" is 120 and "1:00" is 60 — both used to
     * store the leading digits and prescribe a two-second rest. */
    restSeconds: z
      .preprocess(
        (v) => (v === null || v === undefined ? DEFAULT_REST_SECONDS : v),
        quantity(SECONDS, 0, MAX_REST_SECONDS),
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
 * How a block is measured — and, when the word carries one, IN WHAT UNIT.
 *
 * This table used to be unit-NEUTRAL, with a comment explaining that
 * `{kind:"km", value:5}` had to be refused because it "would silently
 * prescribe five metres". That was true of a schema which threw the unit away.
 * It is not true of one that reads it: a kind of "km" says the value is
 * kilometres, and five of them is 5000 metres. Every entry below is therefore
 * a dimension AND a scale, and the same reading is applied to a unit written
 * on the VALUE instead (`{kind:"duration", value:"5km"}`), which is the same
 * statement in the other slot. Whichever one states a unit wins; a unit
 * belonging to the other dimension moves the block to that dimension, because
 * a coach who writes kilometres means a distance whatever the kind field says.
 *
 * A word in neither this table nor the other dimension's is a refusal, not a
 * guess: `{kind:"laps"}` has no length until someone says how big the track is.
 */
interface BlockUnit {
  dim: Dimension;
  /** Base units (seconds / metres) in one of this kind's units. */
  per: number;
}
const TIME_KIND: BlockUnit = { dim: "time", per: 60 };
const DISTANCE_KIND: BlockUnit = { dim: "distance", per: 1 };
const RUN_BLOCK_KINDS: Record<string, BlockUnit> = {
  duration: TIME_KIND,
  time: TIME_KIND,
  timed: TIME_KIND,
  minutes: TIME_KIND,
  minute: TIME_KIND,
  mins: TIME_KIND,
  min: TIME_KIND,
  seconds: { dim: "time", per: 1 },
  second: { dim: "time", per: 1 },
  secs: { dim: "time", per: 1 },
  sec: { dim: "time", per: 1 },
  hours: { dim: "time", per: 3600 },
  hour: { dim: "time", per: 3600 },
  hrs: { dim: "time", per: 3600 },
  hr: { dim: "time", per: 3600 },
  distance: DISTANCE_KIND,
  meters: DISTANCE_KIND,
  metres: DISTANCE_KIND,
  meter: DISTANCE_KIND,
  metre: DISTANCE_KIND,
  m: DISTANCE_KIND,
  km: { dim: "distance", per: 1000 },
  k: { dim: "distance", per: 1000 },
  kilometers: { dim: "distance", per: 1000 },
  kilometres: { dim: "distance", per: 1000 },
  kilometer: { dim: "distance", per: 1000 },
  kilometre: { dim: "distance", per: 1000 },
  miles: { dim: "distance", per: 1609.344 },
  mile: { dim: "distance", per: 1609.344 },
  mi: { dim: "distance", per: 1609.344 },
  yards: { dim: "distance", per: 0.9144 },
  yard: { dim: "distance", per: 0.9144 },
  yds: { dim: "distance", per: 0.9144 },
  yd: { dim: "distance", per: 0.9144 },
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

export type RunIntensity = "easy" | "steady" | "threshold" | "interval" | "rest";
export type CoachRunBlock = { kind: "duration" | "distance"; value: number; intensity?: RunIntensity };

/**
 * One structured run block — the COROS-write-confirmed topology.
 *
 * SUB-MINUTE WORK IS EXPRESSIBLE (2026-08-17), and the limitation never
 * belonged to the wire: `targetType: 2` is whole seconds, and 42 of the 244
 * time-based stages in the athlete's own library are under a minute. It
 * belonged to `intish`, which rounded — so a 15-second stride written as 0.25
 * was refused outright, a 30-second one written as 0.5 became a whole minute,
 * and the only way left to say "45 seconds" was `45`, which this schema reads
 * as forty-five MINUTES.
 *
 * The fix is deliberately NOT a new block kind and NOT a unit tag on the
 * stored value, both of which would change what `value` MEANS to three
 * consumers that compute `value * 60` — coach-apply's `durationSeconds`,
 * create-executor's whole-second `targetValue`, describeOps'
 * `formatStageDuration` — and a meaning that changes in one place and not the
 * other two is exactly the silent-wrong-number class this change exists to
 * close. Instead:
 *
 *   THE UNIT STAYS MINUTES, AND THE NUMBER STOPS HAVING TO BE WHOLE.
 *
 * `value * 60` is still the seconds, still what every consumer already
 * computes, and 0.75 × 60 is exactly 45. What the schema stores is always a
 * whole number of seconds over 60.
 *
 * A BARE NUMBER IS STILL MINUTES, and is not second-guessed.
 * `{kind:"duration", value:45}` probably means a 45-second rep — but
 * "probably" is how you prescribe a 45-second long run to the athlete who
 * meant a 45-minute one. So the schema states the unit, honours any unit the
 * coach writes instead ("45s" → 0.75, "0:45" refused as ambiguous, 0.75 taken
 * exactly), and catches the mis-scaled case where it is CHECKABLE rather than
 * guessable — see the block-overrun refinement on `coachSessionSchema`, which
 * reads the session's own `durationMinutes` back against the work its blocks
 * describe.
 */
export const coachRunBlockSchema = z
  .object({
    // `unknown`, because kind and value cannot be parsed apart: the unit may
    // be written on either one, and whichever states it decides both.
    kind: z.unknown(),
    value: z.unknown(),
    /**
     * Optional by design, and therefore DROPPED rather than fatal when the word
     * is one no synonym covers: a block with no stated intensity is a block the
     * athlete runs by feel, which is a real prescription and infinitely better
     * than losing the wake over "fartlek". `strippedPaths` reports the drop.
     */
    intensity: orNull(
      enumish(["easy", "steady", "threshold", "interval", "rest"], RUN_INTENSITY_SYNONYMS).optional(),
    ).catch(undefined),
  })
  .transform((b, ctx): CoachRunBlock => {
    const word = typeof b.kind === "string" ? fold(b.kind) : "";
    const spec = RUN_BLOCK_KINDS[word] ?? RUN_BLOCK_KINDS[word.replace(/ /g, "")];
    if (!spec) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["kind"],
        message: `${JSON.stringify(b.kind)} is not a block kind — "duration" (minutes) or "distance" (meters); a unit ("km", "seconds") is read as the unit of "value"`,
      });
      return z.NEVER;
    }
    const unit: FieldUnit =
      spec.dim === "time" ? { ...MINUTES_TO_THE_SECOND, per: spec.per } : { ...METRES, per: spec.per };
    const read = readQuantity(b.value, unit, spec.dim === "time" ? "distance" : "time");
    if (read === undefined || failed(read)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["value"],
        message:
          read === undefined ? `${JSON.stringify(b.value)} is not a block length — write ${unit.hint}` : read.error,
      });
      return z.NEVER;
    }
    const intensity = b.intensity ?? undefined;
    // The unit decides the dimension, and the dimension decides the kind: a
    // "5km" written into a duration block is a distance block, because that is
    // what the coach said and the other reading is five minutes.
    if (read.dim === "time") {
      const seconds = Math.round(read.base);
      if (seconds < MIN_BLOCK_SECONDS || seconds > MAX_BLOCK_MINUTES * 60) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["value"],
          message: `a block of ${seconds}s is not a piece of work — write between ${MIN_BLOCK_SECONDS}s and ${MAX_BLOCK_MINUTES} minutes`,
        });
        return z.NEVER;
      }
      return { kind: "duration", value: seconds / 60, intensity };
    }
    const meters = Math.round(read.base);
    if (meters < MIN_BLOCK_METERS || meters > MAX_BLOCK_METERS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["value"],
        message: `a block of ${meters}m is not a piece of work — write between ${MIN_BLOCK_METERS}m and ${MAX_BLOCK_METERS / 1000}km (did a "km" go missing?)`,
      });
      return z.NEVER;
    }
    return { kind: "distance", value: meters, intensity };
  });

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
     *
     * WHOLE MINUTES, and a unit is honoured: "1.5 hours" is 90, not 2 (which
     * is what the leading digits used to make it — a 90-minute session whose
     * calendar block was two minutes long while its own summary said 90).
     * A session's length is a calendar block; nothing downstream holds a
     * fraction of a minute of one.
     */
    durationMinutes: quantity(WHOLE_MINUTES, 0, 1440),
    /** Empty blocks = an unstructured run, the same as omitting `run`. */
    run: orNull(z.object({ blocks: z.array(coachRunBlockSchema).max(MAX_RUN_BLOCKS) }).optional()),
    lift: orNull(coachExerciseBlockSchema.optional()),
    mobility: orNull(coachExerciseBlockSchema.optional()),
  })
  .refine((s) => [s.run, s.lift, s.mobility].filter(Boolean).length <= 1, {
    message: "a session has at most one discipline body (run, lift or mobility)",
  })
  /**
   * THE TWO NUMBERS MUST BE ABOUT THE SAME SESSION.
   *
   * A session states its length twice — once as `durationMinutes`, once as the
   * work its blocks describe — and the schema can therefore check the one
   * thing a unit-aware parse still cannot know: whether a bare number was
   * written in the unit the field is measured in. Eight reps of
   * `{kind:"duration", value:45}` meaning 45 SECONDS describe six hours inside
   * a fifty-minute session. That is not a training judgement for the athlete
   * to weigh (it is not a plan at all), and by apply time they have already
   * approved a card built from the wrong number — so it is refused here, where
   * the wake's repair loop can be told which two numbers disagree.
   *
   * One-sided and generous: blocks that describe LESS than the session are
   * ordinary (a block list for the interval set only, no warm-up), and up to
   * {@link MAX_BLOCK_OVERRUN}× more is still accepted.
   */
  .refine(
    (s) => {
      if (!s.run || s.durationMinutes <= 0) return true;
      const blockMinutes = s.run.blocks
        .filter((b) => b.kind === "duration")
        .reduce((sum, b) => sum + b.value, 0);
      return blockMinutes <= s.durationMinutes * MAX_BLOCK_OVERRUN;
    },
    (s) => ({
      path: ["run", "blocks"],
      message: `the blocks describe ${Math.round(
        (s.run?.blocks ?? []).filter((b) => b.kind === "duration").reduce((sum, b) => sum + b.value, 0),
      )} minutes of work in a session of ${s.durationMinutes} — one of the two numbers is in the wrong unit (a duration block's "value" is MINUTES; write "45s" or 0.75 for a 45-second rep)`,
    }),
  );
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
