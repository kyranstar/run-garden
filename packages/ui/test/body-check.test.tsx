/**
 * THE BODY CHECK ON THE TODAY CARD (the new shape, 2026-10-17; design §4): the panel as it draws each state, and the
 * words it says — "Eased to 14 km for heavy legs", in the athlete's units, with Undo; the chips show the choice and can
 * change until the session starts. Synthetic data; static markup (node env).
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { BodyCheckDto } from "@rg/api-client";
import { askRequest, bodyLine, BodyCheckPanel } from "../src/screens/today/body-check.js";

const AREAS = [
  { id: "neck", label: "Neck" },
  { id: "low-back", label: "Low back" },
  { id: "hips", label: "Hips" },
  { id: "calves", label: "Calves" },
  { id: "tmj", label: "Jaw / head" },
];

const view = (over: Partial<BodyCheckDto> = {}): BodyCheckDto => ({ workoutId: "w1", answer: null, change: null, open: true, areas: AREAS, ...over });

const noop = () => undefined;
const draw = (v: BodyCheckDto, over: Partial<Parameters<typeof BodyCheckPanel>[0]> = {}) =>
  renderToStaticMarkup(
    <BodyCheckPanel view={v} units="km" busy={false} error={null} onAnswer={noop} onUndo={noop} onAsk={null} {...over} />,
  );
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

describe("the words", () => {
  it("says what the ease did and why, in the athlete's units", () => {
    const heavy = { feel: "heavy" as const, areas: [] };
    expect(bodyLine(view({ answer: heavy, change: { kind: "eased", to: { meters: 14000 } } }), "km")).toBe("Eased to 14 km for heavy legs");
    expect(bodyLine(view({ answer: heavy, change: { kind: "eased", to: { meters: 14000 } } }), "mi")).toBe("Eased to 8.7 mi for heavy legs");
    expect(bodyLine(view({ answer: heavy, change: { kind: "eased", to: { minutes: 35 } } }), "km")).toBe("Eased to 35 min for heavy legs");
    expect(bodyLine(view({ answer: heavy, change: { kind: "eased", to: { mode: "recovery" } } }), "km")).toBe("Eased to a recovery session for heavy legs");
    const sore = (areas: string[]) => ({ feel: "sore" as const, areas });
    expect(bodyLine(view({ answer: sore(["calves"]), change: { kind: "eased", to: { mode: "consistent" } } }), "km")).toBe(
      "Eased to a consistent session for sore calves",
    );
    expect(bodyLine(view({ answer: sore(["hips", "calves"]), change: { kind: "eased", to: { minutes: 30 } } }), "km")).toBe(
      "Eased to 30 min for sore hips and calves",
    );
    expect(bodyLine(view({ answer: sore(["neck", "hips", "calves"]), change: { kind: "eased", to: { minutes: 30 } } }), "km")).toBe(
      "Eased to 30 min for sore neck, hips and calves",
    );
  });

  it("says plainly when nothing changed, and nothing at all for Fresh", () => {
    expect(bodyLine(view({ answer: { feel: "fresh", areas: [] } }), "km")).toBeNull();
    expect(bodyLine(view({ answer: { feel: "heavy", areas: [] }, change: { kind: "kept", why: "undone" } }), "km")).toBe("Kept as planned.");
    expect(bodyLine(view({ answer: { feel: "sore", areas: ["neck"] }, change: { kind: "kept", why: "quiet" } }), "km")).toBe(
      "Noted — today leaves your neck alone.",
    );
    expect(bodyLine(view({ answer: { feel: "heavy", areas: [] }, change: { kind: "kept", why: "gentlest" } }), "km")).toBe(
      "Today is already as gentle as it goes.",
    );
    expect(bodyLine(view({ answer: { feel: "heavy", areas: [] }, change: { kind: "kept", why: "race" } }), "km")).toBe("Race day — kept as planned.");
  });

  it("asks the coach in the athlete's words", () => {
    expect(askRequest({ feel: "heavy", areas: [] }, AREAS)).toBe("Legs are heavy; adapt today's session");
    expect(askRequest({ feel: "sore", areas: ["low-back", "tmj"] }, AREAS)).toBe("Sore low back and jaw / head; adapt today's session");
  });
});

describe("the panel", () => {
  it("asks the question with three real buttons, none chosen yet", () => {
    const html = draw(view());
    expect(text(html)).toBe("How’s your body? Fresh A bit heavy Sore somewhere");
    expect(html.match(/<button type="button"/g)).toHaveLength(3);
    expect(html.match(/aria-pressed="false"/g)).toHaveLength(3);
    expect(html).toContain('role="group"');
  });

  it("shows the choice (pressed, with its check — never colour alone), the line and Undo after an ease", () => {
    const html = draw(view({ answer: { feel: "heavy", areas: [] }, change: { kind: "eased", to: { meters: 14000 } } }));
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(html).toMatch(/aria-pressed="true"[^>]*>(<svg[\s\S]*?<\/svg>)A bit heavy/);
    expect(text(html)).toContain("Eased to 14 km for heavy legs Undo");
  });

  it("offers Undo only after an ease: never when nothing changed", () => {
    for (const why of ["undone", "quiet", "gentlest", "race"] as const) {
      const html = draw(view({ answer: { feel: "sore", areas: ["neck"] }, change: { kind: "kept", why } }));
      expect(text(html)).not.toContain("Undo");
    }
  });

  it("offers the coach instead for a designed workout, and nothing to undo", () => {
    const html = draw(view({ answer: { feel: "heavy", areas: [] }, change: { kind: "ask" } }), { onAsk: noop });
    expect(text(html)).toContain("Ask the coach to adapt it");
    expect(text(html)).not.toContain("Undo");
    // Without the coach in the app it says nothing more.
    expect(text(draw(view({ answer: { feel: "heavy", areas: [] }, change: { kind: "ask" } })))).toBe("How’s your body? Fresh A bit heavy Sore somewhere");
  });

  it("once the session has started: the choice stays, nothing can change", () => {
    const html = draw(view({ answer: { feel: "heavy", areas: [] }, change: { kind: "eased", to: { minutes: 35 } }, open: false }));
    expect(html.match(/disabled=""/g)).toHaveLength(3);
    expect(text(html)).toContain("Eased to 35 min for heavy legs");
    expect(text(html)).not.toContain("Undo");
  });

  it("Sore somewhere waits for the areas it offers; the others don't", () => {
    const html = draw(view({ areas: [] }));
    expect(html.match(/disabled=""/g)).toHaveLength(1);
    expect(html).toMatch(/disabled=""[^>]*>Sore somewhere/);
  });

  it("says when a save didn't go through", () => {
    expect(text(draw(view(), { error: "Couldn't save — try again." }))).toContain("Couldn't save — try again.");
  });
});
