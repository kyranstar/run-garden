import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

// The port audit (Phase 1 spec §7): every standalone test, captured once from
// `node --test --test-reporter=spec` on the standalone suite (219 tests, per file), must have a same-named vitest
// test in the file(s) it was ported to. stats and store move to Phase 2 with the import and Progress.

const here = dirname(fileURLToPath(import.meta.url));
const packages = join(here, "..", "..");

/** Where each standalone test file was ported (spec §7). Null: Phase 2. */
const PORTED_TO: Record<string, string[] | null> = {
  "data": ["exercise-library/test/validate.test.ts", "exercise-library/test/coverage-presets.test.ts"],
  "engine-validate": ["exercise-library/test/validate.test.ts"],
  "engine-lib": ["session-engine/test/engine-lib.test.ts"],
  "engine-coverage": ["session-engine/test/engine-coverage.test.ts"],
  "engine-prog": ["session-engine/test/engine-prog.test.ts"],
  "engine-proposal": ["session-engine/test/engine-proposal.test.ts"],
  "engine-blocks": ["session-engine/test/engine-blocks.test.ts"],
  "engine-select": ["session-engine/test/engine-select.test.ts"],
  "engine-formats": ["session-engine/test/engine-formats.test.ts"],
  "engine-builder": ["session-engine/test/engine-builder.test.ts"],
  "engine-records": ["session-engine/test/engine-records.test.ts"],
  "engine-planner": ["session-engine/test/engine-planner.test.ts"],
  "simulation": ["session-engine/test/simulation.test.ts"],
  "recorder": ["session-engine/test/recorder.test.ts"],
  "units": ["domain/test/weights.test.ts"],
  "stats": null,
  "store": null,
};

/** [standalone file, test name] for all 219 standalone tests. */
const STANDALONE: ReadonlyArray<readonly [string, string]> = [
  ["data", "the library validates cleanly"],
  ["data", "the library has about 70 exercises and keeps every pass-1 id"],
  ["data", "text follows the contract"],
  ["data", "coverage: Home × recovery"],
  ["data", "coverage: Home × consistent"],
  ["data", "coverage: Home × build"],
  ["data", "coverage: Gym × recovery"],
  ["data", "coverage: Gym × consistent"],
  ["data", "coverage: Gym × build"],
  ["data", "coverage: Mat only × recovery"],
  ["data", "coverage: Mat only × consistent"],
  ["data", "coverage: Mat only × build"],
  ["data", "instructions agree with how the timer runs sides"],
  ["data", "wishlist equipment unlocks moves that are otherwise hidden"],
  ["engine-blocks", "a first block picks one Home-friendly lift per family, never overhead pressing"],
  ["engine-blocks", "after the block's weeks a new block rotates unpinned lifts and keeps pins"],
  ["engine-blocks", "mid-block: rotate early after clenching in 2 of 3 sessions"],
  ["engine-blocks", "mid-block: rotate early after 3 sessions without progress, not while improving"],
  ["engine-blocks", "rotation doesn't flip-flop: a lift rotated out stays out, and one rotation per family per day"],
  ["engine-blocks", "a lift judged only on sessions since it joined the block"],
  ["engine-blocks", "a block lift that's no longer in the library is replaced, not a crash"],
  ["engine-blocks", "a topped-out lift moves up a level at the next block"],
  ["engine-blocks", "graduate swaps a family's block lift for the harder move"],
  ["engine-blocks", "resolveCore maps to what the location allows"],
  ["engine-blocks", "familiesForSession: count by mode, untrained families first, theme bias"],
  ["engine-blocks", "weekOf counts from the block start"],
  ["engine-blocks", "a block's core lift prefers a loaded variant over a bodyweight one at the same level"],
  ["engine-builder", "home · recovery · 15 min fits, fills, and follows the rules"],
  ["engine-builder", "home · recovery · 30 min fits, fills, and follows the rules"],
  ["engine-builder", "home · recovery · 40 min fits, fills, and follows the rules"],
  ["engine-builder", "home · consistent · 15 min fits, fills, and follows the rules"],
  ["engine-builder", "home · consistent · 30 min fits, fills, and follows the rules"],
  ["engine-builder", "home · consistent · 40 min fits, fills, and follows the rules"],
  ["engine-builder", "home · build · 15 min fits, fills, and follows the rules"],
  ["engine-builder", "home · build · 30 min fits, fills, and follows the rules"],
  ["engine-builder", "home · build · 40 min fits, fills, and follows the rules"],
  ["engine-builder", "gym · recovery · 15 min fits, fills, and follows the rules"],
  ["engine-builder", "gym · recovery · 30 min fits, fills, and follows the rules"],
  ["engine-builder", "gym · recovery · 40 min fits, fills, and follows the rules"],
  ["engine-builder", "gym · consistent · 15 min fits, fills, and follows the rules"],
  ["engine-builder", "gym · consistent · 30 min fits, fills, and follows the rules"],
  ["engine-builder", "gym · consistent · 40 min fits, fills, and follows the rules"],
  ["engine-builder", "gym · build · 15 min fits, fills, and follows the rules"],
  ["engine-builder", "gym · build · 30 min fits, fills, and follows the rules"],
  ["engine-builder", "gym · build · 40 min fits, fills, and follows the rules"],
  ["engine-builder", "mat · recovery · 15 min fits, fills, and follows the rules"],
  ["engine-builder", "mat · recovery · 30 min fits, fills, and follows the rules"],
  ["engine-builder", "mat · recovery · 40 min fits, fills, and follows the rules"],
  ["engine-builder", "mat · consistent · 15 min fits, fills, and follows the rules"],
  ["engine-builder", "mat · consistent · 30 min fits, fills, and follows the rules"],
  ["engine-builder", "mat · consistent · 40 min fits, fills, and follows the rules"],
  ["engine-builder", "mat · build · 15 min fits, fills, and follows the rules"],
  ["engine-builder", "mat · build · 30 min fits, fills, and follows the rules"],
  ["engine-builder", "mat · build · 40 min fits, fills, and follows the rules"],
  ["engine-builder", "core lifts: 2 in consistent, 2–3 in build, none in recovery; labelled with the block week"],
  ["engine-builder", "the same inputs always give the same plan; different days vary"],
  ["engine-builder", "leftover time goes to prep and cool-down, not to jaw care or arrival"],
  ["engine-builder", "spare time becomes lifting volume first, and timed blocks stay within their caps"],
  ["engine-builder", "more minutes means more exercises, not longer ones"],
  ["engine-builder", "a swap puts the chosen exercise in that slot and drops the original"],
  ["engine-builder", "bad swaps are ignored and change nothing"],
  ["engine-builder", "bad or stale swaps that name the original are ignored too"],
  ["engine-builder", "sessions open with a breathing drill; the final jaw check never opens"],
  ["engine-builder", "overhead pressing needs a calm jaw even when build is forced"],
  ["engine-builder", "a session never holds two versions of the same move (e.g. puppy pose with and without the block)"],
  ["engine-builder", "almost no equipment still gives a valid session"],
  ["engine-builder", "a never-done core lift counts as the week's new move"],
  ["engine-builder", "the weekly new move is guaranteed whenever a never-done move fits a slot, even in short sessions"],
  ["engine-builder", "going slightly over budget shrinks the plan a little instead of dropping whole blocks"],
  ["engine-builder", "a never-done move that fits nowhere leaves the plan alone (walks superset groups safely)"],
  ["engine-builder", "no new move once one has been introduced this week"],
  ["engine-builder", "step list shape"],
  ["engine-coverage", "Rng is deterministic per seed and in [0, 1)"],
  ["engine-coverage", "Hist.daysBetween counts calendar days, including across DST"],
  ["engine-coverage", "Hist.idsIn merges done steps and logged entries without duplicates"],
  ["engine-coverage", "firstDone and newMoveThisWeek resolve legacy ids"],
  ["engine-coverage", "lastFamilyDate finds the latest session with a core lift of that family"],
  ["engine-coverage", "exposures count each exercise once per session in the window and skip unknown ids"],
  ["engine-coverage", "debt = missing exposures scaled by days since last trained"],
  ["engine-coverage", "pass-1 shaped sessions do not throw"],
  ["engine-formats", "circuit: 3–4 low-clench bodyweight moves, 40 s on / 20 s off, rounds with 45 s between"],
  ["engine-formats", "circuits never hold one-sided moves, which would get only one side"],
  ["engine-formats", "accessory moves never claim to prep today's lifts"],
  ["engine-formats", "ladder: rungs 2-4-6-8 with 20 s rests"],
  ["engine-formats", "supersets pair different patterns in the same position group"],
  ["engine-formats", "consistent mode never uses circuits or ladders"],
  ["engine-formats", "build fills leftover time with extra core sets, within each lift's range"],
  ["engine-formats", "alternatives can offer another version of the slot's own move"],
  ["engine-formats", "alternatives: up to 3 eligible options not already in the plan"],
  ["engine-lib", "addExercises fills optional fields with defaults"],
  ["engine-lib", "get resolves ids and legacy ids"],
  ["engine-lib", "hasEquipment honours all and oneOf"],
  ["engine-lib", "implementFor picks the first loaded implement in the exercise's order"],
  ["engine-lib", "flareSafe needs low clench, low neck load, and no face-down lying"],
  ["engine-lib", "fitsMode applies the mode limits"],
  ["engine-lib", "eligible combines equipment, mode, and exclusions"],
  ["engine-lib", "coreFamilyOf maps core exercises by pattern"],
  ["engine-lib", "vocab helpers"],
  ["engine-planner", "the first call starts block 1 and a fresh today; the same day keeps your choices"],
  ["engine-planner", "a new day starts clean: yesterday's check, overrides, and swaps don't carry over"],
  ["engine-planner", "feeling off means recovery"],
  ["engine-planner", "overrides for mode, theme, minutes, and location apply, and the proposal is still shown"],
  ["engine-planner", "swaps apply and are cleared when the session shape changes"],
  ["engine-planner", "an unknown saved location falls back to Home"],
  ["engine-planner", "accepting a graduation changes the block's lift"],
  ["engine-planner", "swapping a swapped slot again keeps the newest choice; swapping back to the original clears it"],
  ["engine-planner", "graduation offers come from this session's topped-out core lifts, and vanish if symptoms rose"],
  ["engine-prog", "start weight comes from the exercise's startKg, snapped to a bell"],
  ["engine-prog", "build: top of the range with a quiet jaw goes up one bell"],
  ["engine-prog", "consistent: needs two sessions at the top before going up"],
  ["engine-prog", "missing the top adds a rep at the same weight"],
  ["engine-prog", "clench or a symptom rise steps down; a rough pre-check holds"],
  ["engine-prog", "recovery steps down once, then holds"],
  ["engine-prog", "topped out at the heaviest bell suggests the harder variant"],
  ["engine-prog", "dumbbells step on a 5 lb / 2.5 kg grid; off-list bells snap down"],
  ["engine-prog", "an empty or garbage bell list falls back to the grid (no NaN)"],
  ["engine-prog", "carries go up after two clean sessions at the same weight"],
  ["engine-prog", "bodyweight reps add a rep, then graduate to the harder move"],
  ["engine-prog", "holds add 5 s per clean session and shorten after a rough one"],
  ["engine-prog", "stepWeight walks the bell list and the dumbbell grid"],
  ["engine-prog", "improved compares weight, then reps, then time"],
  ["engine-prog", "ladder and circuit entries don't feed progression"],
  ["engine-prog", "damaged history (null entries, missing startedAt) doesn't crash and sorts by date"],
  ["engine-prog", "historyFor resolves legacy ids and pass-1 flare sessions"],
  ["engine-proposal", "recovery triggers"],
  ["engine-proposal", "first launch is consistent, never build"],
  ["engine-proposal", "a 4+ day gap rebuilds the habit first"],
  ["engine-proposal", "build when calm, clean, rested, and on track"],
  ["engine-proposal", "each build condition explains itself when it fails"],
  ["engine-proposal", "theme follows the biggest debt and avoids repeating the last theme"],
  ["engine-records", "the first time doing a move is a record; the first weight isn't a weight record"],
  ["engine-records", "a heavier weight, compared in kg, is a weight record"],
  ["engine-records", "more reps at the best weight so far is a reps record"],
  ["engine-records", "a weight record resets the bar for reps at the new weight"],
  ["engine-records", "bodyweight reps records count reps without a weight"],
  ["engine-records", "the longest hold or carry is a hold record; timed rep sets aren't holds"],
  ["engine-records", "ladder and circuit entries don't count for weight, reps, or holds"],
  ["engine-records", "renamed ids resolve to one exercise"],
  ["engine-records", "records come out in chronological order whatever the input order"],
  ["engine-records", "session count milestones at 10, 25, 50, and 100"],
  ["engine-records", "weeks-at-goal streaks count consecutive Monday weeks, awarded in the session that meets the goal"],
  ["engine-records", "weeks-at-goal uses the weekly goal option, up to 52 weeks"],
  ["engine-records", "calm-jaw streaks: consecutive sessions with post ≤ pre"],
  ["engine-records", "block completed: the first session of a higher block"],
  ["engine-records", "new heaviest bell: beats every earlier kettlebell weight in any exercise"],
  ["engine-records", "every core family trained in one week, once per week"],
  ["engine-records", "each milestone is awarded at most once"],
  ["engine-records", "forSession returns only what that session achieved"],
  ["engine-records", "damaged history doesn't throw"],
  ["engine-select", "theme fit outranks everything else being equal"],
  ["engine-select", "debt: an untrained region ranks first and says for how long"],
  ["engine-select", "no 'not trained yet' reasons before there's any history"],
  ["engine-select", "reasons name a body area before a movement type"],
  ["engine-select", "ratings and recent repetition move exercises up and down"],
  ["engine-select", "repetition looks back three sessions, not just two"],
  ["engine-select", "flow prefers the same position group as the previous exercise"],
  ["engine-select", "never-done exercises get the New badge only while the weekly slot is open"],
  ["engine-select", "moves from the user's saved reels get a bonus and say so"],
  ["engine-select", "prep bonus for exercises that share a region with today's core lifts"],
  ["engine-select", "damaged history doesn't crash stats"],
  ["engine-select", "ranking is deterministic for the same seed"],
  ["engine-validate", "a valid fixture library has no errors"],
  ["engine-validate", "validation reports each kind of mistake"],
  ["engine-validate", "the real formats, themes, and location presets are valid"],
  ["recorder", "entries exist for every logged exercise, pre-filled from the plan's targets"],
  ["recorder", "reaching a step marks its set done; editing a set updates later untouched sets"],
  ["recorder", "toSession keeps only done sets with the right fields, and lists the exercises done"],
  ["recorder", "ladder rungs become sets with their own rep targets and the format is recorded"],
  ["recorder", "added sets and time on each exercise are kept"],
  ["recorder", "a timed hold counts once you've held at least half of it, at the time you actually held"],
  ["recorder", "done lists logged moves with a done set, and unlogged moves you reached"],
  ["recorder", "a mid-workout swap in a superset replaces only that move's remaining sets"],
  ["recorder", "a mid-workout swap in a circuit replaces only that move's remaining sets"],
  ["simulation", "simulation alpha: every session fits its time and recovery stays flare-safe"],
  ["simulation", "simulation alpha: each core family comes up about twice per four training sessions"],
  ["simulation", "simulation alpha: a new move lands every week while there are unseen ones"],
  ["simulation", "simulation alpha: prep and accessory moves don't repeat in more than 4 of any 7 sessions (current library)"],
  ["simulation", "simulation alpha: prep and accessory moves don't repeat in more than 3 of any 7 sessions"],
  ["simulation", "simulation alpha: blocks last their five weeks, then rotate"],
  ["simulation", "simulation bravo: every session fits its time and recovery stays flare-safe"],
  ["simulation", "simulation bravo: each core family comes up about twice per four training sessions"],
  ["simulation", "simulation bravo: a new move lands every week while there are unseen ones"],
  ["simulation", "simulation bravo: prep and accessory moves don't repeat in more than 4 of any 7 sessions (current library)"],
  ["simulation", "simulation bravo: prep and accessory moves don't repeat in more than 3 of any 7 sessions"],
  ["simulation", "simulation bravo: blocks last their five weeks, then rotate"],
  ["simulation", "simulation charlie: every session fits its time and recovery stays flare-safe"],
  ["simulation", "simulation charlie: each core family comes up about twice per four training sessions"],
  ["simulation", "simulation charlie: a new move lands every week while there are unseen ones"],
  ["simulation", "simulation charlie: prep and accessory moves don't repeat in more than 4 of any 7 sessions (current library)"],
  ["simulation", "simulation charlie: prep and accessory moves don't repeat in more than 3 of any 7 sessions"],
  ["simulation", "simulation charlie: blocks last their five weeks, then rotate"],
  ["stats", "weekStart snaps to Monday"],
  ["stats", "addDays crosses month boundaries"],
  ["stats", "sessionVolumeKg counts rep-based loaded sets, doubling bilateral lifts"],
  ["stats", "v2 entries count both sides when perSide is set"],
  ["stats", "weekly buckets sessions, minutes, and volume, oldest week first"],
  ["stats", "goalStreak counts consecutive weeks at goal, not penalising an unfinished current week"],
  ["stats", "compare contrasts the last 28 days with the 28 before"],
  ["stats", "lifts builds a per-exercise series of the top set per session"],
  ["stats", "lifts tracks hold times, and skips ladders and null sets"],
  ["stats", "dayMinutes sums sessions by date"],
  ["store", "defaults are version 2 with locations, prefs, and an empty history"],
  ["store", "a v1 document migrates in place"],
  ["store", "the original timer's settings migrate too"],
  ["store", "a v2 document keeps its data and gains fields added later"],
  ["store", "corrupt storage and damaged sessions don't break loading"],
  ["store", "save and load round-trip"],
  ["store", "import merges sessions by id and ratings without overwriting yours"],
  ["store", "import rejects files that are not backups"],
  ["store", "importing into a browser with no history restores the whole backup, settings included"],
  ["store", "importing alongside existing history keeps your settings but adds the backup's exclusions and pins"],
  ["units", "parse accepts bare numbers in the default unit"],
  ["units", "parse accepts explicit units in many spellings"],
  ["units", "parse rejects junk and non-positive weights"],
  ["units", "toKg and inUnit convert both ways"],
  ["units", "format shows the entered unit and trims trailing zeros"],
  ["units", "parseList applies a trailing unit to every number and sorts by weight"],
  ["units", "parseList handles mixed units and drops duplicates and junk"],
  ["units", "same compares weights across units"],
];

/** Test names declared in a vitest file: plain strings as-is, template literals as patterns (`${…}` matches anything). */
function declaredNames(file: string): { exact: Set<string>; patterns: RegExp[] } {
  const exact = new Set<string>();
  const patterns: RegExp[] = [];
  let src = "";
  try {
    src = readFileSync(join(packages, file), "utf8");
  } catch {
    return { exact, patterns };   // a missing file declares nothing (reported by the file check below)
  }
  const call = /\b(?:test|it)\(\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/g;
  for (const m of src.matchAll(call)) {
    const lit = m[1]!;
    if (lit.startsWith("`")) {
      const body = lit.slice(1, -1);
      if (!body.includes("${")) { exact.add(body); continue; }
      const escaped = body.split(/\$\{[^}]*\}/).map(part => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
      patterns.push(new RegExp(`^${escaped.join(".+?")}$`));
    } else if (lit.startsWith('"')) {
      exact.add(JSON.parse(lit) as string);
    } else {
      exact.add(lit.slice(1, -1).replace(/\\'/g, "'"));
    }
  }
  return { exact, patterns };
}

test("the captured standalone suite has 219 tests in 17 files", () => {
  expect(STANDALONE.length).toBe(219);
  expect(new Set(STANDALONE.map(([f]) => f))).toEqual(new Set(Object.keys(PORTED_TO)));
});

test("every standalone test has a same-named vitest test where it was ported (stats and store: Phase 2)", () => {
  const missing: string[] = [];
  let checked = 0;
  for (const [file, name] of STANDALONE) {
    const targets = PORTED_TO[file];
    if (targets === null || targets === undefined) continue;
    checked += 1;
    const found = targets.some(t => {
      const { exact, patterns } = declaredNames(t);
      return exact.has(name) || patterns.some(p => p.test(name));
    });
    if (!found) missing.push(`${file}: ${name}`);
  }
  expect(missing).toEqual([]);
  expect(checked).toBe(199);
});

test("every ported test file exists", () => {
  const files = Object.values(PORTED_TO).flat().filter((f): f is string => Boolean(f));
  for (const f of files) {
    const [pkg, dir, name] = f.split("/") as [string, string, string];
    expect(readdirSync(join(packages, pkg, dir)), f).toContain(name);
  }
});
