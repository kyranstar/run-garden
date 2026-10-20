/**
 * THE COACH SEES THE ATHLETE'S PLAYLISTS (2026-10-19): in a designing run's profile block — cached with the profile, so
 * nothing per request — one line per saved playlist (its id, its name and a clip of its description marked as the
 * athlete's data, what it suits), under one line saying when a workout names one: only when one plainly fits the
 * session's intent, or none when quiet serves it; else the default for its kind. No playlists, no lines: nothing grows
 * for an athlete without music. The document's `music` is a field of the tool's schema, and the validator keeps it.
 * Generic: nothing personal. Synthetic data only.
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { MUSIC_SHORTCUTS_MAX, newId, workoutDocSchema, type MusicShortcut } from "@rg/domain";
import type { Env } from "../src/env.js";
import { buildDesignContext, DESIGN_CONTEXT_STATEMENTS, playlistLines, PLAYLIST_DESCRIPTION_SHOWN, type DesignRun } from "../src/services/design-context.js";
import { WORKOUT_DOC_JSON_SCHEMA, judge } from "../src/services/design-tools/act-common.js";
import { ACT_TOOLS } from "../src/services/design-tools/index.js";
import { designProposalId, type DocWorkoutOp } from "../src/services/design-tools/propose.js";
import { isToolErr, type ToolContext, type ToolErr } from "../src/services/design-tools/types.js";
import { NOW as NOW_TOOLS, seedRichAthlete, TODAY as TODAY_TOOLS } from "./design-read-fixture.js";
import { calmDoc } from "./doc-workout-fixture.js";
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

  it("one not tagged yet says what its words say, as the app's default reads it (review-M I1)", () => {
    expect(playlistLines([{ id: "spa", label: "Spa", uri: `spotify:playlist:${ID}`, shuffle: true }])[1]).toBe(
      '- spa: <untrusted from="athlete">Spa</untrusted> (good for mobility, wind-down)',
    );
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

  describe("named by its label, or by nothing the athlete has (review-M M3)", () => {
    const tool = (name: string) => ACT_TOOLS.find((t) => t.name === name)!;
    async function harness(shortcuts: MusicShortcut[]) {
      const db = makeTestDb({ boundVariableCap: 100 });
      const { userId } = await seedRichAthlete(db, { music: { shortcuts } });
      const id = `run-${newId().slice(0, 8)}`;
      await db.insert(schema.coachRuns).values({
        id, userId, parentId: null, role: "main", scope: { kind: "now" }, request: "something calm tonight",
        status: "active", state: null, steps: 0, costUsd: 0, createdAt: NOW_TOOLS.toISOString(), updatedAt: NOW_TOOLS.toISOString(),
      });
      const ctx: ToolContext = { db, env: {} as Env, userId, run: { id, role: "main", scope: { kind: "now" }, parentId: null, rehearsal: false }, now: NOW_TOOLS, toolUseId: `toolu_${id}` };
      return { db, ctx, runId: id };
    }
    const named = (playlist: string | null) => ({ ...calmDoc({ title: "Evening reset" }), music: { playlist } });

    it("a playlist named by its label (case aside, one match) is its id: the proposal keeps the id", async () => {
      const { db, ctx, runId } = await harness([spa, gym]);
      const out = await tool("propose_workout").run(ctx, { doc: named("spa SOUNDS"), target: { kind: "new", date: TODAY_TOOLS } });
      expect(isToolErr(out), JSON.stringify(out)).toBe(false);
      const [p] = await db.select().from(schema.coachProposals).where(eq(schema.coachProposals.id, designProposalId(runId)));
      expect((p!.ops as DocWorkoutOp[])[0]!.doc.music).toEqual({ playlist: "spa" });
      expect(isToolErr(await tool("validate_workout").run(ctx, { doc: named("Gym <b>"), date: TODAY_TOOLS }))).toBe(false);
      // An id, and none, as they are.
      expect(isToolErr(await tool("validate_workout").run(ctx, { doc: named("s2"), date: TODAY_TOOLS }))).toBe(false);
      expect(isToolErr(await tool("validate_workout").run(ctx, { doc: named(null), date: TODAY_TOOLS }))).toBe(false);
    });

    it("anything else is refused before the validator, saying to use one of the listed ids", async () => {
      const { ctx } = await harness([spa, gym, { ...gym, id: "s4", label: "Spa Sounds" }]);
      for (const name of ["Calm", "spa-sounds", "Spa Sounds"]) {
        for (const t of ["validate_workout", "propose_workout"]) {
          const input = t === "validate_workout" ? { doc: named(name), date: TODAY_TOOLS } : { doc: named(name), target: { kind: "new", date: TODAY_TOOLS } };
          const out = (await tool(t).run(ctx, input)) as ToolErr;
          expect(isToolErr(out), `${t} ${name}`).toBe(true);
          expect(out.error).toBe("unknown_playlist");
          expect(out.fix).toContain("spa, s2, s4");
        }
      }
      const none = await harness([]);
      const out = (await tool("validate_workout").run(none.ctx, { doc: named("Spa"), date: TODAY_TOOLS })) as ToolErr;
      expect([out.error, out.fix]).toEqual(["unknown_playlist", "The athlete has no playlists: leave music out."]);
    });
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
