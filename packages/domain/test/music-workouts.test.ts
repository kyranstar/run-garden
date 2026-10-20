/**
 * The athlete's playlists for workouts (2026-10-19): each saved playlist named and described from Spotify and tagged
 * with what it suits (`goodFor`); the one rule that says what kind of workout a session is (`workoutMusicKind`); and
 * which playlist a workout plays (`resolveWorkoutMusic`): the athlete's choice for that workout, else the workout's
 * own (a designed workout may name one), else the first playlist good for its kind, else none. Synthetic ids only.
 */
import { describe, expect, it } from "vitest";
import {
  MUSIC_CHOICES_MAX,
  MUSIC_DESCRIPTION_MAX,
  MUSIC_GOOD_FOR,
  goodForOf,
  keywordGoodFor,
  musicChoicesSchema,
  musicWordsOf,
  musicPreferencesSchema,
  plainSpotifyText,
  pruneMusicChoices,
  resolveWorkoutMusic,
  userPreferencesSchema,
  workoutDocSchema,
  workoutMusicKind,
  type MusicShortcut,
} from "../src/index.js";

const ID = "0123456789abcdefABCDEF";
const shortcut = (id: string, goodFor?: MusicShortcut["goodFor"], label = id): MusicShortcut => ({
  id,
  label,
  uri: `spotify:playlist:${ID}`,
  shuffle: true,
  ...(goodFor ? { goodFor } : {}),
});

describe("a saved playlist", () => {
  it("keeps Spotify's name, description, cover and count, and what it suits", () => {
    const s = {
      id: "s1",
      label: "Calm",
      uri: `spotify:playlist:${ID}`,
      shuffle: true,
      name: "Calm",
      description: "Quiet piano.",
      image: "https://i.scdn.co/image/ab67616d0000b273abcdef",
      total: 42,
      goodFor: ["mobility", "wind-down"],
    };
    expect(musicPreferencesSchema.parse({ shortcuts: [s] }).shortcuts[0]).toEqual(s);
    expect(MUSIC_GOOD_FOR).toEqual(["mobility", "wind-down", "strength", "run"]);
  });

  it("refuses a tag outside the set, a tag twice, a cover from anywhere but Spotify's image hosts, and an overlong description", () => {
    const one = (extra: Record<string, unknown>) => musicPreferencesSchema.safeParse({ shortcuts: [{ ...shortcut("s1"), ...extra }] }).success;
    expect(one({ goodFor: ["focus"] })).toBe(false);
    expect(one({ goodFor: ["run", "run"] })).toBe(false);
    expect(one({ image: "https://example.com/a.jpg" })).toBe(false);
    expect(one({ image: "http://i.scdn.co/image/abc" })).toBe(false);
    expect(one({ image: "javascript:alert(1)" })).toBe(false);
    expect(one({ description: "x".repeat(MUSIC_DESCRIPTION_MAX + 1) })).toBe(false);
    expect(one({ total: -1 })).toBe(false);
    expect(one({ goodFor: [] })).toBe(true);
  });

  it("an old shortcut (no name, no tags) and the old Minecraft id still read, as stored", () => {
    const old = { shortcuts: [{ id: "spa", label: "Spa", uri: `spotify:playlist:${ID}`, shuffle: true }], minecraftPlaylistId: ID };
    expect(musicPreferencesSchema.parse(old)).toEqual(old);
    expect(userPreferencesSchema.parse({ music: old }).music).toEqual(old);
  });
});

describe("Spotify's description, made plain", () => {
  it("decodes the escaped HTML Spotify sends and drops its tags — never an angle bracket left", () => {
    expect(plainSpotifyText("Slow &amp; steady &#8212; for stretching", 300)).toBe("Slow & steady — for stretching");
    expect(plainSpotifyText('Calm music. &lt;a href=&quot;spotify:playlist:abc&quot;&gt;More here&lt;/a&gt;', 300)).toBe("Calm music. More here");
    expect(plainSpotifyText("a &lt;script&gt;alert(1)&lt;/script&gt; b", 300)).toBe("a alert(1) b");
    expect(plainSpotifyText("&amp;lt;b&amp;gt; stays text", 300)).toBe("&lt;b&gt; stays text");
    expect(plainSpotifyText("odd < and > alone", 300)).toBe("odd and alone");
    expect(plainSpotifyText("line\none\u0000two   three &#x27;q&#39;", 300)).toBe("line one two three 'q'");
    expect(plainSpotifyText(null, 300)).toBe("");
    expect(plainSpotifyText(42, 300)).toBe("");
  });

  it("is clipped at a word, marked with an ellipsis, within its length", () => {
    const out = plainSpotifyText("word ".repeat(100), 30);
    expect(out.length).toBeLessThanOrEqual(30);
    expect(out.endsWith("…")).toBe(true);
    expect(out).toBe("word word word word word word…");
  });
});

describe("what a playlist suits, by its words (the fallback when the model isn't asked)", () => {
  it("reads the name and the description", () => {
    expect(keywordGoodFor("Spa Sounds", "")).toEqual(["mobility", "wind-down"]);
    expect(keywordGoodFor("Stretch", "Slow stretches")).toEqual(["mobility"]);
    expect(keywordGoodFor("Morning", "Yoga flow")).toEqual(["mobility", "wind-down"]);
    expect(keywordGoodFor("Lo-fi beats to relax", "")).toEqual(["wind-down"]);
    expect(keywordGoodFor("Easy run", "")).toEqual(["run"]);
    expect(keywordGoodFor("Gym", "Heavy lifting")).toEqual(["strength"]);
    expect(keywordGoodFor("Podcasts", "Talk")).toEqual([]);
  });
});

describe("what kind of workout a session is (one rule, the server's and the app's)", () => {
  it("by its category — a row's, or the one a document derives: runs, strength, mobility (the app's yoga), a calm one winding down; rest, cross-training or none, nothing", () => {
    for (const c of ["easy", "long", "quality", "race", "recovery", "unknown"]) expect(workoutMusicKind({ category: c }), c).toBe("run");
    expect(workoutMusicKind({ category: "strength" })).toBe("strength");
    expect(workoutMusicKind({ category: "strength", calm: true })).toBe("strength");
    expect(workoutMusicKind({ category: "yoga" })).toBe("mobility");
    expect(workoutMusicKind({ category: "yoga", calm: true })).toBe("wind-down");
    expect(workoutMusicKind({ category: "rest" })).toBeNull();
    expect(workoutMusicKind({ category: "cross_training" })).toBeNull();
    expect(workoutMusicKind({ category: null })).toBeNull();
    expect(workoutMusicKind({ category: undefined, calm: true })).toBeNull();
  });
});

describe("which playlist a workout plays", () => {
  const spa = shortcut("spa", ["mobility", "wind-down"], "Spa");
  const gym = shortcut("s2", ["strength"], "Gym");
  const calm = shortcut("s3", ["wind-down"], "Calm");
  const runs = shortcut("s4", ["run"], "Runs");
  const untagged = shortcut("s5", undefined, "Mixed");
  const shortcuts = [untagged, gym, spa, calm, runs];

  it("by default the first saved playlist good for its kind, in the order they are saved", () => {
    expect(resolveWorkoutMusic({ shortcuts, kind: "mobility" })).toEqual({ shortcut: spa, source: "default" });
    expect(resolveWorkoutMusic({ shortcuts, kind: "strength" })).toEqual({ shortcut: gym, source: "default" });
    expect(resolveWorkoutMusic({ shortcuts, kind: "run" })).toEqual({ shortcut: runs, source: "default" });
    // Winding down: a wind-down playlist first, then a mobility one; mobility the other way round.
    expect(resolveWorkoutMusic({ shortcuts: [spa, calm], kind: "wind-down" }).shortcut).toBe(spa);
    expect(resolveWorkoutMusic({ shortcuts: [shortcut("m", ["mobility"]), calm], kind: "wind-down" }).shortcut).toBe(calm);
    expect(resolveWorkoutMusic({ shortcuts: [calm], kind: "mobility" }).shortcut).toBe(calm);
  });

  it("none when nothing suits it, or the session is of no kind", () => {
    expect(resolveWorkoutMusic({ shortcuts: [gym], kind: "mobility" })).toEqual({ shortcut: null, source: "default" });
    expect(resolveWorkoutMusic({ shortcuts, kind: null })).toEqual({ shortcut: null, source: "default" });
    expect(resolveWorkoutMusic({ shortcuts: [], kind: "run" })).toEqual({ shortcut: null, source: "default" });
  });

  it("the workout's own choice (a designed workout's): a playlist, or none", () => {
    expect(resolveWorkoutMusic({ shortcuts, kind: "mobility", workout: { playlist: "s3" } })).toEqual({ shortcut: calm, source: "workout" });
    expect(resolveWorkoutMusic({ shortcuts, kind: "mobility", workout: { playlist: null } })).toEqual({ shortcut: null, source: "workout" });
    // One no longer saved: the default, as if none were named.
    expect(resolveWorkoutMusic({ shortcuts, kind: "mobility", workout: { playlist: "gone" } })).toEqual({ shortcut: spa, source: "default" });
  });

  it("the athlete's choice for this workout first: a playlist, no music, or the default over the workout's own", () => {
    const workout = { playlist: "s3" };
    expect(resolveWorkoutMusic({ shortcuts, kind: "mobility", workout, athlete: { use: "playlist", playlist: "s2" } })).toEqual({ shortcut: gym, source: "athlete" });
    expect(resolveWorkoutMusic({ shortcuts, kind: "mobility", workout, athlete: { use: "none" } })).toEqual({ shortcut: null, source: "athlete" });
    expect(resolveWorkoutMusic({ shortcuts, kind: "mobility", workout, athlete: { use: "default" } })).toEqual({ shortcut: spa, source: "default" });
    expect(resolveWorkoutMusic({ shortcuts, kind: "mobility", workout, athlete: { use: "playlist", playlist: "gone" } })).toEqual({ shortcut: calm, source: "workout" });
  });
});

describe("the athlete's choices, per workout", () => {
  it("say a playlist, no music or the default, with the workout's day; anything else is refused", () => {
    const ok = { w1: { date: "2026-10-19", use: "playlist", playlist: "spa" }, w2: { date: "2026-10-20", use: "none" }, w3: { date: "2026-10-21", use: "default" } };
    expect(musicChoicesSchema.parse(ok)).toEqual(ok);
    expect(musicChoicesSchema.safeParse({ w1: { date: "2026-10-19", use: "playlist" } }).success).toBe(false);
    expect(musicChoicesSchema.safeParse({ w1: { date: "2026-10-19", use: "none", playlist: "spa" } }).success).toBe(false);
    expect(musicChoicesSchema.safeParse({ w1: { date: "19 Oct", use: "none" } }).success).toBe(false);
    expect(musicChoicesSchema.safeParse({ w1: { date: "2026-10-19", use: "loud" } }).success).toBe(false);
    // In the preferences: absent until one is made; a stored value that no longer reads is none, never a failure.
    expect(userPreferencesSchema.parse({}).musicChoices).toBeUndefined();
    expect(userPreferencesSchema.parse({ musicChoices: ok }).musicChoices).toEqual(ok);
    expect(userPreferencesSchema.parse({ units: "mi", musicChoices: "broken" }).musicChoices).toBeUndefined();
  });

  it("are pruned of past workouts (two days' grace) and held to the newest few", () => {
    const today = "2026-10-19";
    const kept = pruneMusicChoices(
      { old: { date: "2026-10-16", use: "none" }, recent: { date: "2026-10-17", use: "none" }, next: { date: "2026-10-22", use: "default" } },
      today,
    );
    expect(Object.keys(kept).sort()).toEqual(["next", "recent"]);
    const many = Object.fromEntries(
      Array.from({ length: MUSIC_CHOICES_MAX + 5 }, (_, i) => [`w${i}`, { date: `2026-11-${String((i % 28) + 1).padStart(2, "0")}`, use: "none" as const }]),
    );
    const capped = pruneMusicChoices(many, today);
    expect(Object.keys(capped)).toHaveLength(MUSIC_CHOICES_MAX);
    // The latest days are the ones kept.
    expect(Object.values(capped).some((c) => c.date === "2026-11-28")).toBe(true);
    expect(musicChoicesSchema.safeParse(capped).success).toBe(true);
  });
});

describe("the workout document's music", () => {
  const base = {
    version: 1,
    title: "Hips",
    intent: { summary: "Open the hips.", goals: ["mobility"], focus: [], effort: "maintain" },
    parts: [{ purpose: "main", format: "flow", items: [{ kind: "rest", seconds: 30 }] }],
    source: { kind: "coach" },
  };

  it("names a saved playlist by its id, or none; a document without it reads as before", () => {
    expect(workoutDocSchema.parse({ ...base, music: { playlist: "spa" } }).music).toEqual({ playlist: "spa" });
    expect(workoutDocSchema.parse({ ...base, music: { playlist: null } }).music).toEqual({ playlist: null });
    expect(workoutDocSchema.parse(base).music).toBeUndefined();
    expect(workoutDocSchema.safeParse({ ...base, music: { playlist: "Not An Id" } }).success).toBe(false);
  });

  it("is read leniently, as the rest of the document is: a key a later version adds is dropped, never a refusal", () => {
    expect(workoutDocSchema.parse({ ...base, music: { playlist: "spa", later: 1 } }).music).toEqual({ playlist: "spa" });
  });
});

describe("a playlist not tagged yet (review-M I1)", () => {
  // The owner's old spa slot exactly as an earlier version stored it: no name, no description, no tags.
  const old = { id: "spa", label: "Spa", uri: `spotify:playlist:${ID}`, shuffle: true };

  it("suits what its words say — the words the tagging reads — so it plays for every mobility session before the dock is ever opened, and never for strength", () => {
    const shortcuts = musicPreferencesSchema.parse({ shortcuts: [old], minecraftPlaylistId: ID }).shortcuts;
    expect(musicWordsOf(shortcuts[0]!)).toEqual({ name: "Spa", description: "" });
    expect(goodForOf(shortcuts[0]!)).toEqual(["mobility", "wind-down"]);
    expect(resolveWorkoutMusic({ shortcuts, kind: workoutMusicKind({ category: "yoga" }) })).toEqual({ shortcut: shortcuts[0], source: "default" });
    expect(resolveWorkoutMusic({ shortcuts, kind: workoutMusicKind({ category: "yoga", calm: true }) }).shortcut?.id).toBe("spa");
    expect(resolveWorkoutMusic({ shortcuts, kind: workoutMusicKind({ category: "strength" }) }).shortcut).toBeNull();
  });

  it("Spotify's name and description, once read, before its label; once tagged, its tags alone — none is none", () => {
    expect(musicWordsOf({ ...old, label: "Mine", name: "Gym", description: "Heavy" })).toEqual({ name: "Gym", description: "Heavy" });
    expect(goodForOf({ ...old, label: "Mine", name: "Gym" })).toEqual(["strength"]);
    expect(goodForOf({ ...old, goodFor: [] })).toEqual([]);
    expect(goodForOf({ ...old, goodFor: ["run"] })).toEqual(["run"]);
    expect(resolveWorkoutMusic({ shortcuts: [{ ...old, goodFor: [] }], kind: "mobility" }).shortcut).toBeNull();
  });
});

describe("a choice for a workout moved later (review-M M4)", () => {
  it("is kept by the later of its stored day and the workout's day now, and keeps that day", () => {
    const choices = { moved: { date: "2026-10-19", use: "none" as const }, gone: { date: "2026-10-16", use: "none" as const } };
    const kept = pruneMusicChoices(choices, "2026-10-22", { moved: "2026-10-25", gone: "2026-10-15" });
    expect(kept).toEqual({ moved: { date: "2026-10-25", use: "none" } });
    // With no day known now (the workout gone from the plan), its stored day decides, as before.
    expect(pruneMusicChoices(choices, "2026-10-22")).toEqual({});
  });
});
