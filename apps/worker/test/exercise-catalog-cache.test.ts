/**
 * THE CATALOG'S NAME KEYS, KEPT PER NAME (2026-10-18, the decision guidance's fix round): `buildExerciseIndex` folds
 * every catalog row's English name to its matching key and near-match tokens — ~0.7 ms over a real account's ~390 rows,
 * on every lift plan propose_plan judges — and the names are the same on every build. Each name's key is kept the first
 * time it is folded. Pinned: a warm build is exactly the build computed afresh from `normalizeExerciseKey` (every key,
 * every first id, every token set), names differing only in case and spacing land on one key, the coach's words in any
 * case or spacing resolve to the same move warm as cold, and the kept keys stay bounded. COROS's public names only.
 */
import { describe, expect, it } from "vitest";
import { COROS_EXERCISE_NAMES } from "@rg/providers";
import { buildExerciseIndex, CATALOG_KEY_CACHE_MAX, catalogKeyCacheSize, normalizeExerciseKey, resolveExerciseOriginId, resolveOpsExercises } from "../src/services/exercise-catalog.js";

/** Every strength T-code COROS names, as the sync stores them, and a few rows stored as words in odd case and spacing. */
const CODES = Object.keys(COROS_EXERCISE_NAMES).filter((k) => /^T1\d{3}$/.test(k));
const catalog = new Map<string, string>([
  ...CODES.map((code, i): [string, string] => [`cat-${i}`, code]),
  ["words-1", "  Goblet   SQUAT "],
  ["words-2", "goblet squat"],
  ["words-3", "Cat-Cow Stretch"],
  ["words-4", "T12"], // a code-like name: never a key
]);

/** A key's near-match tokens, as the matcher shaves them: generic words off the end while more than two remain. */
function tokensOf(key: string): string[] {
  let out = key.split(" ");
  while (out.length > 2 && ["stretch", "pose", "hold", "drill", "variation"].includes(out.at(-1)!)) out = out.slice(0, -1);
  return out;
}

/** The index as it was built before the keys were kept: each row folded afresh. */
function afresh(cat: ReadonlyMap<string, string>) {
  const byKey = new Map<string, string>();
  const keys: Array<{ id: string; key: string }> = [];
  for (const [id, stored] of cat) {
    const human = (COROS_EXERCISE_NAMES as Record<string, string>)[stored.trim()] ?? stored;
    if (!human || /^[A-Za-z]{0,3}[\d\-_.]{2,}$/.test(human.replace(/\s/g, "")) || human.trim().length === 0) continue;
    const key = normalizeExerciseKey(human);
    if (!key) continue;
    if (!byKey.has(key)) byKey.set(key, id);
    keys.push({ id, key });
  }
  return { byKey, keys };
}

describe("the catalog's name keys, kept per name", () => {
  it("a warm build is the build computed afresh: every key, its first id, every token set", () => {
    const want = afresh(catalog);
    for (const build of [buildExerciseIndex(catalog), buildExerciseIndex(catalog)]) {
      expect([...build.byKey]).toEqual([...want.byKey]);
      expect(build.tokens.map((t) => ({ id: t.id, key: t.key }))).toEqual(want.keys);
      for (const t of build.tokens) expect([...t.set].sort(), t.key).toEqual([...new Set(tokensOf(t.key))].sort());
      expect([...build.ids].sort()).toEqual([...catalog.keys()].sort());
    }
  });

  it("names differing only in case and spacing land on one key; the coach's words resolve the same warm as cold", () => {
    const index = buildExerciseIndex(catalog);
    expect(index.tokens.find((t) => t.id === "words-1")!.key).toBe(index.tokens.find((t) => t.id === "words-2")!.key);
    expect(index.tokens.some((t) => t.id === "words-4")).toBe(false);
    const cold = new Map(["Goblet squat", "  goblet   SQUATS ", "GOBLET-SQUAT", "cat cow", "Cat-Cow", "Jumping jacks", "jumping  JACKS", "Jump squat", "Burpees"].map((n) => [n, resolveExerciseOriginId(n, index)]));
    const warm = buildExerciseIndex(catalog);
    for (const [name, id] of cold) expect(resolveExerciseOriginId(name, warm), name).toBe(id);
    // The same move, whatever the case or spacing.
    expect(cold.get("  goblet   SQUATS ")).toBe(cold.get("Goblet squat"));
    expect(cold.get("jumping  JACKS")).toBe(cold.get("Jumping jacks"));
    expect(cold.get("Goblet squat")).not.toBeNull();
  });

  it("resolveOpsExercises resolves a name once a call: every move stamped as it alone would be, a claimed id kept, a row per move", () => {
    const index = buildExerciseIndex(catalog);
    const names = ["Goblet squat", "Made-up move", "goblet  SQUAT", "Goblet squat", "Made-up move"];
    const claimed = [...catalog.keys()][7]!;
    const session = (withClaim: boolean) => ({
      category: "strength", title: "S", durationMinutes: 40,
      lift: { exercises: names.map((name, i) => ({ name, sets: 3, reps: 8, ...(withClaim && i === 3 ? { originId: claimed } : {}) })) },
    });
    const op = { kind: "createPlan", firmSessions: [{ date: "2026-05-19", session: session(false) }, { date: "2026-05-20", session: session(true) }] };
    const report = resolveOpsExercises([op as never], index);
    expect(report.map((r) => r.name)).toEqual([...names, ...names]);
    const alone = names.map((n) => resolveExerciseOriginId(n, index));
    expect(report.map((r) => r.originId)).toEqual([...alone, ...alone.map((id, i) => (i === 3 ? claimed : id))]);
    expect(report.map((r) => r.via)).toEqual([...alone.map((id) => (id ? "name" : null)), ...alone.map((id, i) => (i === 3 ? "model" : id ? "name" : null))]);
    const stamped = op.firmSessions.flatMap((s) => s.session.lift.exercises.map((e) => (e as { originId?: string }).originId ?? null));
    expect(stamped).toEqual(report.map((r) => r.originId));
  });

  it("keeps each name once, and stays bounded", () => {
    buildExerciseIndex(catalog);
    const after = catalogKeyCacheSize();
    expect(after).toBeGreaterThanOrEqual(CODES.length);
    buildExerciseIndex(catalog);
    expect(catalogKeyCacheSize()).toBe(after);
    // Past the bound it starts again rather than growing.
    buildExerciseIndex(new Map(Array.from({ length: CATALOG_KEY_CACHE_MAX + 10 }, (_, i): [string, string] => [`x-${i}`, `Made-up move ${i}`])));
    expect(catalogKeyCacheSize()).toBeLessThanOrEqual(CATALOG_KEY_CACHE_MAX);
  });
});
