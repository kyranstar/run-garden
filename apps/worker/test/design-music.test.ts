/**
 * THE COACH SEES THE ATHLETE'S PLAYLISTS (2026-10-19): in a designing run's profile block — cached with the profile, so
 * nothing per request — one line per saved playlist (its id, its name and a clip of its description marked as the
 * athlete's data, what it suits), under one line saying when a workout names one: only when one plainly fits the
 * session's intent, or none when quiet serves it; else the default for its kind. No playlists, no lines: nothing grows
 * for an athlete without music. The document's `music` is a field of the tool's schema, and the validator keeps it.
 * Generic: nothing personal. Synthetic data only.
 */
import { describe, expect, it } from "vitest";
import { MUSIC_SHORTCUTS_MAX, workoutDocSchema, type MusicShortcut } from "@rg/domain";
import type { Env } from "../src/env.js";
import { buildDesignContext, DESIGN_CONTEXT_STATEMENTS, playlistLines, PLAYLIST_DESCRIPTION_SHOWN, type DesignRun } from "../src/services/design-context.js";
import { WORKOUT_DOC_JSON_SCHEMA, judge } from "../src/services/design-tools/act-common.js";
import { makeTestDb, makeTestUser } from "./helpers.js";

const ID = "0123456789abcdefABCDEF";
const spa: MusicShortcut = {
  id: "spa",
  label: "Spa Sounds",
  uri: `spotify:playlist:${ID}`,
  shuffle: true,
  name: "Spa Sounds",
  description: "Calm music for yoga, massage & rest — slow piano, rain and long pads, perfect for winding down at night after a long day.",
  goodFor: ["mobility", "wind-down"],
};
const gym: MusicShortcut = { id: "s2", label: "Gym <b>", uri: `spotify:album:${ID}`, shuffle: true, goodFor: ["strength"] };
const plain: MusicShortcut = { id: "s3", label: "Mixed", uri: `spotify:playlist:${ID}`, shuffle: true };

const run: DesignRun = { id: "run-1", role: "main", scope: { kind: "now" }, request: "Something gentle tonight.", parentId: null };
const NOW = new Date("2026-10-19T18:00:00Z");

describe("the playlists' lines", () => {
  it("none: nothing at all", () => {
    expect(playlistLines([])).toEqual([]);
  });

  it("one line saying when a workout names one, then each playlist: its id, its words marked as data (the description clipped), what it suits", () => {
    const lines = playlistLines([spa, gym, plain]);
    expect(lines[0]).toBe(
      "Playlists — the athlete's. A workout may name one in its document's music: { playlist: id }, only when one plainly fits this session's intent by its name or description, or { playlist: null } when quiet serves it; otherwise leave music out and the app plays one good for the workout's kind:",
    );
    expect(lines[1]).toMatch(/^- spa: <untrusted from="athlete">Spa Sounds — Calm music for yoga, massage & rest — slow piano, rain and long pads, perfect…<\/untrusted> \(good for mobility, wind-down\)$/);
    expect(lines[1]!.length).toBeLessThan(200);
    // Nothing inside can close its block.
    expect(lines[2]).toBe('- s2: <untrusted from="athlete">Gym ‹b›</untrusted> (good for strength)');
    expect(lines[3]).toBe('- s3: <untrusted from="athlete">Mixed</untrusted>');
    expect(PLAYLIST_DESCRIPTION_SHOWN).toBe(80);
  });

  it("stay small: at most about 3.3k characters for the most playlists the dock keeps, each at its longest", () => {
    const longest = Array.from({ length: MUSIC_SHORTCUTS_MAX }, (_, i): MusicShortcut => ({
      id: `s${i}abcdefghijk`,
      label: "L".repeat(60),
      uri: `spotify:playlist:${ID}`,
      shuffle: true,
      description: "word ".repeat(60).trim(),
      goodFor: ["mobility", "wind-down", "strength", "run"],
    }));
    expect(playlistLines(longest).join("\n").length).toBeLessThanOrEqual(3_300);
    // A usual few: well under 600.
    expect(playlistLines([spa, gym, plain]).join("\n").length).toBeLessThanOrEqual(600);
  });
});

describe("in a designing run's context", () => {
  it("in the cached profile block when the athlete has playlists — never in the opening message; nothing without; no statement more", async () => {
    let statements = 0;
    let counting = false;
    const db = makeTestDb({ boundVariableCap: 100, onStatement: () => (counting ? (statements += 1) : undefined) });
    const { userId } = await makeTestUser(db, { music: { shortcuts: [spa, gym] } });
    counting = true;
    const ctx = await buildDesignContext(db, {} as Env, userId, run, NOW);
    counting = false;
    const profile = ctx.system[2]!.text;
    expect(ctx.system[2]!.cache_control).toBeDefined();
    expect(profile).toContain("- spa: <untrusted from=\"athlete\">Spa Sounds — ");
    expect(profile).toContain("(good for mobility, wind-down)");
    expect(ctx.header).not.toContain("Playlists");
    expect(statements).toBeLessThanOrEqual(DESIGN_CONTEXT_STATEMENTS);

    const other = makeTestDb({ boundVariableCap: 100 });
    const { userId: none } = await makeTestUser(other);
    const without = await buildDesignContext(other, {} as Env, none, run, NOW);
    expect(without.system.map((b) => b.text).join("\n")).not.toContain("Playlists");
    expect(without.system[0]!.text).toBe(ctx.system[0]!.text);
  });
});

describe("a designed workout's music", () => {
  it("is a field of the tool's document — a playlist's id, or null — at a cost of under 150 characters to the cached tools", () => {
    const music = (WORKOUT_DOC_JSON_SCHEMA.properties as Record<string, unknown>).music;
    expect(music).toEqual({ type: "object", properties: { playlist: { type: ["string", "null"], maxLength: 40 } }, required: ["playlist"], additionalProperties: false });
    expect(JSON.stringify({ music }).length).toBeLessThan(150);
  });

  it("the validator keeps it with the document it judges", () => {
    const doc = {
      version: 1,
      title: "Evening reset",
      intent: { summary: "Let the day go.", goals: ["recovery"], focus: [], effort: "recover" },
      parts: [{ purpose: "cooldown", format: "holds", items: [{ kind: "rest", seconds: 60 }] }],
      source: { kind: "coach" },
      music: { playlist: "spa" },
    };
    const judged = judge(doc, { library: [], activeProfiles: [], day: null } as never);
    expect(judged.doc?.music).toEqual({ playlist: "spa" });
    expect(workoutDocSchema.parse({ ...doc, music: { playlist: null } }).music).toEqual({ playlist: null });
  });
});
