// @vitest-environment jsdom
/**
 * A MOVE, EXPLAINED WHERE IT IS NAMED (the owner, 2026-11-04: "hover over each exercise to see a card showing and
 * explaining each exercise, how to do it, and why we do it, and any key tips").
 *
 *  - The card: the name and today's dose, the summary, what it works (on the figure and in words), why (the workout's
 *    own reason first, then the library's), how (setup, then the steps), and the key tips (focus, Avoid, Breathe).
 *  - A name that is a button: a mouse's hover opens it and moving onto the card keeps it; a touch's pointer does not
 *    (its tap does, and pins it); a second tap, Escape or a press elsewhere closes it; one card at a time.
 *  - A name inside another control (`hover`): a mouse's hover only, and the card is hidden from a screen reader.
 *  - The workout sheet's line and the stage tree read exactly as they did, the name now the card's button; a name no
 *    library move holds stays plain text.
 */
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EXERCISES, type ExerciseRecord } from "@rg/exercise-library";
import { MoveCard, MoveCardBody, workedAreas } from "../src/components/move-card.js";
import { ExerciseLine } from "../src/screens/plan.js";
import { StageStructure } from "../src/screens/stage-structure.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const goblet = EXERCISES.find((e) => e.id === "gobletSquat") as ExerciseRecord;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  vi.useRealTimers();
});

function render(node: ReactNode) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(node));
}

const text = (el: Element | null | undefined) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const card = () => document.querySelector<HTMLElement>(".move-card");
const term = (name: string) => [...document.querySelectorAll<HTMLButtonElement>("button.move-term")].find((b) => text(b) === name);

/** A pointer event React reads as enter/leave (it listens for over/out), from a mouse or a finger. */
function pointer(el: Element, type: "pointerover" | "pointerout", pointerType: "mouse" | "touch", related: Element | null = null) {
  const e = new MouseEvent(type, { bubbles: true, cancelable: true, relatedTarget: related });
  Object.defineProperty(e, "pointerType", { value: pointerType });
  act(() => {
    el.dispatchEvent(e);
  });
}

describe("the card", () => {
  it("says what the move is, what it works, why, how and the key tips", () => {
    render(createElement(MoveCardBody, { move: goblet, dose: "3×8 @ 16 kg", why: "Builds the squat for ski season." }));
    const t = text(host);
    expect(t).toContain("Goblet squat");
    expect(t).toContain("3×8 @ 16 kg");
    expect(t).toContain("Hold the weight at your chest and sit down between your heels.");
    // What it works: the primary muscles, then the secondary ones — and on the figure.
    const works = [...host!.querySelectorAll(".move-card-works dt, .move-card-works dd")].map(text);
    expect(works).toEqual(["Works", "Quads · Glute max", "Also", "Adductors · Erector spinae"]);
    expect(host!.querySelector("svg.body-figure")?.getAttribute("aria-label")).toBe("Works the glutes and quads; also the back and hips");
    // Why: the workout's own reason first, then the library's.
    const why = [...host!.querySelectorAll("section")].find((s) => text(s.querySelector("h4")) === "Why")!;
    expect([...why.querySelectorAll("p")].map(text)).toEqual(["Builds the squat for ski season.", goblet.text.why]);
    // How: the setup, then the steps, in order.
    const how = [...host!.querySelectorAll("section")].find((s) => text(s.querySelector("h4")) === "How")!;
    expect([...how.querySelectorAll("li")].map(text)).toEqual([...goblet.text.setup, ...goblet.text.steps]);
    // The key tips: what to focus on, what to avoid, how to breathe.
    const tips = [...host!.querySelectorAll("section")].find((s) => text(s.querySelector("h4")) === "Key tips")!;
    const lines = [...tips.querySelectorAll("li")].map(text);
    expect(lines.slice(0, 3)).toEqual(goblet.text.focus.slice(0, 3));
    expect(lines).toContain(`Avoid ${goblet.text.mistakes[0]}`);
    expect(lines).toContain(`Breathe ${goblet.text.breathing}`);
  });

  it("draws nothing it has nothing for, and says the library's why alone when the workout gives none", () => {
    const bare = { name: "Plain move", text: { ...goblet.text, setup: [], steps: [], focus: [], mistakes: [], breathing: "", summary: "" } } as const;
    render(createElement(MoveCardBody, { move: bare }));
    expect([...host!.children].map(text)).toEqual(["Plain move", `Why${goblet.text.why}`]);
    expect(host!.querySelector("svg")).toBeNull();
  });

  it("works out the figure's areas from the muscles — the regions standing in when it names none", () => {
    expect(workedAreas(goblet)).toEqual({ primary: ["glutes", "quads"], secondary: ["back", "hips"] });
    expect(workedAreas({ name: "x", text: goblet.text, regions: ["core", "jaw"] })).toEqual({ primary: ["core"], secondary: [] });
  });
});

describe("a name that is a button", () => {
  it("opens on a mouse's hover after a beat, stays while the pointer is on the card, and closes once it leaves both", () => {
    vi.useFakeTimers();
    render(createElement(MoveCard, { move: goblet, dose: "3×8" }, "Goblet squat"));
    const name = term("Goblet squat")!;
    pointer(name, "pointerover", "mouse");
    expect(card()).toBeNull();
    act(() => vi.advanceTimersByTime(150));
    expect(card()).not.toBeNull();
    expect(name.getAttribute("aria-expanded")).toBe("true");
    expect(name.getAttribute("aria-controls")).toBe(card()!.id);
    // Off the name and onto the card: it stays.
    pointer(name, "pointerout", "mouse", card());
    pointer(card()!, "pointerover", "mouse", name);
    act(() => vi.advanceTimersByTime(500));
    expect(card()).not.toBeNull();
    // Off the card: it goes.
    pointer(card()!, "pointerout", "mouse", document.body);
    act(() => vi.advanceTimersByTime(500));
    expect(card()).toBeNull();
    expect(name.getAttribute("aria-expanded")).toBe("false");
  });

  it("a finger's pointer opens nothing by itself; its tap opens the card and keeps it, and a second tap closes it", () => {
    vi.useFakeTimers();
    render(createElement(MoveCard, { move: goblet }, "Goblet squat"));
    const name = term("Goblet squat")!;
    pointer(name, "pointerover", "touch");
    act(() => vi.advanceTimersByTime(500));
    expect(card()).toBeNull();
    act(() => name.click());
    expect(card()).not.toBeNull();
    pointer(name, "pointerout", "touch");
    act(() => vi.advanceTimersByTime(500));
    expect(card()).not.toBeNull();
    act(() => name.click());
    expect(card()).toBeNull();
  });

  it("Escape and a press elsewhere close it; opening another closes the first", () => {
    const squat = EXERCISES.find((e) => e.id === "boxSquat")!;
    render(
      createElement(
        "div",
        null,
        createElement(MoveCard, { move: goblet }, "Goblet squat"),
        createElement(MoveCard, { move: squat }, "Box squat"),
        createElement("p", { id: "elsewhere" }, "elsewhere"),
      ),
    );
    act(() => term("Goblet squat")!.click());
    expect(text(card())).toContain("Goblet squat");
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(card()).toBeNull();

    act(() => term("Goblet squat")!.click());
    act(() => {
      document.getElementById("elsewhere")!.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    });
    expect(card()).toBeNull();

    act(() => term("Goblet squat")!.click());
    act(() => term("Box squat")!.click());
    expect(document.querySelectorAll(".move-card")).toHaveLength(1);
    expect(text(card())).toContain(squat.name);
  });

  it("goes inside the dialog that holds the name, so the dialog's modality covers it", () => {
    render(createElement("div", { role: "dialog", "aria-modal": "true" }, createElement(MoveCard, { move: goblet }, "Goblet squat")));
    act(() => term("Goblet squat")!.click());
    expect(card()!.parentElement?.getAttribute("role")).toBe("dialog");
  });
});

describe("a name inside another control (hover)", () => {
  it("opens on a mouse's hover only, hidden from a screen reader; a press inside it is not the control's", () => {
    vi.useFakeTimers();
    const onRow = vi.fn();
    render(createElement("button", { type: "button", onClick: onRow }, createElement(MoveCard, { move: goblet, mode: "hover" }, "Goblet squat")));
    const name = document.querySelector<HTMLElement>(".move-hover")!;
    expect(document.querySelector("button.move-term")).toBeNull();
    pointer(name, "pointerover", "touch");
    act(() => vi.advanceTimersByTime(500));
    expect(card()).toBeNull();
    pointer(name, "pointerover", "mouse");
    act(() => vi.advanceTimersByTime(150));
    expect(card()?.getAttribute("aria-hidden")).toBe("true");
    act(() => card()!.click());
    expect(onRow).not.toHaveBeenCalled();
  });
});

describe("where workouts name their moves", () => {
  it("the workout sheet's line reads as it did, its name the card's button with the dose in the card's corner", () => {
    render(createElement("li", null, createElement(ExerciseLine, { name: "Goblet squat", line: "Goblet squat 3×8 @ 16 kg — pause at the bottom", moveId: "gobletSquat" })));
    expect(text(host)).toBe("Goblet squat 3×8 @ 16 kg — pause at the bottom");
    act(() => term("Goblet squat")!.click());
    expect(text(card()!.querySelector(".move-card-dose"))).toBe("3×8 @ 16 kg");
  });

  it("a name no library move holds — or an older server's line with no id — stays plain text", () => {
    render(
      createElement(
        "ul",
        null,
        createElement("li", null, createElement(ExerciseLine, { name: "Mystery move", line: "Mystery move 3×8", moveId: "notAMove" })),
        createElement("li", null, createElement(ExerciseLine, { name: "Goblet squat", line: "Goblet squat 3×8" })),
      ),
    );
    expect(document.querySelectorAll("button")).toHaveLength(0);
    expect(text(host)).toBe("Mystery move 3×8Goblet squat 3×8");
  });

  it("the stage tree: a step whose label is a library move explains it, the line unchanged", () => {
    const stages = [
      { id: "s1", ord: 0, parentStageId: null, kind: "work", durationSeconds: 60, label: "Goblet Squat", moveId: "gobletSquat" },
      { id: "s2", ord: 1, parentStageId: null, kind: "rest", durationSeconds: 60, label: null },
      { id: "s3", ord: 2, parentStageId: null, kind: "work", durationSeconds: 30, label: "Jumping Jacks" },
    ];
    render(createElement(StageStructure, { stages, units: "km" }));
    const lines = [...document.querySelectorAll(".stage-step-text")].map(text);
    expect(lines).toEqual(["work — 1 min (Goblet Squat)", "rest — 1 min", "work — 30s (Jumping Jacks)"]);
    expect(term("Goblet Squat")).toBeTruthy();
    expect(term("Jumping Jacks")).toBeUndefined();
  });
});
