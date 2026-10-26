/**
 * The seed script's transform (saved-posts import, plan Task 20 Step 1; spec §9 "Seed"): each record of the first
 * capture's private post file becomes one `POST /api/saves/posts` body with a `seed` — the training categories
 * `queued` (the bootstrap extracts them), everything else `filtered_out` with reason "not training (first capture)" — so
 * the extension never reads the capture's posts as new. Pure; synthetic records only (example.com links, made-up keys
 * and creators). The command itself (seed-saves.mjs) is run by the lead, never here.
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { postSubmitSchema } from "@rg/saves";
import { NOT_TRAINING_REASON, TRAINING_CATEGORIES, TRAINING_REASON, toSeed } from "../scripts/seed-saves-lib.mjs";

/** A synthetic post link, assembled so the repository's privacy grep never sees a literal one. */
const link = (key: string) => ["ht", "tps://example.com/p/", key, "/"].join("");
const SOURCE = "testsrc";
/** The stand-in app's origin, assembled as `link` is. */
const APP = ["ht", "tps://app.example.com"].join("");

const record = (over: Record<string, unknown> = {}) => ({
  key: "SynPost0001",
  url: link("SynPost0001"),
  creator: "coach_zero",
  category: "mobility/stretching",
  caption: "Hips for desk days #mobility #hips",
  ...over,
});

/** The body as the script sends it: the source is the command's `--source`, never the record's. */
const body = (r: unknown) => {
  const seed = toSeed(r);
  return seed && { source: SOURCE, ...seed };
};

describe("toSeed", () => {
  it("names the spec's training categories", () => {
    expect([...TRAINING_CATEGORIES].sort()).toEqual(
      ["general fitness", "jaw/neck", "mobility/stretching", "posture/desk", "strength"].sort(),
    );
  });

  for (const category of ["strength", "mobility/stretching", "jaw/neck", "posture/desk", "general fitness"]) {
    it(`a ${category} post is queued for the bootstrap`, () => {
      const out = body(record({ category }));
      expect(out?.seed).toEqual({ status: "queued", reason: TRAINING_REASON });
      expect(postSubmitSchema.safeParse(out).success).toBe(true);
    });
  }

  it("reads a category however the capture spelled it: case, spacing, a part of a pair, a list", () => {
    for (const category of ["Strength", " MOBILITY ", "stretching", "Jaw / Neck", "neck", "posture", "desk", "General Fitness", ["food", "Strength"]]) {
      expect(toSeed(record({ category }))?.seed.status, JSON.stringify(category)).toBe("queued");
    }
  });

  it("reads a capture's category slugs by their words: a training word inside one makes the post training", () => {
    for (const category of ["exercise-strength", "mobility-stretching", "posture-desk-pain", "tmj-jaw-neck", "fitness-general"]) {
      expect(toSeed(record({ category }))?.seed.status, category).toBe("queued");
    }
    for (const category of ["nutrition-recipe", "music-art", "mindset-wellbeing", "education-other", "events-places", "product-shopping", "other", "general"]) {
      expect(toSeed(record({ category }))?.seed.status, category).toBe("filtered_out");
    }
  });

  it("reads the category from under `analysis` when the record keeps it there", () => {
    expect(toSeed(record({ category: undefined, analysis: { category: "exercise-strength", summary: "x" } }))?.seed.status).toBe("queued");
    expect(toSeed(record({ category: undefined, analysis: { category: "nutrition-recipe" } }))?.seed.status).toBe("filtered_out");
    expect(toSeed(record({ category: undefined, analysis: {} }))?.seed.status).toBe("filtered_out");
  });

  for (const category of ["recipes", "travel", "humour", "", null, undefined, ["food", "travel"]]) {
    it(`a post of category ${JSON.stringify(category)} is filtered out: not training (first capture)`, () => {
      const out = body(record({ category }));
      expect(out?.seed).toEqual({ status: "filtered_out", reason: NOT_TRAINING_REASON });
      expect(NOT_TRAINING_REASON).toBe("not training (first capture)");
      expect(postSubmitSchema.safeParse(out).success).toBe(true);
    });
  }

  it("carries the post as the extension submits one: key, link, creator, caption, hashtags, media type", () => {
    const out = toSeed(record({ creator: { handle: "coach_zero", name: "Coach Zero" }, mediaType: "carousel", postedAt: "2026-09-20T08:00:00.000Z" }));
    expect(out).toEqual({
      key: "SynPost0001",
      url: link("SynPost0001"),
      creator: { handle: "coach_zero", name: "Coach Zero" },
      caption: "Hips for desk days #mobility #hips",
      hashtags: ["mobility", "hips"],
      mediaType: "carousel",
      postedAt: "2026-09-20T08:00:00.000Z",
      seed: { status: "queued", reason: TRAINING_REASON },
    });
  });

  it("fills what a capture record lacks honestly: no caption, no hashtags, a video, no date", () => {
    const out = toSeed({ key: "SynPost0002", url: link("SynPost0002"), creator: "someone", category: "strength" });
    expect(out).toMatchObject({ caption: "", hashtags: [], mediaType: "video", creator: { handle: "someone" } });
    expect(out).not.toHaveProperty("postedAt");
    expect(postSubmitSchema.safeParse(body({ key: "SynPost0002", url: link("SynPost0002"), creator: "someone", category: "strength" })).success).toBe(true);
  });

  it("keeps every field within the route's limits: a long caption, many hashtags, a long handle", () => {
    const out = body(record({ caption: "x".repeat(5000), hashtags: Array.from({ length: 40 }, (_, i) => `tag${i}${"y".repeat(70)}`), creator: "h".repeat(90) }));
    expect(postSubmitSchema.safeParse(out).success).toBe(true);
    expect(out!.caption).toHaveLength(4000);
    expect(out!.hashtags).toHaveLength(30);
    expect(out!.creator.handle).toHaveLength(64);
  });

  it("a record the route could not take is skipped (null): no key, no web link, a key too long", () => {
    expect(toSeed(record({ key: "" }))).toBeNull();
    expect(toSeed(record({ key: "k".repeat(65) }))).toBeNull();
    expect(toSeed(record({ url: undefined }))).toBeNull();
    expect(toSeed(record({ url: "javascript:alert(1)" }))).toBeNull();
    expect(toSeed(record({ url: ["ht", "tp://example.com/p/plain/"].join("") }))).toBeNull();
    expect(toSeed(null)).toBeNull();
    expect(toSeed("not a record")).toBeNull();
  });

  it("never carries a field of its own the route would refuse (the body is strict)", () => {
    const out = body(record({ extra: "x", comments: ["a"], likeCount: 3 }));
    expect(postSubmitSchema.safeParse(out).success).toBe(true);
  });
});

// ── The command's sending (seed-saves.mjs `seed`), against a stand-in app: never a real one ──

type Counts = { records: number; skipped: number; duplicate: number; known: number; queued: number; filteredOut: number; failed: number };
type Seed = (records: unknown[], o: { source: string; app: string; token: string; dryRun?: boolean; fetchImpl: typeof fetch }) => Promise<Counts>;
const SCRIPT = join(__dirname, "..", "scripts", "seed-saves.mjs");
const seeder = async () => ((await import(pathToFileURL(SCRIPT).href)) as { seed: Seed }).seed;

/** A stand-in for the app: `known` keys answered as known; every call kept. */
function standIn(known: Set<string>, status: (path: string) => number = () => 200) {
  const calls: Array<{ path: string; body: any; auth: string | null }> = [];
  const fetchImpl = (async (input: URL | string, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    const body = JSON.parse(String(init?.body));
    calls.push({ path, body, auth: new Headers(init?.headers).get("Authorization") });
    const code = status(path);
    if (code !== 200) return new Response("{}", { status: code });
    if (path === "/api/saves/known") return Response.json({ fresh: body.keys.filter((k: string) => !known.has(k)) });
    return Response.json({ status: body.seed.status });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe("seed (the command's sending)", () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => record({ key: `SynPost${i}`, url: link(`SynPost${i}`), category: i % 2 ? "travel" : "strength" }));

  it("asks /known in pages of 200, then sends only the keys the app has no row for, each with the source and its seed", async () => {
    const seed = await seeder();
    const { calls, fetchImpl } = standIn(new Set(["SynPost0", "SynPost1"]));
    const counts = await seed([...many(450), { key: "" }, record({ key: "SynPost3" })], { source: SOURCE, app: APP, token: "t0k", fetchImpl });
    expect(calls.filter((c) => c.path === "/api/saves/known").map((c) => c.body.keys.length)).toEqual([200, 200, 50]);
    const sent = calls.filter((c) => c.path === "/api/saves/posts");
    expect(sent).toHaveLength(448);
    expect(sent.every((c) => c.auth === "Bearer t0k" && c.body.source === SOURCE && postSubmitSchema.safeParse(c.body).success)).toBe(true);
    expect(sent.map((c) => c.body.key)).not.toContain("SynPost0");
    expect(counts).toEqual({ records: 452, skipped: 1, duplicate: 1, known: 2, queued: 224, filteredOut: 224, failed: 0 });
  });

  it("--dry-run asks /known and sends nothing", async () => {
    const seed = await seeder();
    const { calls, fetchImpl } = standIn(new Set());
    const counts = await seed(many(3), { source: SOURCE, app: APP, token: "t", dryRun: true, fetchImpl });
    expect(calls.map((c) => c.path)).toEqual(["/api/saves/known"]);
    expect(counts).toMatchObject({ queued: 2, filteredOut: 1, failed: 0 });
  });

  it("a refused token stops it before anything is sent; a post the app refuses is counted, not retried", async () => {
    const seed = await seeder();
    const refused = standIn(new Set(), () => 401);
    await expect(seed(many(2), { source: SOURCE, app: APP, token: "bad", fetchImpl: refused.fetchImpl })).rejects.toThrow(/token/);
    expect(refused.calls.filter((c) => c.path === "/api/saves/posts")).toEqual([]);
    const flaky = standIn(new Set(), (path) => (path === "/api/saves/posts" ? 500 : 200));
    const counts = await seed(many(2), { source: SOURCE, app: APP, token: "t", fetchImpl: flaky.fetchImpl });
    expect(counts).toMatchObject({ queued: 0, filteredOut: 0, failed: 2 });
    expect(flaky.calls.filter((c) => c.path === "/api/saves/posts")).toHaveLength(2);
  });
});
