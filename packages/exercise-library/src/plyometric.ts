/**
 * A MOVE THAT SAYS IT JUMPS (the safety audit, 2026-11-06, S2 and S3). The condition gates see a jump only through its
 * plyometric contraction (`isPlyometric`). Two kinds of move never had one a person checked: a personal move, whose
 * contraction a reader model wrote from a post, and a free-text item, which has no record at all. This is the
 * deterministic check both lean on — the words that say a move hops, jumps, bounds or lands:
 *
 *  - in a NAME, every word below (`NAME_WORDS`, and the phrases `NAME_PHRASES`): a name is short and chosen, so "skip"
 *    or "landing" there is the move;
 *  - in a move's own words (its summary and steps), only the plain ones (`TEXT_WORDS`): "skip this if…" or "land the hips
 *    softly" is no jump;
 *  - a word taken back is no jump: a negation ("no", "not", "non", "never", "without", "don't", "zero", "low-impact",
 *    "avoid", "instead", "rather", "shouldn't") takes back the three words after it — "No-jump burpee", "step back, don't
 *    jump", "no need to jump", "without jumping" — five after "don't let" ("don't let your hips jump up"); "-free" takes
 *    back the word before it ("Hop-free calf raise");
 *  - and what only looks like one (the safety review, I5): a yoga bind ("Bound angle", "Half-bound lotus"), and a burpee
 *    whose name steps or walks out ("Step-out burpee", "Burpee (step back, no jump)").
 *
 * The public library is its test bed (test/plyometric-words.test.ts): every plyometric record's name says so, and no
 * other record's does. Pure.
 */

/** The words that name a jump in a move's name. */
const NAME_WORDS: ReadonlySet<string> = new Set([
  "jump", "jumps", "jumping", "jumped",
  "hop", "hops", "hopping", "hopped",
  "bound", "bounds", "bounding",
  "pogo", "pogos",
  "skip", "skips", "skipping",
  "leap", "leaps", "leaping",
  "plyo", "plyos", "plyometric", "plyometrics",
  "landing", "landings",
  "burpee", "burpees",
]);

/** Two-word names of a jump whose words alone say nothing ("depth", "drop", "snap", "double"). */
const NAME_PHRASES: readonly string[] = ["depth drop", "depth drops", "snap down", "snap downs", "double under", "double unders"];

/** The plain words that say a move jumps in its summary or steps. */
const TEXT_WORDS: ReadonlySet<string> = new Set([
  "jump", "jumps", "jumping",
  "hop", "hops", "hopping",
  "bound", "bounds", "bounding",
  "pogo", "pogos",
  "leap", "leaps", "leaping",
  "plyometric", "plyometrics",
]);

/** Words that take back the words after them. */
const NEGATIONS: ReadonlySet<string> = new Set(["no", "not", "non", "never", "without", "dont", "zero", "avoid", "avoiding", "instead", "rather", "shouldnt"]);
/** How many words a negation takes back — and "don't let", reaching past its subject ("don't let your hips jump"). */
const NEGATED_SPAN = 3;
const LET_SPAN = 5;
/** Words after a word that take it back ("hop-free"). */
const TAKES_BACK_BEFORE: ReadonlySet<string> = new Set(["free", "less"]);
/** A yoga bind: "bound" before these (or after "half" / "full") is no bound. */
const BIND_AFTER: ReadonlySet<string> = new Set(["angle", "side", "lotus", "twist", "triangle", "hands", "extended", "squat"]);
const BIND_BEFORE: ReadonlySet<string> = new Set(["half", "full", "fully"]);
/** A burpee whose name has one of these steps or walks: no jump. */
const STEPPED: ReadonlySet<string> = new Set(["step", "stepout", "stepback", "walk", "walkout"]);

/** Lower-case words, an apostrophe dropped ("don't" → "dont"), "low impact" read as one negation. */
function words(text: string): string[] {
  const w = text.toLowerCase().replace(/[’']/g, "").split(/[^a-z]+/).filter(Boolean);
  return w.map((x, i) => (x === "low" && w[i + 1] === "impact" ? "no" : x));
}

/** Indexes a negation takes back, and words that only look like a jump. */
function takenBack(w: readonly string[]): Set<number> {
  const out = new Set<number>();
  const stepped = w.some((x) => STEPPED.has(x));
  w.forEach((x, i) => {
    if (TAKES_BACK_BEFORE.has(x) && i > 0) out.add(i - 1);
    if ((x === "bound" || x === "bounds") && (BIND_AFTER.has(w[i + 1] ?? "") || BIND_BEFORE.has(w[i - 1] ?? ""))) out.add(i);
    if ((x === "burpee" || x === "burpees") && stepped) out.add(i);
    if (!NEGATIONS.has(x)) return;
    const span = x === "dont" && w[i + 1] === "let" ? LET_SPAN : NEGATED_SPAN;
    for (let k = 1; k <= span; k++) out.add(i + k);
  });
  return out;
}

function firstIn(text: string, single: ReadonlySet<string>, phrases: readonly string[]): string | null {
  const w = words(text);
  const back = takenBack(w);
  for (let i = 0; i < w.length; i++) {
    if (back.has(i)) continue;
    const pair = `${w[i]} ${w[i + 1] ?? ""}`;
    if (!back.has(i + 1) && phrases.includes(pair)) return pair;
    if (single.has(w[i]!)) return w[i]!;
  }
  return null;
}

/**
 * The word that says a move jumps — from its name, else its own words (`text`: its summary and steps) — or null. See the
 * module comment for which words count where.
 */
export function plyometricWord(name: string, text = ""): string | null {
  return firstIn(name, NAME_WORDS, NAME_PHRASES) ?? (text ? firstIn(text, TEXT_WORDS, []) : null);
}
