/**
 * Focused unit coverage for the pure half of the stacked-dialog Escape fix
 * (audit M17): `useDialogFocus` itself needs a real DOM to exercise (this
 * package's vitest environment is "node", not jsdom — see garden-hud.test's
 * companion `dockCoversStage` for the same split of pure-logic-vs-hook), so
 * the top-of-stack decision is pulled out as a plain function over an array
 * and tested directly here.
 */
import { describe, expect, it } from "vitest";
import { formatMinutes, isTopDialog } from "../src/components.js";

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
