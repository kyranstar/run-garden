/**
 * Focused unit coverage for the pure half of the stacked-dialog Escape fix
 * (audit M17): `useDialogFocus` itself needs a real DOM to exercise (this
 * package's vitest environment is "node", not jsdom — see garden-hud.test's
 * companion `dockCoversStage` for the same split of pure-logic-vs-hook), so
 * the top-of-stack decision is pulled out as a plain function over an array
 * and tested directly here.
 */
import { describe, expect, it } from "vitest";
import { sessionNoun } from "@rg/analytics";
import {
  countNoun,
  formatMinutes,
  isTopDialog,
  syncActionCopy,
  syncActionShort,
} from "../src/components.js";

describe("formatMinutes (M5)", () => {
  it("renders null/undefined as an em dash", () => {
    expect(formatMinutes(null)).toBe("—");
    expect(formatMinutes(undefined)).toBe("—");
  });

  it("stays in minutes under 90 minutes — most runs and plan-length workouts", () => {
    expect(formatMinutes(50 * 60)).toBe("50 min");
    expect(formatMinutes(89 * 60)).toBe("89 min");
  });

  it("switches to hours+minutes at 90 minutes — a multi-hour adventure no longer reads as a bare minute count", () => {
    expect(formatMinutes(90 * 60)).toBe("1h 30m");
    expect(formatMinutes(4 * 3600)).toBe("4h");
    expect(formatMinutes(4 * 3600 + 5 * 60)).toBe("4h 5m");
  });
});

describe("countNoun (audit 2026-08-14: 'over 1 runs')", () => {
  it("agrees with the count in both directions", () => {
    expect(countNoun(1, "run")).toBe("1 run");
    expect(countNoun(0, "run")).toBe("0 runs");
    expect(countNoun(12, "run")).toBe("12 runs");
  });

  it("takes an explicit plural for nouns that don't just take an s", () => {
    expect(countNoun(1, "yoga session", "yoga sessions")).toBe("1 yoga session");
    expect(countNoun(3, "yoga session", "yoga sessions")).toBe("3 yoga sessions");
  });

  it("composes with sessionNoun so Insights never calls a lift a run", () => {
    const sessions = (n: number, d: "run" | "strength" | "yoga") =>
      countNoun(n, sessionNoun(d), sessionNoun(d, true));
    expect(sessions(1, "run")).toBe("1 run");
    expect(sessions(4, "strength")).toBe("4 lifts");
    expect(sessions(1, "yoga")).toBe("1 yoga session");
  });
});

describe("isTopDialog (M17)", () => {
  it("the only open dialog is top", () => {
    const a = Symbol("a");
    expect(isTopDialog([a], a)).toBe(true);
  });

  it("only the most recently opened dialog is top — a species sheet opened over the Collection drawer must not let one Escape close both", () => {
    const drawer = Symbol("collection-drawer");
    const sheet = Symbol("species-sheet");
    const stack = [drawer, sheet];
    expect(isTopDialog(stack, sheet)).toBe(true);
    expect(isTopDialog(stack, drawer)).toBe(false);
  });

  it("an empty stack has no top", () => {
    expect(isTopDialog([], Symbol("a"))).toBe(false);
  });

  it("a token that isn't on the stack is never top", () => {
    const a = Symbol("a");
    const stranger = Symbol("stranger");
    expect(isTopDialog([a], stranger)).toBe(false);
  });
});

/**
 * THE WORDS FOR EVERY ACTION. `syncActionCopy` is a total function over the
 * code union, so the compiler already forces a case per code — what it cannot
 * force is that the words match the AGENT, and that is the whole design: an
 * `app` or `nobody` action must never carry an instruction, because there is
 * nothing for the athlete to do and a sentence in the imperative is how a
 * receipt comes to read as a chore.
 */
describe("syncActionCopy (2026-08-17)", () => {
  const CODES = [
    ["sending", "app"],
    ["removing_from_watch", "app"],
    ["pace_targets_pending", "app"],
    ["connect_coros", "athlete"],
    ["enable_coros_writes", "athlete"],
    ["retry_write", "athlete"],
    ["choose_a_date", "athlete"],
    ["make_it_measurable", "athlete"],
    ["name_it_on_the_watch", "athlete"],
    ["lives_here", "nobody"],
    ["watch_keeps_old_copy", "nobody"],
  ] as const;

  it("gives an instruction to the athlete and to nobody else", () => {
    for (const [code, agent] of CODES) {
      const { says, todo } = syncActionCopy({ agent, code, names: ["Nordic curl"] });
      expect(says.length, `${code} says nothing`).toBeGreaterThan(10);
      if (agent === "athlete") expect(todo, `${code} tells the athlete nothing to do`).toBeTruthy();
      else expect(todo, `${code} hands work to ${agent}`).toBeNull();
    }
  });

  it("never words a boundary as a failure", () => {
    // "Not on your watch" read as a bug report for months. The two states
    // nobody can fix must not contain the vocabulary of breakage.
    for (const code of ["lives_here", "watch_keeps_old_copy"] as const) {
      const { says } = syncActionCopy({ agent: "nobody", code });
      expect(says).not.toMatch(/fail|error|couldn't|broken|problem/i);
    }
  });

  it("names the movements, because the names are the actionable part", () => {
    const { says, todo } = syncActionCopy({
      agent: "athlete",
      code: "name_it_on_the_watch",
      names: ["Nordic curl", "Copenhagen plank"],
    });
    expect(says).toContain("Nordic curl and Copenhagen plank");
    expect(todo).toMatch(/COROS exercise library/);
  });

  it("shows only the athlete's half in the short form a card can spare", () => {
    expect(syncActionShort({ agent: "app", code: "sending" })).toBeNull();
    expect(syncActionShort({ agent: "nobody", code: "watch_keeps_old_copy" })).toBeNull();
    expect(syncActionShort({ agent: "athlete", code: "retry_write", control: "retry" })).toBe(
      "Send it to COROS.",
    );
    expect(syncActionShort(undefined)).toBeNull();
  });
});
