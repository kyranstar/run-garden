/**
 * A PROGRAM SESSION'S WIRE PROGRAM AND ITS PREVIEW, ONE BUILDER (Phase 3 Task 3;
 * spec §3, §4.2). The steps come resolved (catalog ids, free-text names, grams);
 * the builder lays them out in the shape the unmapped-move spike proved live —
 * every step in its own `sets: 1` container, a per-side pair sharing one — and
 * the preview is read straight off that program, so it lists each step exactly
 * as the wire carries it. End to end it runs through the production
 * `createWorkout`, against the echoing mock AND a COROS that re-encodes what it
 * stores (Review Focus 5).
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { WATCH_MAX_STEPS, type ProgramWatchSession, type ProgramWatchStep } from "@rg/domain";
import { COROS_EXERCISE_NAMES, programTextFingerprint, type RawCorosExercise, type RawCorosProgram } from "@rg/providers";
import { CorosClient } from "../src/client.js";
import { corosProgramFingerprint } from "@rg/providers";
import { createWorkout, SUB_SORT, TOP_SORT } from "../src/create-executor.js";
import { buildProgramWatchProgram, previewOfProgram } from "../src/program-watch.js";
import { buildSpikeProgram, FREE_TEXT_ORIGIN_ID } from "../src/spike-program.js";
import { mockCorosServer, type MockCorosServer } from "./mock-coros-server.js";
import { renormalizingCoros } from "./renormalizing-coros.js";

const GOBLET_ID = "900000000000001301";
const BIRD_DOG_ID = "900000000000001150";
const GENERIC_ID = "900000000000001121";
const CATALOG = new Map([
  [GOBLET_ID, "T1301"],
  [BIRD_DOG_ID, "T1150"],
  [GENERIC_ID, "T1121"],
]);
const englishName = (key: string): string | undefined => COROS_EXERCISE_NAMES[key];

const step = (over: Partial<ProgramWatchStep> = {}): ProgramWatchStep => ({
  originId: GOBLET_ID,
  name: "T1301",
  target: { kind: "reps", reps: 8 },
  grams: 11_340,
  restSeconds: 90,
  overview: "Knees track over your toes.",
  side: null,
  ...over,
});

/** A catalog lift, a free-text hold, a free-text per-side pair, and an open catalog step. */
const STEPS: ProgramWatchStep[] = [
  step(),
  step({ originId: FREE_TEXT_ORIGIN_ID, name: "Chin tuck hold", target: { kind: "hold", seconds: 30 }, grams: null, restSeconds: 0, overview: "" }),
  step({ originId: FREE_TEXT_ORIGIN_ID, name: "Single-leg RDL reach", target: { kind: "reps", reps: 6 }, grams: null, restSeconds: 30, overview: "left side · Hips stay square", side: "left" }),
  step({ originId: FREE_TEXT_ORIGIN_ID, name: "Single-leg RDL reach", target: { kind: "reps", reps: 6 }, grams: null, restSeconds: 60, overview: "right side · Hips stay square", side: "right" }),
  step({ originId: BIRD_DOG_ID, name: "T1150", target: { kind: "open" }, grams: null, restSeconds: 0, overview: "" }),
];
const STAMP = "Strength program — 2026-10-09";
const session = (steps: ProgramWatchStep[] = STEPS): ProgramWatchSession => ({ kind: "program_watch", title: "Strength program", steps });
const spec = (steps?: ProgramWatchStep[]) => ({ happenDay: "20261009", name: STAMP, session: session(steps) });

const wire = (e: RawCorosExercise) => e as unknown as Record<string, unknown>;
const children = (p: RawCorosProgram) => (p.exercises ?? []).filter((e) => e.isGroup !== true);
const containers = (p: RawCorosProgram) => (p.exercises ?? []).filter((e) => e.isGroup === true);

describe("buildProgramWatchProgram — the shape", () => {
  const program = buildProgramWatchProgram(spec(), CATALOG);

  it("puts each step in its own sets-1 container, and a per-side pair in one", () => {
    expect(program.name).toBe(STAMP);
    expect(program.sportType).toBe(4);
    expect(program.subType).toBe(65535);
    const groups = containers(program);
    expect(groups).toHaveLength(4);
    groups.forEach((c, i) => {
      expect(c.exerciseType).toBe(0);
      expect(c.sets).toBe(1);
      expect(c.sortNo).toBe(TOP_SORT * (i + 1));
    });
    const kids = children(program);
    expect(kids).toHaveLength(5);
    // exerciseNum counts children only; with every container at sets 1 the set count is the child count.
    expect(program.exerciseNum).toBe(5);
    expect(program.totalSets).toBe(5);
    // The pair: both children in the third container, sub-sorted 1 and 2.
    const pairGroup = groups[2]!;
    const pair = kids.filter((k) => String(k.groupId) === String(pairGroup.id));
    expect(pair.map((k) => k.sortNo)).toEqual([TOP_SORT * 3 + SUB_SORT, TOP_SORT * 3 + SUB_SORT * 2]);
    // Every other container holds exactly one child, sub-sorted 1.
    for (const g of [groups[0]!, groups[1]!, groups[3]!]) {
      const mine = kids.filter((k) => String(k.groupId) === String(g.id));
      expect(mine.map((k) => k.sortNo)).toEqual([Number(g.sortNo) + SUB_SORT]);
    }
  });

  it("is the spike's proven per-side pair shape: same container, same child keys", () => {
    const spike = buildSpikeProgram({
      happenDay: "20261009",
      name: "RG SPIKE — SAFE TO DELETE 2026-10-09",
      catalog: CATALOG,
      genericTrainingOriginId: GENERIC_ID,
      exerciseOriginId: BIRD_DOG_ID,
    });
    const spikeGroups = containers(spike);
    const spikePairGroup = spikeGroups.at(-1)!;
    const spikePair = children(spike).filter((k) => String(k.groupId) === String(spikePairGroup.id));
    const ourGroup = containers(program)[2]!;
    const ourPair = children(program).filter((k) => String(k.groupId) === String(ourGroup.id));
    const shapeOf = (g: RawCorosExercise, kids: RawCorosExercise[]) => ({
      container: Object.fromEntries(Object.entries(wire(g)).filter(([k]) => !["id", "sortNo"].includes(k))),
      offsets: kids.map((k) => Number(k.sortNo) - Number(g.sortNo)),
      childKeys: kids.map((k) => Object.keys(wire(k)).sort()),
    });
    expect(shapeOf(ourGroup, ourPair)).toEqual(shapeOf(spikePairGroup, spikePair));
  });

  it("targets: reps → 3, hold → 2, open → 0", () => {
    const kids = children(program);
    expect([kids[0]!.targetType, kids[0]!.targetValue]).toEqual([3, 8]);
    expect([kids[1]!.targetType, kids[1]!.targetValue]).toEqual([2, 30]);
    expect([kids[4]!.targetType, kids[4]!.targetValue]).toEqual([0, 0]);
  });

  it("weight: grams as the intensity value, bodyweight as the empty custom value, display unit \"6\"", () => {
    const kids = children(program).map(wire);
    expect(kids[0]).toMatchObject({ intensityType: 1, intensityValue: 11_340, intensityCustom: 0, intensityDisplayUnit: "6" });
    expect(kids[1]).toMatchObject({ intensityType: 1, intensityValue: "", intensityCustom: 1, intensityDisplayUnit: "6" });
  });

  it("rest: seconds as an explicit rest, none as skip", () => {
    const kids = children(program).map(wire);
    expect(kids[0]).toMatchObject({ restType: 1, restValue: 90 });
    expect(kids[1]).toMatchObject({ restType: 3, restValue: 0 });
    expect(kids[2]).toMatchObject({ restType: 1, restValue: 30 });
    expect(kids[3]).toMatchObject({ restType: 1, restValue: 60 });
  });

  it("names: the catalog's T-code for a catalog step, the move's own name on originId \"0\"", () => {
    const kids = children(program).map(wire);
    expect(kids.map((k) => [k.originId, k.name])).toEqual([
      [GOBLET_ID, "T1301"],
      ["0", "Chin tuck hold"],
      ["0", "Single-leg RDL reach"],
      ["0", "Single-leg RDL reach"],
      [BIRD_DOG_ID, "T1150"],
    ]);
    expect(kids.map((k) => k.overview ?? "")).toEqual(STEPS.map((s) => s.overview));
  });
});

describe("buildProgramWatchProgram — refusals, before any wire call", () => {
  it("throws for a catalog id the catalog does not hold", () => {
    expect(() => buildProgramWatchProgram(spec([step({ originId: "900000000000009999" })]), CATALOG)).toThrow(/not in the COROS exercise catalog/);
  });

  it("throws when the catalog names that id differently from the previewed step", () => {
    expect(() => buildProgramWatchProgram(spec([step({ name: "T1150" })]), CATALOG)).toThrow(/catalog/);
  });

  it("needs no catalog entry for a free-text step", () => {
    const freeOnly = [step({ originId: FREE_TEXT_ORIGIN_ID, name: "Chin tuck hold" })];
    expect(children(buildProgramWatchProgram(spec(freeOnly), new Map()))).toHaveLength(1);
  });

  it("refuses zero steps and more than WATCH_MAX_STEPS", () => {
    expect(() => buildProgramWatchProgram(spec([]), CATALOG)).toThrow();
    const many = Array.from({ length: WATCH_MAX_STEPS + 1 }, () => step());
    expect(() => buildProgramWatchProgram(spec(many), CATALOG)).toThrow();
    expect(children(buildProgramWatchProgram(spec(many.slice(1)), CATALOG))).toHaveLength(WATCH_MAX_STEPS);
  });
});

/** What the preview must say for STEPS: English for catalog steps, verbatim for "0" steps. */
const EXPECTED_PREVIEW = STEPS.map((s) => ({
  name: s.originId === FREE_TEXT_ORIGIN_ID ? s.name : COROS_EXERCISE_NAMES[s.name]!,
  freeText: s.originId === FREE_TEXT_ORIGIN_ID,
  target: s.target,
  grams: s.grams,
  overview: s.overview,
  restSeconds: s.restSeconds,
}));

describe("previewOfProgram — the preview IS the wire", () => {
  it("lists exactly the steps, in order", () => {
    expect(previewOfProgram(buildProgramWatchProgram(spec(), CATALOG), englishName)).toEqual(EXPECTED_PREVIEW);
    expect(EXPECTED_PREVIEW.map((p) => p.name)).toEqual([
      "Goblet Squat",
      "Chin tuck hold",
      "Single-leg RDL reach",
      "Single-leg RDL reach",
      "Bird Dog",
    ]);
  });

  it("reads wire order (sortNo, then index), not array order", () => {
    const program = buildProgramWatchProgram(spec(), CATALOG);
    const shuffled = { ...program, exercises: [...(program.exercises ?? [])].reverse() };
    expect(previewOfProgram(shuffled, englishName)).toEqual(EXPECTED_PREVIEW);
  });
});

const noop = (): void => undefined;
async function connect(server: MockCorosServer): Promise<CorosClient> {
  const client = new CorosClient({ region: "us", fetchImpl: server.fetchImpl, logger: noop });
  await client.loginWithHash(server.email, createHash("md5").update(server.password, "utf8").digest("hex"));
  return client;
}
const storedProgram = (server: MockCorosServer): RawCorosProgram =>
  (server.state.schedule.programs ?? []).find((p) => p.name === STAMP)!;

describe("createWorkout with a program session, end to end", () => {
  it("against the echoing mock: ok, and the text fingerprint is the stored program's", async () => {
    const server = mockCorosServer({ baseMonday: "2026-10-12" });
    const client = await connect(server);
    const result = await createWorkout(client, spec(), { catalog: CATALOG, today: "2026-10-09" });
    expect(result.ok).toBe(true);
    const stored = storedProgram(server);
    expect(result.wireTextFingerprint).toBe(programTextFingerprint(stored));
    expect(previewOfProgram(stored, englishName)).toEqual(EXPECTED_PREVIEW);
  });

  it("against a COROS that re-encodes what it stores (Review Focus 5): still ok, fingerprints are the OBSERVED ones", async () => {
    const server = renormalizingCoros({ baseMonday: "2026-10-12" });
    const client = await connect(server);
    const result = await createWorkout(client, spec(), { catalog: CATALOG, today: "2026-10-09" });
    expect(result.ok).toBe(true);
    expect(server.reencoded).toBe(1);
    const stored = storedProgram(server);
    // Re-encoded for real: the bodyweight step lost its intensity value, the empty overview is gone.
    expect("intensityValue" in wire(children(stored)[1]!)).toBe(false);
    expect("overview" in wire(children(stored)[1]!)).toBe(false);
    expect(result.wireTextFingerprint).toBe(programTextFingerprint(stored));
    expect(result.wireFingerprint).toBe(corosProgramFingerprint(stored));
    // The preview read off what COROS stored still says exactly what was previewed.
    expect(previewOfProgram(stored, englishName)).toEqual(EXPECTED_PREVIEW);
  });

  it("a second create of the same stamp on the same day is already_present, with the observed text fingerprint", async () => {
    const server = renormalizingCoros({ baseMonday: "2026-10-12" });
    const client = await connect(server);
    await createWorkout(client, spec(), { catalog: CATALOG, today: "2026-10-09" });
    const writes = server.counts.scheduleWrites;
    const again = await createWorkout(client, spec(), { catalog: CATALOG, today: "2026-10-09" });
    expect(again).toMatchObject({ ok: true, reason: "already_present" });
    expect(server.counts.scheduleWrites).toBe(writes);
    expect(again.wireTextFingerprint).toBe(programTextFingerprint(storedProgram(server)));
    expect(again.wireFingerprint).toBe(corosProgramFingerprint(storedProgram(server)));
  });
});
