/**
 * TWO HARD CHECKS OF A COACH'S DRAFT (2026-11-05, the owner's "hard checks + guard"; principles §6.4: anything code can
 * check, code checks). Measured in production, the independent reviewer passed — at 4.3 or more, with no must-fix —
 * every draft the athlete then pushed back on: one that loaded the back the request called sore (rows, pulldowns, face
 * pulls; scored request 5, recovery 4), and one titled "Rebuild Hinge + Ski Base" whose only loaded hinge was one 3 × 8
 * RDL among single-leg and ski-stance work (intent 5). Both are the coach's own (act-common.ts `judge`, beside
 * `test_unmeasured`). A title the work doesn't bear out is an advisory note, must-fix for the reviewer unless the draft
 * explains it (design-review.ts `reviewPacket`). A sore area loaded is an ERROR since the safety audit (2026-11-06, S1:
 * the owner's standing ruling — insistence never overrides loading an area they called sore, spec §15 Q1): validate
 * says the draft is invalid, propose and amend refuse it, and its fix offers no "kept on purpose" way out. Gentle work
 * for the area stays allowed: what this check counts as work (below) is the line.
 *
 * WHAT COUNTS AS WORK. A working part is one whose purpose is main, power, accessory or conditioning — never arrive,
 * warm-up, activation, care, cool-down or a run. A working move is a library move in one whose record is more than
 * mobility, breathing or release, and that is loaded (bodyweight or external) or does strength, power or conditioning:
 * a cat-cow or a world's-greatest stretch in a main part is not work; a glute bridge is. Its sets are derive.ts's (its
 * dose's, else the record's, else one) times the part's rounds.
 *
 * `sore_area_loaded` — the areas the athlete called sore today (record-answer.ts `soreAreasOf`: a bare "back" is the
 * back, upper and low; an answer of 0 or 1 is no soreness) and the moves that load each: the record lists the area as a
 * region, or a primary muscle sits there — or, for a move under a weight (the record's external load, or a weight on the
 * item's dose), a secondary one too (a weight loads what holds it: an RDL's erectors, a goblet squat's). An item's
 * alternates are judged as the item (one may be swapped in on the day). One note per area, every move named once, in
 * order. An ERROR for a draft today or tomorrow; for the day after (soreness's last fresh day) a warning, must-fix for the
 * reviewer unless the draft explains it (`firm`, the caller's).
 *
 * WHAT LOADS A SORE AREA (the safety audit's line, S1, and its review's fix wave): in a working part (above) of a
 * document above Recover, a working move, or any move under a weight; in a GENTLE context — a warm-up, activation, care
 * or cool-down part, or any part of a Recover document — only a move under a weight or a jump. What stays allowed is the
 * rest: easy circulation and gentle range — bodyweight drills in the gentle parts, a Recover session's bird dog or cat-cow
 * for a sore back, a mobility, breathing or release move anywhere. A relief session for the sore area is exactly that.
 *
 * `title_not_content` — the movement patterns the title names in plain words (the library's own vocabulary, `PATTERNS`:
 * hinge, squat, lunge, push, press, pull, row, carry, rotation), or, when it names none, the intent summary's (only the
 * nouns there: a summary's "push the pace" or "carry over" is no promise). A negated one ("no hinge", "hinge-free")
 * never counts. A working set is the named pattern's when its move's record has that pattern, or its name holds the word
 * (a split squat is a lunge to the library and squatting to the athlete). See TITLE_SHARE_MIN for the threshold.
 */
import { isPlyometric, label, MUSCLE_REGION, type ExerciseRecord, type MuscleId, type Pattern } from "@rg/exercise-library";
import type { WorkoutDoc } from "@rg/domain";
import type { CoachIssue } from "./act-common.js";

/** The codes of the two checks: the reviewer's packet lists them apart from the advisory costs (a sore area loaded is an
 * error, refused before review; a draft stored before reaches the reviewer as must-fix whatever it says). */
export const HARD_NOTE_CODES = ["sore_area_loaded", "title_not_content"] as const;
export type HardNoteCode = (typeof HARD_NOTE_CODES)[number];
export const isHardNote = (code: string): code is HardNoteCode => (HARD_NOTE_CODES as readonly string[]).includes(code);

type Find = (id: string) => ExerciseRecord | undefined;

const WORKING_PARTS: ReadonlySet<string> = new Set(["main", "power", "accessory", "conditioning"]);
const GENTLE_PATTERNS: ReadonlySet<string> = new Set(["mobility", "breathe", "release"]);
const WORK_PURPOSES: ReadonlySet<string> = new Set(["strength", "power", "conditioning"]);

/** Whether a record is work (see the module comment): more than mobility, breathing or release; loaded, or for work. */
export function isWorkingMove(rec: ExerciseRecord): boolean {
  if (rec.patterns.every((p) => GENTLE_PATTERNS.has(p))) return false;
  return rec.load !== "none" || rec.purposes.some((p) => WORK_PURPOSES.has(p));
}

interface WorkingItem {
  /** `parts[p].items[i].libraryId`. */
  path: string;
  rec: ExerciseRecord;
  sets: number;
}

/** The working moves of a document, in order, each with its working sets (sets × rounds). */
function workingItems(doc: WorkoutDoc, find: Find): WorkingItem[] {
  const out: WorkingItem[] = [];
  doc.parts.forEach((part, p) => {
    if (!WORKING_PARTS.has(part.purpose)) return;
    const rounds = part.rounds ?? 1;
    part.items.forEach((item, i) => {
      if (item.kind !== "exercise") return;
      const rec = find(item.libraryId);
      if (!rec || !isWorkingMove(rec)) return;
      out.push({ path: `parts[${p}].items[${i}].libraryId`, rec, sets: (item.dose.sets ?? rec.dose.sets?.[0] ?? 1) * rounds });
    });
  });
  return out;
}

/** "A", "A and B", "A, B and C", "A, B, C, D and 2 more". */
function listed(names: readonly string[]): string {
  const shown = names.length > 5 ? [...names.slice(0, 4), `${names.length - 4} more`] : [...names];
  return shown.length <= 1 ? (shown[0] ?? "") : `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}`;
}

// ── sore_area_loaded ────────────────────────────────────────────────────────────────────────────────────────────────

/** An area the athlete called sore today, as the check reads it: its words (the athlete's — "back" for a bare back) and
 * the library regions and muscles it stands for. */
export interface SoreArea {
  words: string;
  regions: readonly string[];
  muscles: readonly string[];
}

/** Whether a move loads the area (see the module comment); `weighted`: under a weight, its own or its dose's. */
function loads(rec: ExerciseRecord, area: SoreArea, weighted: boolean): boolean {
  if (rec.regions.some((r) => area.regions.includes(r))) return true;
  const muscles: readonly MuscleId[] = weighted ? [...rec.muscles.primary, ...rec.muscles.secondary] : rec.muscles.primary;
  return muscles.some((m) => area.muscles.includes(m) || area.regions.includes(MUSCLE_REGION[m]));
}

interface LoadingItem {
  /** `parts[p].items[i].libraryId`, or an alternate's `….alternates[k].libraryId`. */
  path: string;
  rec: ExerciseRecord;
  weighted: boolean;
}

/** A dose that carries a weight: kilograms above zero. */
const doseWeighted = (dose: { load?: unknown } | undefined): boolean => {
  const l = dose?.load as { kg?: unknown } | undefined;
  return typeof l === "object" && l !== null && typeof l.kg === "number" && l.kg > 0;
};

/** The moves of a document that load what they touch (see WHAT LOADS A SORE AREA), alternates beside their item. */
function loadingItems(doc: WorkoutDoc, find: Find): LoadingItem[] {
  const recover = doc.intent.effort === "recover";
  const out: LoadingItem[] = [];
  doc.parts.forEach((part, p) => {
    const gentle = recover || !WORKING_PARTS.has(part.purpose);
    part.items.forEach((item, i) => {
      if (item.kind !== "exercise") return;
      const ids: Array<[string, string]> = [[item.libraryId, `parts[${p}].items[${i}].libraryId`], ...(item.alternates ?? []).map((a, k): [string, string] => [a.libraryId, `parts[${p}].items[${i}].alternates[${k}].libraryId`])];
      for (const [id, path] of ids) {
        const rec = find(id);
        if (!rec) continue;
        const weighted = rec.load === "external" || doseWeighted(item.dose);
        const work = gentle ? weighted || isPlyometric(rec) : weighted || isWorkingMove(rec);
        if (work) out.push({ path, rec, weighted });
      }
    });
  });
  return out;
}

/** "glutes", "hip flexors", "feet", "quads and glute med": said as many. */
const plural = (words: string): boolean => / and /.test(words) || /(s|feet)$/.test(words);

/** The fix a sore area loaded offers: what to do instead — never "keep it and say why" (the safety audit, S1). */
export const soreFix = (words: string, one: boolean): string =>
  `Swap ${one ? "it" : "each"} for a move that spares the ${words}, or move the load elsewhere: a sore area takes only gentle work — mobility, breathing or release, or unloaded, easy work in a warm-up, activation, care or cool-down part — whatever is asked.`;

/**
 * One note per sore area the draft's moves load, naming them (see the module comment): an error when `firm` (a draft today
 * or tomorrow: the default), else a warning (the day after).
 */
export function soreAreaNotes(doc: WorkoutDoc, sore: readonly SoreArea[], find: Find, o: { firm?: boolean } = {}): CoachIssue[] {
  if (sore.length === 0) return [];
  const work = loadingItems(doc, find);
  return sore.flatMap((area): CoachIssue[] => {
    const hits = work.filter((w) => loads(w.rec, area, w.weighted));
    if (hits.length === 0) return [];
    const names = [...new Set(hits.map((h) => h.rec.name))];
    const many = plural(area.words);
    const it = many ? "them" : "it";
    return [
      {
        path: hits[0]!.path,
        code: "sore_area_loaded",
        message: `You said your ${area.words} ${many ? "are" : "is"} sore today; ${listed(names)} ${names.length === 1 ? "loads" : "load"} ${it}.`,
        fix: soreFix(area.words, names.length === 1),
        severity: o.firm === false ? "warning" : "error",
      },
    ];
  });
}

// ── one_side_only ───────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * A one-sided move the draft gives no sides and no chosen side: a timed window runs once, so the other side never comes.
 * The coach's own note, not the document's rule: the document validator's issues rule moves out of quick starts and
 * suggestions, and the owner may turn a move's sides off in the Studio on purpose.
 */
export function oneSidedNotes(doc: WorkoutDoc, find: Find): CoachIssue[] {
  return doc.parts.flatMap((part, p) =>
    part.items.flatMap((item, i): CoachIssue[] => {
      if (item.kind !== "exercise" || item.dose.perSide || item.side !== undefined) return [];
      const rec = find(item.libraryId);
      if (rec?.laterality !== "unilateral") return [];
      return [
        {
          path: `parts[${p}].items[${i}].dose`,
          code: "one_side_only",
          message: `${rec.name} is done a side at a time, and this plays only one side.`,
          fix: "Set perSide: true so it plays both sides, or set side if one side is the point.",
          severity: "warning",
        },
      ];
    }),
  );
}

// ── title_not_content ───────────────────────────────────────────────────────────────────────────────────────────────

/**
 * THE THRESHOLD. One named pattern leads a session when it holds at least about a third of the working sets: a third is
 * the biggest of three equal blocks — the main lift, a second lift, the accessories — so a pattern under it is at most
 * one block among several, which is what the athlete felt ("it wasn't really hinge like it advertised": 3 of 11, 0.27).
 * 0.3 rather than 1/3, so a session whose named pattern is a third give or take one set (3 of 10, 4 of 13) isn't flagged
 * on a rounding. Several named patterns share the session: each must hold at least half its even share (0.5 / k) — two
 * at a quarter each, three at a sixth — never more than 0.3. A pattern named and absent is always flagged.
 */
export const TITLE_SHARE_MIN = 0.3;
export const titleShareMin = (named: number): number => Math.min(TITLE_SHARE_MIN, 0.5 / Math.max(1, named));

interface PatternWord {
  /** The word as the note says it: "hinge work", "3 … are hinges". */
  word: string;
  many: string;
  patterns: readonly Pattern[];
  /** Its forms in a title. */
  forms: readonly string[];
  /** Its forms in an intent summary: the nouns alone (a sentence's "push the pace", "carry over" promises nothing). */
  summary: readonly string[];
}

const PATTERN_WORDS: readonly PatternWord[] = [
  { word: "hinge", many: "hinges", patterns: ["hinge"], forms: ["hinge", "hinges", "hinging"], summary: ["hinge", "hinges", "hinging"] },
  { word: "deadlift", many: "deadlifts", patterns: ["hinge"], forms: ["deadlift", "deadlifts", "deadlifting"], summary: ["deadlift", "deadlifts"] },
  { word: "squat", many: "squats", patterns: ["squat"], forms: ["squat", "squats", "squatting"], summary: ["squat", "squats", "squatting"] },
  { word: "lunge", many: "lunges", patterns: ["lunge"], forms: ["lunge", "lunges", "lunging"], summary: ["lunge", "lunges"] },
  { word: "push", many: "pushes", patterns: ["push-h", "push-v"], forms: ["push", "pushes", "pushing"], summary: [] },
  { word: "press", many: "presses", patterns: ["push-h", "push-v"], forms: ["press", "presses", "pressing"], summary: ["presses"] },
  { word: "pull", many: "pulls", patterns: ["pull-h", "pull-v"], forms: ["pull", "pulls", "pulling"], summary: [] },
  { word: "row", many: "rows", patterns: ["pull-h"], forms: ["row", "rows", "rowing"], summary: ["rows"] },
  { word: "carry", many: "carries", patterns: ["carry"], forms: ["carry", "carries", "carrying"], summary: ["carries"] },
  { word: "rotation", many: "rotations", patterns: ["rotate", "anti-rotate"], forms: ["rotation", "rotations", "rotational", "rotate"], summary: ["rotation", "rotations", "rotational"] },
];

/** Words before a pattern that take it back ("no hinge"), and after ("hinge-free"). */
const NEGATE_BEFORE: ReadonlySet<string> = new Set(["no", "not", "without", "skip", "skipping", "minus", "zero"]);
const NEGATE_AFTER: ReadonlySet<string> = new Set(["free"]);

const tokens = (text: string): string[] => text.toLowerCase().split(/[^a-z]+/).filter(Boolean);

/** The pattern words a text names, in order, each once: a negated one never; "in a row" is no row. */
function namedIn(text: string, where: "title" | "summary"): PatternWord[] {
  const w = tokens(text);
  const out: PatternWord[] = [];
  w.forEach((x, i) => {
    const pw = PATTERN_WORDS.find((p) => (where === "title" ? p.forms : p.summary).includes(x));
    if (!pw || out.includes(pw)) return;
    if (NEGATE_BEFORE.has(w[i - 1] ?? "") || NEGATE_AFTER.has(w[i + 1] ?? "")) return;
    if (pw.word === "row" && w[i - 1] === "a" && w[i - 2] === "in") return;
    out.push(pw);
  });
  return out;
}

/** Whether a working move is the named pattern's: its record's pattern, or its name holds the word. */
const isOf = (rec: ExerciseRecord, pw: PatternWord): boolean => rec.patterns.some((p) => pw.patterns.includes(p)) || tokens(rec.name).some((x) => pw.forms.includes(x));

/** The patterns the title names (else the summary's) that the working sets mostly aren't (see the module comment). */
export function titleNotes(doc: WorkoutDoc, find: Find): CoachIssue[] {
  const inTitle = namedIn(doc.title, "title");
  const where = inTitle.length > 0 ? "title" : "summary";
  const named = inTitle.length > 0 ? inTitle : namedIn(doc.intent.summary, "summary");
  // Two words for one pattern ("hinge and deadlift") are one promise.
  const promises = named.filter((pw, i) => !named.slice(0, i).some((x) => x.patterns.join() === pw.patterns.join()));
  if (promises.length === 0) return [];
  const work = workingItems(doc, find);
  const total = work.reduce((s, w) => s + w.sets, 0);
  if (total === 0) return [];
  const min = titleShareMin(promises.length);
  return promises.flatMap((pw): CoachIssue[] => {
    const theirs = work.filter((w) => isOf(w.rec, pw)).reduce((s, w) => s + w.sets, 0);
    if (theirs / total >= min) return [];
    // What the work mostly is: the pattern with the most of the other sets (a move's first pattern of work).
    const by = new Map<string, number>();
    for (const w of work) {
      if (isOf(w.rec, pw)) continue;
      const p = w.rec.patterns.find((x) => !GENTLE_PATTERNS.has(x));
      if (p) by.set(p, (by.get(p) ?? 0) + w.sets);
    }
    const top = [...by].sort((a, b) => b[1] - a[1])[0];
    const share = theirs === 0 ? `none of its ${total} working sets are ${pw.many}` : `only ${theirs} of its ${total} working sets ${theirs === 1 ? "is a" : "are"} ${theirs === 1 ? pw.word : pw.many}`;
    // "Most" only when it is: half the sets or more; else the largest share.
    const mostly = top ? `; ${top[1] * 2 >= total ? "most of the work is" : "the largest share is"} ${label(top[0]).toLowerCase()} (${top[1]} set${top[1] === 1 ? "" : "s"})` : "";
    return [
      {
        path: where === "title" ? "title" : "intent.summary",
        code: "title_not_content",
        message: `The ${where} promises ${pw.word} work, but ${share}${mostly}.`,
        fix: `Retitle it for what the work is (an amend: the title and intent.summary are text), or give the ${pw.word} a real share of the working sets (a revision).`,
        severity: "warning",
      },
    ];
  });
}
