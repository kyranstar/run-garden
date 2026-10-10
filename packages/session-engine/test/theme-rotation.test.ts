import { addDays } from "@rg/domain";
import type { HistorySession, Mode } from "@rg/exercise-library";
import { expect, test } from "vitest";
import { Builder, Proposal } from "../src/index.js";
import { data, makeInput } from "./builder-fixtures.js";

// Themes marked `inRotation: false` (skiPrep, athleticBase, plyoIntro) are for the Studio and the coach: the day's
// proposal never picks them, and the themes it does pick come out exactly as they did before those themes existed.

const hidden = data.themes.filter(t => t.inRotation === false).map(t => t.id);
const baseline = { ...data, themes: data.themes.filter(t => t.inRotation !== false) };
const allIn = { ...data, themes: data.themes.map(t => ({ ...t, inRotation: undefined })) } as typeof data;

/** Sixteen weeks of days: each proposal is built and "done", so the coverage debt (and the next proposal) moves. */
function proposals(d: typeof data, seed: number): string[] {
  const out: string[] = [];
  const sessions: HistorySession[] = [];
  for (let i = 0; i < 112; i++) {
    const today = addDays("2026-03-01", i + seed * 7);
    if ((i * 7 + seed * 3) % 11 < 4) continue;
    const mode: Mode = (["consistent", "build", "consistent", "recovery"] as const)[(i + seed) % 4]!;
    const t = Proposal.theme(d, { mode, sessions, today }).theme;
    out.push(t ? t.id : "none");
    const plan = Builder.build(d, makeInput({ today })({ mode, theme: t, sessions, minutes: 30 }));
    sessions.push({
      id: `s${i}`, date: today, startedAt: `${today}T18:00:00`, mode, theme: t ? t.id : null, blockNumber: null,
      checks: { tmj: { pre: 1, post: 1, feelingOff: false } }, done: plan.items.map(it => ({ id: it.exercise.id, secs: 60 })), entries: [],
    } as HistorySession);
  }
  return out;
}

const tally = (xs: string[]) => xs.reduce<Record<string, number>>((c, x) => ({ ...c, [x]: (c[x] ?? 0) + 1 }), {});

test("the three Studio-only themes are marked out of the rotation", () => {
  expect([...hidden].sort()).toEqual(["athleticBase", "plyoIntro", "skiPrep"]);
});

test("the day's proposal never picks an out-of-rotation theme, and the rest match the pre-existing distribution", () => {
  const before: string[] = [];
  const now: string[] = [];
  for (const seed of [0, 1, 2, 3, 4]) {
    const mine = proposals(data, seed);
    for (const id of hidden) expect(mine, `seed ${seed}`).not.toContain(id);
    const base = proposals(baseline, seed);
    expect(mine, `seed ${seed}`).toEqual(base);
    now.push(...mine);
    before.push(...proposals(allIn, seed));
  }
  // Were the new themes in the rotation they would take days from the others; the flag gives those days back.
  expect(Object.keys(tally(before)).some(id => hidden.includes(id))).toBe(true);
  console.log("themes proposed, all in rotation:", JSON.stringify(tally(before)), "| flagged out:", JSON.stringify(tally(now)));
});

test("an out-of-rotation theme can still be chosen by hand", () => {
  expect(data.themes.some(t => t.id === "skiPrep" && t.modes.includes("build"))).toBe(true);
});
