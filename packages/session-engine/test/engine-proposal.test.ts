import { addDays } from "@rg/domain";
import { makeEngineData, type EngineData } from "@rg/exercise-library";
import { describe, expect, test } from "vitest";
import { Hist, Proposal, type HistorySession } from "../src/index.js";
import { dataWith, ex, session } from "./fixtures.js";

// Ported from the standalone tests/engine-proposal.test.js.

const data = dataWith([
  ex("hipOpener", { regions: ["hips"] }),
  ex("neckEase", { regions: ["neck"], roles: ["jaw-care"] }),
]);
const today = "2026-09-29";
const day = (n: number) => addDays(today, -n);
const calmWeek = [session(day(5)), session(day(3)), session(day(1))];   // 3 clean sessions, pre/post 1

interface ModeArgs { pre?: number | null; feelingOff?: boolean; sessions?: HistorySession[] }
const mode = ({ pre = 1, feelingOff = false, sessions = calmWeek }: ModeArgs = {}) =>
  Proposal.mode(data, { checks: { tmj: { pre, post: null, feelingOff } }, sessions, today, weeklyGoal: 4 });

test("recovery triggers", () => {
  expect(mode({ feelingOff: true }).mode).toBe("recovery");
  expect(mode({ pre: 5 }).mode).toBe("recovery");
  expect(mode({ pre: 6 }).reasons[0]).toMatch(/6/);
  const rose = [...calmWeek.slice(0, 2), session(day(1), { pre: 1, post: 3 })];
  expect(mode({ sessions: rose }).mode).toBe("recovery");
  const clenchy = [...calmWeek.slice(0, 2), session(day(1), { entries: [{ id: "a", clenched: true, sets: [] }, { id: "b", clenched: true, sets: [] }] })];
  expect(mode({ sessions: clenchy }).mode).toBe("recovery");
});

test("first launch is consistent, never build", () => {
  const r = mode({ sessions: [], pre: null });
  expect(r.mode).toBe("consistent");
  expect(r.reasons[0]).toBe("First session — start steady.");
  expect(mode({ sessions: [], pre: 0 }).mode).toBe("consistent");
});

test("a 4+ day gap rebuilds the habit first", () => {
  const r = mode({ sessions: [session(day(4))] });
  expect(r.mode).toBe("consistent");
  expect(r.reasons[0]).toMatch(/4 days/);
});

test("build when calm, clean, rested, and on track", () => {
  const r = mode({});
  expect(r.mode).toBe("build");
  expect(r.reasons[0]).toMatch(/3 sessions/);
  expect(r.reasons[0]).toBe("Jaw calm (1) · 3 sessions in the last 7 days.");
  expect(mode({ pre: null }).mode).toBe("build");    // falls back to last session's post (1)
});

test("each build condition explains itself when it fails", () => {
  expect(mode({ pre: 3 }).reasons[0]).toMatch(/calm jaw/);
  const flared = [session(day(5), { pre: 6, post: 5 }), session(day(3)), session(day(1))];
  expect(mode({ sessions: flared }).reasons[0]).toMatch(/flared/);
  const unclean = [...calmWeek.slice(0, 2), session(day(1), { entries: [{ id: "a", clenched: true, sets: [] }] })];
  expect(mode({ sessions: unclean }).reasons[0]).toMatch(/wasn't clean/);
  const builtYesterday = [...calmWeek.slice(0, 2), session(day(1), { mode: "build" })];
  expect(mode({ sessions: builtYesterday }).reasons[0]).toMatch(/48 hours/);
  expect(mode({ sessions: calmWeek.slice(1) }).reasons[0]).toMatch(/consistency first/);
});

test("theme follows the biggest debt and avoids repeating the last theme", () => {
  const d: EngineData = {
    ...data,
    targets: { patterns: {}, regions: { hips: 2, neck: 2 } },
    themes: [
      { id: "hips", name: "Hips", blurb: "", modes: ["consistent"], emphasis: { patterns: {}, regions: { hips: 2 } }, formats: ["flow"], coreBias: [] },
      { id: "neck", name: "Neck", blurb: "", modes: ["consistent"], emphasis: { patterns: {}, regions: { neck: 2 } }, formats: ["flow"], coreBias: [] },
      { id: "rest", name: "Rest", blurb: "", modes: ["recovery"], emphasis: { patterns: {}, regions: {} }, formats: ["flow"], coreBias: [] },
    ],
  };
  const neckDone = [session(day(1), { done: [{ id: "neckEase" }] })];
  const r = Proposal.theme(d, { mode: "consistent", sessions: neckDone, today });
  expect(r.theme?.id).toBe("hips");
  expect(r.reasons[0]).toMatch(/hips/);
  expect(Proposal.theme(d, { mode: "consistent", sessions: neckDone, today, lastThemeId: "hips" }).theme?.id).toBe("neck");
  expect(Proposal.theme(d, { mode: "recovery", sessions: [], today }).theme?.id).toBe("rest");
  const a = Proposal.theme(d, { mode: "consistent", sessions: [], today }).theme?.id;
  const b = Proposal.theme(d, { mode: "consistent", sessions: [], today }).theme?.id;
  expect(a).toBe(b);
});

describe("beyond the standalone suite", () => {
  test("the 48-hour rule says 'yesterday' only for yesterday's build and 'earlier today' for today's (spec §5 change 3)", () => {
    const yesterday = mode({ sessions: [...calmWeek.slice(0, 2), session(day(1), { mode: "build" })] });
    expect(yesterday.mode).toBe("consistent");
    expect(yesterday.reasons[0]).toBe("You built strength yesterday — give it 48 hours.");
    const earlierToday = mode({ sessions: [...calmWeek, session(today, { mode: "build" })] });
    expect(earlierToday.mode).toBe("consistent");
    expect(earlierToday.reasons[0]).toBe("You built strength earlier today — give it 48 hours.");
    const twoDaysAgo = mode({ sessions: [session(day(4)), session(day(3)), session(day(2), { mode: "build" }), session(day(1))] });
    expect(twoDaysAgo.mode).toBe("build");
  });

  test("with no profile active the proposal uses the general rules only, with no condition words", () => {
    const none = makeEngineData({ activeProfiles: [], careProfiles: [], exercises: data.exercises });
    const noneMode = (sessions: HistorySession[]) => Proposal.mode(none, { checks: {}, sessions, today, weeklyGoal: 4 });
    const rough = [...calmWeek.slice(0, 2), session(day(1), { pre: 1, post: 6, entries: [{ id: "a", clenched: true, sets: [] }, { id: "b", clenched: true, sets: [] }] })];
    const r = noneMode(rough);
    expect(r).toEqual({ mode: "build", reasons: ["3 sessions in the last 7 days."] });
    expect(noneMode([]).reasons).toEqual(["First session — start steady."]);
    expect(noneMode([session(day(5))]).reasons[0]).toMatch(/5 days since your last session/);
    for (const reason of [...r.reasons, ...noneMode(calmWeek.slice(1)).reasons]) expect(reason).not.toMatch(/tmj|jaw|clench/i);
  });
});

describe("two sessions on the same day (spec §5 change 2, Review Focus 5)", () => {
  const themed: EngineData = {
    ...data,
    targets: { patterns: {}, regions: { hips: 2, neck: 2 } },
    themes: [
      { id: "hips", name: "Hips", blurb: "", modes: ["consistent"], emphasis: { patterns: {}, regions: { hips: 2 } }, formats: ["flow"], coreBias: [] },
      { id: "neck", name: "Neck", blurb: "", modes: ["consistent"], emphasis: { patterns: {}, regions: { neck: 2 } }, formats: ["flow"], coreBias: [] },
    ],
  };
  const neckDone = session(day(1), { done: [{ id: "neckEase" }] });

  test("a second session today doesn't repeat the theme of today's first", () => {
    // Debt favours hips; the morning session already was hips, so the evening one isn't.
    expect(Proposal.theme(themed, { mode: "consistent", sessions: [neckDone], today }).theme?.id).toBe("hips");
    const morning = session(today, { startedAt: `${today}T07:00:00`, theme: "hips" });
    expect(Proposal.theme(themed, { mode: "consistent", sessions: [neckDone, morning], today }).theme?.id).toBe("neck");
    // Today's theme outranks yesterday's avoidance: with yesterday's theme also avoided, today's still isn't repeated.
    const yesterdayNeck = session(day(1), { theme: "neck", done: [{ id: "neckEase" }] });
    expect(Proposal.theme(themed, { mode: "consistent", sessions: [yesterdayNeck, morning], today }).theme?.id).toBe("neck");
    expect(Proposal.theme(themed, { mode: "consistent", sessions: [neckDone, morning], today, lastThemeId: "neck" }).theme?.id).toBe("neck");
  });

  test("the second session's proposal says 'earlier today', and the week's new move still counts", () => {
    const morning = session(today, { startedAt: `${today}T07:00:00`, mode: "build", done: [{ id: "hipOpener" }] });
    const r = mode({ sessions: [...calmWeek, morning] });
    expect(r.reasons[0]).toBe("You built strength earlier today — give it 48 hours.");
    // hipOpener was first done this morning: the week's new move is already taken for the evening session.
    expect(Hist.newMoveThisWeek(data, [...calmWeek, morning], today)).toBe(true);
    expect(Hist.newMoveThisWeek(data, calmWeek, today)).toBe(false);
    expect(Hist.firstDone(data, [...calmWeek, morning]).get("hipOpener")).toBe(today);
  });
});
