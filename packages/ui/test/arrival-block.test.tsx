/**
 * CeremonyCard: static-markup assertions for both ceremony kinds (spec §3–§4).
 * The queue itself is trivial index state in GardenScreen; what must not
 * regress is the card's content — species vs ground bodies, the queue chip,
 * and the pull to the living plant.
 */
import { createElement } from "react";
import { renderToStaticMarkup as render } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { initialSnapshot } from "@rg/garden-engine";
import { CeremonyCard } from "../src/screens/arrival-block.js";
import type { CodexEntry } from "../src/screens/codex.js";

const snapshot = initialSnapshot("2026-08-01");

const cloverEntry: CodexEntry = {
  speciesId: "clover",
  name: "White clover",
  category: "groundcover",
  rarity: "common",
  unlocked: true,
  hint: "Here from your first day",
  progress: null,
  unlockedOn: "2026-08-01",
  livingCount: 2,
};

describe("CeremonyCard", () => {
  it("species ceremony renders name, hint, queue chip and the see-plant pull", () => {
    const html = render(
      createElement(CeremonyCard, {
        ceremony: { kind: "species", speciesId: "clover", fromPreview: true },
        codexEntry: cloverEntry,
        queueLeft: 2,
        snapshot,
        onSeePlant: () => undefined,
        onDismiss: () => undefined,
      }),
    );
    expect(html).toContain("A new species has taken root");
    expect(html).toContain("White clover");
    expect(html).toContain("Here from your first day");
    expect(html).toContain("2 more to come");
    // Genesis clover is alive in the snapshot, so the pull renders.
    expect(html).toContain("See it in the garden");
  });

  it("ground ceremony renders the ground name, carving copy, and no see-plant pull", () => {
    const html = render(
      createElement(CeremonyCard, {
        ceremony: { kind: "ground", ground: "stream", fromPreview: false },
        queueLeft: 0,
        snapshot,
        onSeePlant: () => undefined,
        onDismiss: () => undefined,
      }),
    );
    expect(html).toContain("New ground carved");
    expect(html).toContain("The Stream");
    expect(html).toContain("Long runs carved the stream — new ground, new water.");
    expect(html).not.toContain("See it in the garden");
    expect(html).not.toContain("more to come");
  });

  it("unknown ground kind renders nothing rather than a broken card", () => {
    const html = render(
      createElement(CeremonyCard, {
        ceremony: { kind: "ground", ground: "volcano", fromPreview: false },
        queueLeft: 0,
        snapshot,
        onSeePlant: () => undefined,
        onDismiss: () => undefined,
      }),
    );
    expect(html).toBe("");
  });
});
