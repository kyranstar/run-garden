/**
 * The provenance builder (Phase 2c Task 6; spec §2c "Provenance import"): a local script that reads the standalone
 * library's `sources` and the saves catalogue from paths given on the command line and writes the provenance file
 * OUTSIDE the repository. Everything here is synthetic and lives in temp directories: no real save, link or creator.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..", "..");
const SCRIPT = join(ROOT, "apps", "worker", "scripts", "build-provenance.mjs");

/** A synthetic post link, assembled so the repository's privacy grep never sees a literal one. */
const link = (n: number) => ["ht", "tps://www.example.test/p/", `post${n}`, "/"].join("");

interface Item {
  exerciseId: string;
  sourceType: string;
  url: string | null;
  creator: string | null;
  sourceKey: string;
}
interface Built {
  items: Item[];
  counts: { items: number; moves: number; fromStandalone: number; fromSaves: number; unmapped: number; flagged: number; unresolved: number; shared: number };
}
type Build = (input: { library: unknown[]; standalone: unknown[]; saves: unknown[] }) => Built;

async function builder(): Promise<Build> {
  const mod = (await import(pathToFileURL(SCRIPT).href)) as { buildProvenance: Build };
  return mod.buildProvenance;
}

const source = (n: number, index = 0) => ({ type: "example", url: link(n), creator: `creator-${n}`, key: `post${n}#${index}` });
const saved = (n: number, name: string, over: Record<string, unknown> = {}) => ({
  exerciseKey: `post${n}#0`,
  postUrl: link(n),
  creator: `creator-${n}`,
  name,
  aliases: [],
  postNeedsHumanReview: false,
  ...over,
});

describe("buildProvenance (the mapping)", () => {
  const library = [
    { id: "gobletSquat", name: "Goblet squat", legacyIds: ["kbSquat"] },
    { id: "bandPallofPress", name: "Band Pallof press", legacyIds: [] },
    { id: "cablePallofPress", name: "Cable Pallof press", legacyIds: [] },
    { id: "hamstringBridgeChair", name: "Hamstring bridge · heels on chair", legacyIds: [] },
    { id: "chinTuck", name: "Chin tucks", legacyIds: [] },
    { id: "sideA", name: "Twin move", legacyIds: [] },
    { id: "sideB", name: "Twin moves", legacyIds: [] },
  ];

  it("turns each standalone source into an item on the Run Garden move, a legacy id resolving to its new id", async () => {
    const build = await builder();
    const out = build({ library, standalone: [{ id: "kbSquat", legacyIds: [], sources: [source(1)] }], saves: [] });
    expect(out.items).toEqual([{ exerciseId: "gobletSquat", sourceType: "example", url: link(1), creator: "creator-1", sourceKey: "post1#0" }]);
    expect(out.counts).toMatchObject({ items: 1, moves: 1, fromStandalone: 1, unresolved: 0 });
  });

  it("counts a standalone source whose move the library no longer has, and leaves it out", async () => {
    const build = await builder();
    const out = build({ library, standalone: [{ id: "retiredMove", legacyIds: [], sources: [source(2)] }, { id: "chinTuck", sources: [] }], saves: [] });
    expect(out.items).toEqual([]);
    expect(out.counts).toMatchObject({ items: 0, unresolved: 1 });
  });

  it("keeps one row per move when one saved exercise is cited by two moves (the key is unique per account)", async () => {
    const build = await builder();
    const out = build({
      library,
      standalone: [
        { id: "cablePallofPress", sources: [source(3, 1)] },
        { id: "bandPallofPress", sources: [source(3, 1)] },
      ],
      saves: [],
    });
    expect(out.items.map((i) => [i.exerciseId, i.sourceKey])).toEqual([
      ["cablePallofPress", "post3#1~cablePallofPress"],
      ["bandPallofPress", "post3#1~bandPallofPress"],
    ]);
    expect(new Set(out.items.map((i) => i.sourceKey)).size).toBe(2);
    expect(out.counts).toMatchObject({ items: 2, moves: 2, shared: 1 });
  });

  it("links a saved exercise to the move whose name it carries — case, punctuation, plurals and small words aside", async () => {
    const build = await builder();
    const out = build({
      library,
      standalone: [],
      saves: [saved(4, "Hamstring bridge (heels on chair)"), saved(5, "Neck retraction", { aliases: ["chin tuck"] })],
    });
    expect(out.items).toEqual([
      { exerciseId: "hamstringBridgeChair", sourceType: "example", url: link(4), creator: "creator-4", sourceKey: "post4#0" },
      { exerciseId: "chinTuck", sourceType: "example", url: link(5), creator: "creator-5", sourceKey: "post5#0" },
    ]);
    expect(out.counts).toMatchObject({ items: 2, fromSaves: 2, unmapped: 0 });
  });

  it("leaves out a save flagged for review, one the standalone library already cites, and one with no single match", async () => {
    const build = await builder();
    const out = build({
      library,
      standalone: [{ id: "gobletSquat", sources: [source(6)] }],
      saves: [
        saved(6, "Goblet squat"), // already cited by the standalone library: one row, not two
        saved(7, "Goblet squat", { postNeedsHumanReview: true }),
        saved(8, "Pogo hops"),
        saved(9, "Twin move"), // two moves share the name once plurals are set aside
      ],
    });
    expect(out.items.map((i) => i.sourceKey)).toEqual(["post6#0"]);
    expect(out.counts).toMatchObject({ items: 1, fromStandalone: 1, fromSaves: 0, flagged: 1, unmapped: 2 });
  });
});

describe("build-provenance.mjs (the command)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rg-provenance-test-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function inputs() {
    const standalone = join(dir, "standalone");
    mkdirSync(standalone);
    const records = [
      { id: "gobletSquat", name: "Goblet squat", sources: [source(11)] },
      { id: "deadBug", name: "Dead bug" },
    ];
    writeFileSync(join(standalone, "lower.js"), `// synthetic\nData.addExercises(${JSON.stringify(records)});\n`);
    const saves = join(dir, "saves.json");
    writeFileSync(saves, JSON.stringify([saved(12, "Hamstring bridge (heels on chair)"), saved(13, "Pogo hops"), saved(14, "Dead bug", { postNeedsHumanReview: true })]));
    return { standalone, saves };
  }
  const run = (args: string[]) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", timeout: 60_000 });

  it("writes the provenance file from synthetic inputs against the real library, and prints counts only", () => {
    const { standalone, saves } = inputs();
    const out = join(dir, "private", "provenance.json");
    const stdout = execFileSync(process.execPath, [SCRIPT, "--library", standalone, "--saves", saves, "--out", out], { encoding: "utf8", timeout: 60_000 });
    const file = JSON.parse(readFileSync(out, "utf8")) as { format: string; version: number; items: Item[] };
    expect(file.format).toBe("rg-provenance");
    expect(file.version).toBe(1);
    expect(file.items).toEqual([
      { exerciseId: "gobletSquat", sourceType: "example", url: link(11), creator: "creator-11", sourceKey: "post11#0" },
      { exerciseId: "hamstringBridgeChair", sourceType: "example", url: link(12), creator: "creator-12", sourceKey: "post12#0" },
    ]);
    // Readable by the owner only.
    expect(statSync(out).mode & 0o777).toBe(0o600);
    // The summary is counts: no link, creator or key reaches the terminal.
    expect(stdout).toMatch(/2 items/);
    expect(stdout).not.toMatch(/example\.test|creator-|post1\d/);
  });

  it("refuses an --out inside the repository and writes nothing", () => {
    const { standalone, saves } = inputs();
    const inside = join(ROOT, "apps", "worker", "test", "provenance-should-not-exist.json");
    const res = run(["--library", standalone, "--saves", saves, "--out", inside]);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/outside the repository/);
    expect(existsSync(inside)).toBe(false);
  });

  it("refuses an --out inside any other git work tree too", () => {
    const { standalone, saves } = inputs();
    const other = join(dir, "other-repo");
    mkdirSync(join(other, ".git"), { recursive: true });
    const res = run(["--library", standalone, "--saves", saves, "--out", join(other, "nested", "provenance.json")]);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/outside the repository/);
    expect(existsSync(join(other, "nested"))).toBe(false);
  });

  it("refuses without all three paths", () => {
    const { standalone } = inputs();
    const res = run(["--library", standalone]);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/--library .* --saves .* --out/);
  });
});
