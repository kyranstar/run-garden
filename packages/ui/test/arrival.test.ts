/**
 * selectArrival: the pure selector behind the garden's arrival block
 * (spec §3–§4, docs/superpowers/specs/2026-08-05-garden-reward-loop-design.md).
 * Durable events past the server watermark ∪ same-day preview events, minus
 * already-celebrated — ceremonies first (grounds, then species rare-first),
 * beat and today lines both rendered, sprout/sparkle windows derived here.
 */
import { describe, expect, it } from "vitest";
import type { GardenEvent } from "@rg/domain";
import {
  eventSentence,
  selectArrival,
  shouldInvalidateGarden,
  type ArrivalEvent,
} from "../src/screens/arrival.js";

const TODAY = "2026-08-05";
const YESTERDAY = "2026-08-04";
const OLDER = "2026-08-01";

let autoSeq = 0;
function ev(
  kind: GardenEvent["kind"],
  date: string,
  extra: Partial<ArrivalEvent> = {},
): ArrivalEvent {
  const seq = extra.seq ?? autoSeq++;
  return {
    id: `ge-${date}-${seq}`,
    date,
    seq,
    simulationVersion: 3,
    kind,
    ...extra,
  } as ArrivalEvent;
}

const SEEN_CURRENT = { lastSeenDate: TODAY, lastSeenSeq: 999, celebratedSpeciesIds: [] };

describe("selectArrival", () => {
  it("brand-new garden (no durable events): markSeenImmediately, no ceremonies", () => {
    const out = selectArrival([ev("plant_added", TODAY, { preview: true, plantId: "pl-1" })], null, TODAY);
    expect(out.markSeenImmediately).toBe(true);
    expect(out.ceremonies).toEqual([]);
    expect(out.enteringPlantIds).toEqual(["pl-1"]);
  });

  it("missing seen row + durable history: watermark defaults to start of yesterday", () => {
    const out = selectArrival(
      [
        ev("species_unlocked", OLDER, { speciesId: "poppy" }),
        ev("species_unlocked", YESTERDAY, { speciesId: "iris" }),
      ],
      null,
      TODAY,
    );
    expect(out.markSeenImmediately).toBe(false);
    expect(out.ceremonies).toEqual([{ kind: "species", speciesId: "iris", fromPreview: false }]);
  });

  it("durable species_unlocked past the watermark → ceremony; at or before → none", () => {
    const seen = { lastSeenDate: YESTERDAY, lastSeenSeq: 2, celebratedSpeciesIds: [] };
    const out = selectArrival(
      [
        ev("species_unlocked", YESTERDAY, { seq: 2, speciesId: "poppy" }), // at watermark
        ev("species_unlocked", YESTERDAY, { seq: 3, speciesId: "iris" }), // past it
      ],
      seen,
      TODAY,
    );
    expect(out.ceremonies).toEqual([{ kind: "species", speciesId: "iris", fromPreview: false }]);
  });

  it("preview species_unlocked → ceremony with fromPreview, even when seen is current", () => {
    const out = selectArrival(
      [ev("species_unlocked", TODAY, { preview: true, speciesId: "poppy" })],
      SEEN_CURRENT,
      TODAY,
    );
    expect(out.ceremonies).toEqual([{ kind: "species", speciesId: "poppy", fromPreview: true }]);
  });

  it("celebratedSpeciesIds suppresses a preview unlock's ceremony", () => {
    const out = selectArrival(
      [ev("species_unlocked", TODAY, { preview: true, speciesId: "poppy" })],
      { ...SEEN_CURRENT, celebratedSpeciesIds: ["poppy"] },
      TODAY,
    );
    expect(out.ceremonies).toEqual([]);
  });

  it("ground ceremonies lead; species ordered rare-first", () => {
    const seen = { lastSeenDate: OLDER, lastSeenSeq: 0, celebratedSpeciesIds: [] };
    const out = selectArrival(
      [
        ev("species_unlocked", YESTERDAY, { speciesId: "poppy" }), // common
        ev("species_unlocked", YESTERDAY, { speciesId: "dahlia" }), // rare
        ev("region_unlocked", YESTERDAY, { detail: "stream" }),
      ],
      seen,
      TODAY,
    );
    expect(out.ceremonies.map((c) => c.kind)).toEqual(["ground", "species", "species"]);
    expect(out.ceremonies[0]).toEqual({ kind: "ground", ground: "stream", fromPreview: false });
    expect(out.ceremonies[1]!.speciesId).toBe("dahlia");
    expect(out.ceremonies[2]!.speciesId).toBe("poppy");
  });

  it("events consumed by ceremonies don't repeat as beat or today lines", () => {
    const seen = { lastSeenDate: OLDER, lastSeenSeq: 0, celebratedSpeciesIds: [] };
    const out = selectArrival(
      [
        ev("species_unlocked", YESTERDAY, { speciesId: "poppy" }),
        ev("region_unlocked", YESTERDAY, { detail: "terrace" }),
        ev("run_completed", YESTERDAY, { workoutCategory: "easy" }),
      ],
      seen,
      TODAY,
    );
    expect(out.ceremonies).toHaveLength(2);
    expect(out.beatLines).toEqual(["An easy run watered the garden."]);
  });

  it("beat and today lines BOTH render (suppression-ternary regression)", () => {
    const seen = { lastSeenDate: OLDER, lastSeenSeq: 0, celebratedSpeciesIds: [] };
    const out = selectArrival(
      [
        ev("run_completed", YESTERDAY, { workoutCategory: "long" }),
        ev("run_completed", TODAY, { preview: true, workoutCategory: "quality" }),
      ],
      seen,
      TODAY,
    );
    expect(out.beatLines).toEqual(["A long run watered the garden."]);
    expect(out.todayLines).toEqual(["A quality run watered the garden."]);
  });

  it("caps beat at 3 with overflow and today at 2 with overflow", () => {
    const seen = { lastSeenDate: OLDER, lastSeenSeq: 0, celebratedSpeciesIds: [] };
    const out = selectArrival(
      [
        ev("run_completed", YESTERDAY, { workoutCategory: "easy" }),
        ev("rest_observed", YESTERDAY),
        ev("missed_run", YESTERDAY),
        ev("soil_tended", YESTERDAY),
        ev("run_completed", TODAY, { preview: true, workoutCategory: "easy" }),
        ev("soil_tended", TODAY, { preview: true }),
        ev("life_tended", TODAY, { preview: true }),
      ],
      seen,
      TODAY,
    );
    expect(out.beatLines).toHaveLength(3);
    expect(out.beatOverflow).toBe(true);
    expect(out.todayLines).toHaveLength(2);
    expect(out.todayOverflow).toBe(true);
  });

  it("enteringPlantIds spans durable-past-watermark and preview plant_added", () => {
    const seen = { lastSeenDate: OLDER, lastSeenSeq: 0, celebratedSpeciesIds: [] };
    const out = selectArrival(
      [
        ev("plant_added", YESTERDAY, { plantId: "pl-a", speciesId: "clover" }),
        ev("plant_added", TODAY, { preview: true, plantId: "pl-b", speciesId: "poppy" }),
        ev("plant_added", OLDER, { seq: -5, plantId: "pl-old", speciesId: "clover" }),
      ],
      seen,
      TODAY,
    );
    expect(out.enteringPlantIds).toEqual(["pl-a", "pl-b"]);
  });

  it("sparkles: rare/uncommon plantings and wildlife arrivals; common plants absent", () => {
    const seen = { lastSeenDate: OLDER, lastSeenSeq: 0, celebratedSpeciesIds: [] };
    const out = selectArrival(
      [
        ev("plant_added", YESTERDAY, { plantId: "pl-a", speciesId: "clover" }), // common
        ev("plant_added", YESTERDAY, { plantId: "pl-b", speciesId: "coneflower" }), // uncommon
        ev("wildlife_arrived", YESTERDAY, { wildlifeId: "bees" }),
      ],
      seen,
      TODAY,
    );
    expect(out.sparkles).toEqual([
      { kind: "plant", plantId: "pl-b", speciesId: "coneflower" },
      { kind: "wildlife", wildlifeId: "bees" },
    ]);
  });

  it("nextSeen: durable tip + preview-unlock species retained as celebrated", () => {
    const seen = { lastSeenDate: OLDER, lastSeenSeq: 0, celebratedSpeciesIds: [] };
    const out = selectArrival(
      [
        ev("run_completed", YESTERDAY, { seq: 0, workoutCategory: "easy" }),
        ev("species_unlocked", YESTERDAY, { seq: 4, speciesId: "iris" }),
        ev("species_unlocked", TODAY, { preview: true, speciesId: "poppy" }),
      ],
      seen,
      TODAY,
    );
    expect(out.nextSeen.lastSeenDate).toBe(YESTERDAY);
    expect(out.nextSeen.lastSeenSeq).toBe(4);
    expect(out.nextSeen.celebratedSpeciesIds).toEqual(["poppy"]);
  });

  it("a prior celebrated species is dropped once its durable row is inside the watermark", () => {
    const seen = { lastSeenDate: OLDER, lastSeenSeq: 0, celebratedSpeciesIds: ["poppy"] };
    const out = selectArrival(
      [ev("species_unlocked", YESTERDAY, { seq: 1, speciesId: "poppy" })],
      seen,
      TODAY,
    );
    // The durable row is now ≤ nextSeen tip, so the id needn't be carried.
    expect(out.ceremonies).toEqual([]);
    expect(out.nextSeen.celebratedSpeciesIds).toEqual([]);
  });

  describe("rebuilt-history admission (C13)", () => {
    // resimulateFrom rewrites events onto their ORIGINAL past date, which can
    // land strictly before a real watermark (late-synced activity, a match
    // edit) — the append-only `after(e, wm)` test alone would exclude these
    // forever. species_unlocked/region_unlocked still deserve exactly one
    // celebration whenever that happens.

    it("admits a species_unlocked event rewritten strictly before a real watermark", () => {
      const seen = { lastSeenDate: TODAY, lastSeenSeq: 5, celebratedSpeciesIds: [] };
      const out = selectArrival(
        [ev("species_unlocked", OLDER, { seq: 0, speciesId: "dahlia" })],
        seen,
        TODAY,
      );
      expect(out.ceremonies).toEqual([{ kind: "species", speciesId: "dahlia", fromPreview: false }]);
      // The watermark itself doesn't need to move — the event was already
      // behind it; only the celebration ledger needs to remember it.
      expect(out.nextSeen.lastSeenDate).toBe(TODAY);
      expect(out.nextSeen.lastSeenSeq).toBe(5);
      expect(out.nextSeen.celebratedSpeciesIds).toEqual(["dahlia"]);
    });

    it("never replays a backfilled species ceremony once celebrated, and keeps it celebrated forever", () => {
      const seen = { lastSeenDate: TODAY, lastSeenSeq: 5, celebratedSpeciesIds: ["dahlia"] };
      const events = [ev("species_unlocked", OLDER, { seq: 0, speciesId: "dahlia" })];
      const out = selectArrival(events, seen, TODAY);
      expect(out.ceremonies).toEqual([]);
      // Unlike a normal preview-transitional id, this one is never "fresh" —
      // its event stays permanently behind the watermark — so it must be
      // retained, not pruned, or it would silently become eligible for
      // backfill-admission again on the very next visit.
      expect(out.nextSeen.celebratedSpeciesIds).toEqual(["dahlia"]);
    });

    it("admits a region_unlocked event rewritten strictly before a real watermark, once", () => {
      const seen = { lastSeenDate: TODAY, lastSeenSeq: 5, celebratedSpeciesIds: [] };
      const first = selectArrival(
        [ev("region_unlocked", OLDER, { seq: 0, detail: "terrace" })],
        seen,
        TODAY,
      );
      expect(first.ceremonies).toEqual([{ kind: "ground", ground: "terrace", fromPreview: false }]);
      expect(first.nextSeen.celebratedSpeciesIds).toEqual(["ground:terrace"]);

      // Same event, now-updated seen state: never replays.
      const second = selectArrival(
        [ev("region_unlocked", OLDER, { seq: 0, detail: "terrace" })],
        { ...seen, celebratedSpeciesIds: first.nextSeen.celebratedSpeciesIds },
        TODAY,
      );
      expect(second.ceremonies).toEqual([]);
      expect(second.nextSeen.celebratedSpeciesIds).toEqual(["ground:terrace"]);
    });

    it("does not backfill when there is no real watermark (missing seen row stays exactly as before)", () => {
      // Confirms the migration-day cliff (deliberately no replay of history
      // predating the default "start of yesterday" watermark) is untouched:
      // a never-before-celebrated species from well before that default
      // still does not ceremony when `seen` itself is null.
      const out = selectArrival(
        [ev("species_unlocked", OLDER, { seq: 0, speciesId: "dahlia" })],
        null,
        TODAY,
      );
      expect(out.ceremonies).toEqual([]);
      expect(out.nextSeen.celebratedSpeciesIds).toEqual([]);
    });

    it("an event exactly AT the watermark's own tip is already covered, not a backfill candidate", () => {
      const seen = { lastSeenDate: YESTERDAY, lastSeenSeq: 2, celebratedSpeciesIds: [] };
      const out = selectArrival(
        [ev("species_unlocked", YESTERDAY, { seq: 2, speciesId: "poppy" })],
        seen,
        TODAY,
      );
      expect(out.ceremonies).toEqual([]);
      expect(out.nextSeen.celebratedSpeciesIds).toEqual([]);
    });
  });
});

describe("eventSentence rarity", () => {
  it("rare planting gets the lucky-find verb", () => {
    expect(eventSentence(ev("plant_added", TODAY, { speciesId: "dahlia" }))).toBe(
      "A rare Garden dahlia has taken root — a lucky find.",
    );
  });
  it("uncommon planting is named as uncommon", () => {
    expect(eventSentence(ev("plant_added", TODAY, { speciesId: "coneflower" }))).toBe(
      "An uncommon Coneflower took root.",
    );
  });
  it("common planting is unchanged", () => {
    expect(eventSentence(ev("plant_added", TODAY, { speciesId: "clover" }))).toBe(
      "A White clover took root.",
    );
  });
  it("rare tree seed keeps the seed phrasing", () => {
    expect(
      eventSentence(ev("plant_added", TODAY, { speciesId: "milestone_oak", detail: "tree_seed" })),
    ).toBe("A rare Milestone oak seed was planted.");
  });
});

describe("shouldInvalidateGarden", () => {
  it("true only when a non-null read timestamp advances", () => {
    expect(shouldInvalidateGarden(null, "2026-08-05T10:00:00Z")).toBe(false);
    expect(shouldInvalidateGarden("2026-08-05T10:00:00Z", "2026-08-05T10:00:00Z")).toBe(false);
    expect(shouldInvalidateGarden("2026-08-05T10:00:00Z", "2026-08-05T10:05:00Z")).toBe(true);
    expect(shouldInvalidateGarden("2026-08-05T10:00:00Z", null)).toBe(false);
  });
});
