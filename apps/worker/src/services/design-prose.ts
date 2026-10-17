/**
 * Prose the coach writes, fitted to where it lands (Task 13's fix wave).
 *
 * - `clipProse`: a model can't count characters. The live suite's 39 refused calls were nearly all a line a little over
 *   its cap (a finish line's natural length was about 1.5× its 300). A text over its cap is cut at its last sentence end
 *   inside the cap, else at a word with "…" — never refused for length.
 * - `athleteText`: the reviewer writes for the designer, in the packet's words — library ids, tool names, field names,
 *   "validator". What the athlete reads passes through this first: a move's id becomes its name, a tool or field its
 *   plain words, and "the athlete's" becomes "your".
 */
import { exerciseDisplayName } from "./logged-sets.js";
import { PROMPT_TOOL_NAMES, type PromptToolName } from "./design-prompt.js";
import { COROS_EXERCISE_PREFIX } from "./watch-sets.js";

/** Where a sentence may end: ". ", "! ", "? " (a closing quote or bracket allowed after the mark). */
const SENTENCE_END = /[.!?]["'”’)\]]?(?=\s)/g;

/**
 * `text` within `max` characters: unchanged when it fits; else cut after its last sentence end inside the cap, as long
 * as that keeps at least half of it; else at the last word that fits, with "…".
 */
export function clipProse(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  const head = `${t.slice(0, max)} `;
  let end = -1;
  for (const m of head.matchAll(SENTENCE_END)) end = m.index + m[0].length;
  if (end >= max / 2) return head.slice(0, end).trim();
  const room = t.slice(0, max - 1);
  const space = room.lastIndexOf(" ");
  return `${(space >= max / 2 ? room.slice(0, space) : room).replace(/[\s,;:–—-]+$/, "")}…`;
}

/** Each tool in the athlete's words. */
const TOOL_WORDS: Record<PromptToolName, string> = {
  read_profile: "your profile",
  read_day: "the day",
  read_plan: "your plan",
  list_workouts: "your workouts",
  get_workout: "the workout",
  read_history: "your history",
  read_balance: "your recent balance",
  read_readiness: "your readiness",
  read_answers: "your check-ins",
  read_objectives: "your objectives",
  search_library: "the library",
  get_exercise: "the move's details",
  list_templates: "your templates",
  read_proposals: "your suggestions",
  recall_memory: "what the coach remembers",
  validate_workout: "the app's checks",
  ask_athlete: "a question",
  record_answer: "your answer",
  remember: "the coach's notes",
  propose_workout: "the suggestion",
  adjust_plan: "a plan change",
  plan_set: "the plan",
  read_set: "the plan",
  drop_workout: "dropping a workout",
  submit_review: "the review",
  finish: "the last line",
};
const TOOLS = new Set<string>(PROMPT_TOOL_NAMES);

/** "neckLoad" → "neck load". */
const unCamel = (s: string): string => s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();

/** A field name worth splitting: two lowercase letters or more, then humps of a capital and lowercase ("lastTrained");
 * never "iPhone", "eBike" or "macOS", which are names. */
const FIELD_NAME = /^[a-z][a-z0-9]+(?:[A-Z][a-z0-9]+)+$/;

/** Words that already carry their own article, so "the" or "a" before the tool's name goes. */
const OWN_ARTICLE = /^(?:the|your|a|an|what|dropping)\b/;

/** A path into the workout document ("intent.summary", "parts[1].items[0].why", "parts[2]"): each step after a dot opens
 * lowercase, so a sentence run on after a full stop ("the target.Then") is not one. */
const DOC_PATH = /\b(?:intent|parts|items|setting|target)(?=\[\d|\.[a-z])(?:\[\d+\])?(?:\.[a-z][A-Za-z]*(?:\[\d+\])?)*/g;

/** A document path in words: what its last step names. */
function pathWords(path: string): string {
  const last = /([A-Za-z]+)(\[\d+\])?$/.exec(path)!;
  const [, name, index] = last;
  const inItem = /\bitems\[\d+\]\./.test(path);
  if (name === "parts" && index) return "a part";
  if (name === "items" && index) return "a move";
  if (inItem && (name === "why" || name === "cue")) return `a move's ${name}`;
  return `the ${unCamel(name!)}`;
}

/** A library or watch id the athlete would recognise by name, or null (a watch code with no English name is no name). */
function moveName(token: string): string | null {
  const name = exerciseDisplayName(token);
  return name !== token && name !== token.slice(COROS_EXERCISE_PREFIX.length) ? name : null;
}

/**
 * `text` as the athlete should read it: library and watch ids as the moves' names, tool names as plain words, other
 * camelCase field names split into words, "validator" as "the app's checks", "coros" as "watch", backticks dropped,
 * "the athlete's" as "your". Plain prose passes unchanged.
 */
export function athleteText(text: string): string {
  return text
    .replace(/`([^`\n]{1,80})`/g, "$1")
    .replace(DOC_PATH, (path, at: number, all: string) => fit(pathWords(path), at, all))
    .replace(/\bcoros:[A-Za-z0-9_-]+/g, (id, at: number, all: string) => fit(moveName(id) ?? "a watch move", at, all))
    .replace(/\b(?:([Tt]he|[Aa]n?) )?([a-z]+(?:_[a-z]+)+)\b/g, (_m, art: string | undefined, word: string, at: number, all: string) => {
      const words = TOOLS.has(word) ? TOOL_WORDS[word as PromptToolName] : word.replace(/_/g, " ");
      if (art && OWN_ARTICLE.test(words)) return keepCase(art, words);
      return art ? `${art} ${words}` : fit(words, at, all);
    })
    .replace(/\b[a-z][a-z0-9]*[A-Z][A-Za-z0-9]*\b/g, (word) => moveName(word) ?? (FIELD_NAME.test(word) ? unCamel(word) : word))
    .replace(/\b(the |a )?validators\b/gi, (m, art: string | undefined) => keepCase(m, art ? "the app's checks" : "app checks"))
    .replace(/\b(?:the |a )?validator(?:'s|’s)/gi, (m) => keepCase(m, "the app's"))
    .replace(/\b(the |a )validator\b/gi, (m, art: string) => keepCase(m, art.toLowerCase() === "a " ? "a check" : "the app's checks"))
    .replace(/\bvalidator\b/gi, (m) => keepCase(m, "app check"))
    .replace(/\bcoros\b/gi, (m) => keepCase(m, "watch"))
    .replace(/\b([Tt])he athlete's\b/g, (_m, t: string) => (t === "T" ? "Your" : "your"))
    .replace(/\b([Tt])he athlete (asked|said|chose|wanted|named|wrote)\b/g, (_m, t: string, verb: string) => `${t === "T" ? "You" : "you"} ${verb}`);
}

const cap = (words: string): string => words[0]!.toUpperCase() + words.slice(1);

/** `words` capitalised when what they replace was. */
const keepCase = (was: string, words: string): string => (/^[A-Z]/.test(was) ? cap(words) : words);

/** `words` capitalised when they open the text or a sentence. */
const fit = (words: string, at: number, all: string): string => (at === 0 || /[.!?]\s+$/.test(all.slice(0, at)) ? cap(words) : words);
