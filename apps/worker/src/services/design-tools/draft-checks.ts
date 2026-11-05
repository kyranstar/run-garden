/**
 * TWO HARD CHECKS OF A COACH'S DRAFT (2026-11-05, the owner's "hard checks + guard"; principles §6.4: anything code can
 * check, code checks). Measured in production, the independent reviewer passed — at 4.3 or more, with no must-fix —
 * every draft the athlete then pushed back on: one that loaded the back the request called sore (rows, pulldowns, face
 * pulls; scored request 5, recovery 4), and one titled "Rebuild Hinge + Ski Base" whose only loaded hinge was one 3 × 8
 * RDL among single-leg and ski-stance work (intent 5). Both are now advisory notes of the coach's own (act-common.ts
 * `judge`, beside `test_unmeasured`): shown with the draft's costs, and must-fix for the reviewer unless the draft
 * explains them (design-review.ts `reviewPacket`).
 *
 * WHAT COUNTS AS WORK. A working part is one whose purpose is main, power, accessory or conditioning — never arrive,
 * warm-up, activation, care, cool-down or a run. A working move is a library move in one whose record is more than
 * mobility, breathing or release, and that is loaded (bodyweight or external) or does strength, power or conditioning:
 * a cat-cow or a world's-greatest stretch in a main part is not work; a glute bridge is. Its sets are derive.ts's (its
 * dose's, else the record's, else one) times the part's rounds.
 *
 * `sore_area_loaded` — the areas the athlete called sore today (record-answer.ts `soreAreasOf`: a bare "back" is the
 * back, upper and low) and the working moves that load each: the record lists the area as a region, or a primary muscle
 * sits there — or, for a move under external load, a secondary one too (a weight loads what holds it: an RDL's erectors,
 * a goblet squat's). One note per area, every move named once, in order.
 *
 * `title_not_content` — the movement patterns the title names in plain words (the library's own vocabulary, `PATTERNS`:
 * hinge, squat, lunge, push, press, pull, row, carry, rotation), or, when it names none, the intent summary's (only the
 * nouns there: a summary's "push the pace" or "carry over" is no promise). A negated one ("no hinge", "hinge-free")
 * never counts. A working set is the named pattern's when its move's record has that pattern, or its name holds the word
 * (a split squat is a lunge to the library and squatting to the athlete). See TITLE_SHARE_MIN for the threshold.
 */
import { label, MUSCLE_REGION, type ExerciseRecord, type MuscleId, type Pattern } from "@rg/exercise-library";
import type { WorkoutDoc } from "@rg/domain";
import type { CoachIssue } from "./act-common.js";

/** The codes of the two checks: must-fix for the reviewer unless the draft explains them. */
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

/** Whether a move loads the area (see the module comment). */
function loads(rec: ExerciseRecord, area: SoreArea): boolean {
  if (rec.regions.some((r) => area.regions.includes(r))) return true;
  const muscles: readonly MuscleId[] = rec.load === "external" ? [...rec.muscles.primary, ...rec.muscles.secondary] : rec.muscles.primary;
  return muscles.some((m) => area.muscles.includes(m) || area.regions.includes(MUSCLE_REGION[m]));
}

/** "glutes", "hip flexors", "feet", "quads and glute med": said as many. */
const plural = (words: string): boolean => / and /.test(words) || /(s|feet)$/.test(words);

/** One note per sore area the draft's working moves load, naming them (see the module comment). */
export function soreAreaNotes(doc: WorkoutDoc, sore: readonly SoreArea[], find: Find): CoachIssue[] {
  if (sore.length === 0) return [];
  const work = workingItems(doc, find);
  return sore.flatMap((area): CoachIssue[] => {
    const hits = work.filter((w) => loads(w.rec, area));
    if (hits.length === 0) return [];
    const names = [...new Set(hits.map((h) => h.rec.name))];
    const many = plural(area.words);
    const it = many ? "them" : "it";
    return [
      {
        path: hits[0]!.path,
        code: "sore_area_loaded",
        message: `You said your ${area.words} ${many ? "are" : "is"} sore today; ${listed(names)} ${names.length === 1 ? "loads" : "load"} ${it}.`,
        fix: `Swap ${names.length === 1 ? "it" : "each"} for a move that spares the ${area.words}, or move the load elsewhere; a sore area gets easy circulation or gentle range. Kept on purpose: say why in its why.`,
        severity: "warning",
      },
    ];
  });
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
