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

  it("nextSeen: every fired ceremony — fresh AND preview-unlock species alike — is written to the permanent ledger (round 3)", () => {
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
    // Round 1/2 only ever recorded the preview-sourced id (a fresh durable
    // ceremony relied purely on watermark position for dedup) — round 3
    // records BOTH, since a resim can rebuild iris's row with a fresh
    // createdAt long after it's already been celebrated, and only the
    // permanent ledger (not position) can stop that from re-firing.
    expect(out.nextSeen.celebratedSpeciesIds).toEqual(["iris", "poppy"]);
  });

  it("a prior celebrated species is NEVER pruned back out, even once its durable row is behind the watermark (round 3: the ledger never shrinks)", () => {
    // This is the shape of the round-3 regression: pruning a celebrated id
    // whenever its row re-entered `fresh` (or, before that, whenever the
    // watermark simply advanced past it) assumed the row's POSITION was a
    // safe stand-in for "will never need to be excluded again" — but a
    // resim can recreate that exact row on a later visit with a brand-new
    // createdAt, which would then satisfy the insertion-time gate and
    // re-fire the ceremony were it not still in the ledger.
    const seen = { lastSeenDate: OLDER, lastSeenSeq: 0, celebratedSpeciesIds: ["poppy"] };
    const out = selectArrival(
      [ev("species_unlocked", YESTERDAY, { seq: 1, speciesId: "poppy" })],
      seen,
      TODAY,
    );
    expect(out.ceremonies).toEqual([]);
    expect(out.nextSeen.celebratedSpeciesIds).toEqual(["poppy"]);
  });

  describe("rebuilt-history admission (C13, insertion-time gate — round 2)", () => {
    // resimulateFrom rewrites events onto their ORIGINAL past date, which can
    // land at or before a real watermark (late-synced activity, a match
    // edit) — the append-only `after(e, wm)` test alone would exclude these
    // forever. species_unlocked/region_unlocked still deserve exactly one
    // celebration whenever that happens.
    //
    // The gate is INSERTION TIME (event.createdAt vs seen.updatedAt), not
    // position: a position-only test (date, seq strictly before the
    // watermark) can't tell a genuinely rebuilt row apart from an ordinary
    // event that was fresh on some earlier visit and already properly
    // celebrated via `fresh` — both end up "behind the watermark, not in
    // `celebrated`" on every later visit (round 1's regression).
    const T_CREATED = "2026-08-01T08:00:00.000Z"; // when an event row was first written
    const T_SEEN_BEFORE = "2026-08-03T09:00:00.000Z"; // a mark-seen AFTER T_CREATED
    const T_RESIM = "2026-08-04T10:00:00.000Z"; // resim rewrites the row AFTER T_SEEN_BEFORE
    const T_SEEN_AFTER = "2026-08-05T11:00:00.000Z"; // the next mark-seen, AFTER T_RESIM

    it("does NOT re-fire an ordinary event that was already fresh+celebrated on an earlier visit (the reviewer's exact repro)", () => {
      // Unlock at (D, seq 1); the visit that celebrated it ended with tip
      // (D, seq 2) from a sibling event that day, and posted seen.updatedAt
      // AFTER the unlock event was created — a completely ordinary flow.
      const D = "2026-08-03";
      const seen = {
        lastSeenDate: D,
        lastSeenSeq: 2,
        celebratedSpeciesIds: [],
        updatedAt: T_SEEN_BEFORE,
      };
      const out = selectArrival(
        [ev("species_unlocked", D, { seq: 1, speciesId: "iris", createdAt: T_CREATED })],
        seen,
        TODAY,
      );
      expect(out.ceremonies).toEqual([]);
      expect(out.nextSeen.celebratedSpeciesIds).toEqual([]);
    });

    it("admits a species_unlocked event whose row was rebuilt AFTER the last mark-seen", () => {
      const seen = {
        lastSeenDate: TODAY,
        lastSeenSeq: 5,
        celebratedSpeciesIds: [],
        updatedAt: T_SEEN_BEFORE,
      };
      const out = selectArrival(
        [ev("species_unlocked", OLDER, { seq: 0, speciesId: "dahlia", createdAt: T_RESIM })],
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

    it("fires exactly once, then never again after the next mark-seen (true C13 case, end to end)", () => {
      const seenBefore = {
        lastSeenDate: TODAY,
        lastSeenSeq: 5,
        celebratedSpeciesIds: [],
        updatedAt: T_SEEN_BEFORE,
      };
      const events = [
        ev("species_unlocked", OLDER, { seq: 0, speciesId: "dahlia", createdAt: T_RESIM }),
      ];
      const first = selectArrival(events, seenBefore, TODAY);
      expect(first.ceremonies).toEqual([{ kind: "species", speciesId: "dahlia", fromPreview: false }]);
      expect(first.nextSeen.celebratedSpeciesIds).toEqual(["dahlia"]);

      // The next mark-seen POST stamps a fresh updatedAt, strictly after the
      // resim that created the row.
      const seenAfter = {
        ...seenBefore,
        celebratedSpeciesIds: first.nextSeen.celebratedSpeciesIds,
        updatedAt: T_SEEN_AFTER,
      };
      const second = selectArrival(events, seenAfter, TODAY);
      expect(second.ceremonies).toEqual([]);
      // Retained (belt): even once the insertion-time gate alone would also
      // exclude it, the ledger still remembers it (suspenders).
      expect(second.nextSeen.celebratedSpeciesIds).toEqual(["dahlia"]);
    });

    it("admits a region_unlocked event rewritten after the last mark-seen, once", () => {
      const seenBefore = {
        lastSeenDate: TODAY,
        lastSeenSeq: 5,
        celebratedSpeciesIds: [],
        updatedAt: T_SEEN_BEFORE,
      };
      const events = [
        ev("region_unlocked", OLDER, { seq: 0, detail: "terrace", createdAt: T_RESIM }),
      ];
      const first = selectArrival(events, seenBefore, TODAY);
      expect(first.ceremonies).toEqual([{ kind: "ground", ground: "terrace", fromPreview: false }]);
      expect(first.nextSeen.celebratedSpeciesIds).toEqual(["ground:terrace"]);

      const second = selectArrival(
        events,
        { ...seenBefore, celebratedSpeciesIds: first.nextSeen.celebratedSpeciesIds, updatedAt: T_SEEN_AFTER },
        TODAY,
      );
      expect(second.ceremonies).toEqual([]);
      expect(second.nextSeen.celebratedSpeciesIds).toEqual(["ground:terrace"]);
    });

    it("does not backfill when there is no real watermark (missing seen row stays exactly as before)", () => {
      // Confirms the migration-day cliff (deliberately no replay of history
      // predating the default "start of yesterday" watermark) is untouched.
      const out = selectArrival(
        [ev("species_unlocked", OLDER, { seq: 0, speciesId: "dahlia", createdAt: T_RESIM })],
        null,
        TODAY,
      );
      expect(out.ceremonies).toEqual([]);
      expect(out.nextSeen.celebratedSpeciesIds).toEqual([]);
    });

    it("does not backfill when seen exists but has no updatedAt (safe default for an old/legacy payload shape)", () => {
      const seen = { lastSeenDate: TODAY, lastSeenSeq: 5, celebratedSpeciesIds: [] };
      const out = selectArrival(
        [ev("species_unlocked", OLDER, { seq: 0, speciesId: "dahlia", createdAt: T_RESIM })],
        seen,
        TODAY,
      );
      expect(out.ceremonies).toEqual([]);
      expect(out.nextSeen.celebratedSpeciesIds).toEqual([]);
    });

    it("does not backfill a durable event with no createdAt (defensive: never treated as newer than an unknown baseline)", () => {
      const seen = {
        lastSeenDate: TODAY,
        lastSeenSeq: 5,
        celebratedSpeciesIds: [],
        updatedAt: T_SEEN_BEFORE,
      };
      const out = selectArrival(
        [ev("species_unlocked", OLDER, { seq: 0, speciesId: "dahlia" })], // no createdAt
        seen,
        TODAY,
      );
      expect(out.ceremonies).toEqual([]);
      expect(out.nextSeen.celebratedSpeciesIds).toEqual([]);
    });
  });

  describe("permanent celebrated ledger survives resim rewrites (round 3)", () => {
    // Round 2's insertion-time gate (event.createdAt > seen.updatedAt) tells
    // a genuinely rebuilt row apart from an ordinary one that's simply
    // behind the watermark — but resimulateFrom stamps a FRESH createdAt on
    // EVERY event in its rewritten date range, including ones for
    // species/grounds that were unlocked and celebrated long ago. Without a
    // permanent record of "already celebrated," those old, already-shown
    // unlocks would satisfy the insertion-time gate too and re-fire. The
    // fix: `celebrated` is written into on every fire (fresh, backfilled,
    // preview alike) and never pruned back out — so the gate only ever
    // admits unlocks that have genuinely never been celebrated before.
    const T_SEEN_BEFORE = "2026-08-03T09:00:00.000Z";
    const T_RESIM = "2026-08-04T10:00:00.000Z"; // after T_SEEN_BEFORE

    it("(B) an already-celebrated unlock whose row is rewritten with a fresh createdAt does NOT re-fire", () => {
      const seen = {
        lastSeenDate: TODAY,
        lastSeenSeq: 5,
        celebratedSpeciesIds: ["dahlia"], // already celebrated on a prior visit
        updatedAt: T_SEEN_BEFORE,
      };
      // A routine resim rewrote dahlia's day (e.g. an unrelated late-synced
      // activity landing on the SAME date) — same content, but the row's
      // createdAt is now well after the last mark-seen, exactly like a
      // genuinely new backfilled unlock would look.
      const out = selectArrival(
        [ev("species_unlocked", OLDER, { seq: 0, speciesId: "dahlia", createdAt: T_RESIM })],
        seen,
        TODAY,
      );
      expect(out.ceremonies).toEqual([]);
      expect(out.nextSeen.celebratedSpeciesIds).toEqual(["dahlia"]);
    });

    it("(C) a version-bump-style rewrite of several past unlocks fires none that are already in the ledger", () => {
      // A SIMULATION_VERSION bump resimulates a user's ENTIRE history at
      // once: every event in it gets a fresh createdAt simultaneously,
      // whether or not its achievement was already celebrated.
      const seen = {
        lastSeenDate: TODAY,
        lastSeenSeq: 20,
        celebratedSpeciesIds: ["dahlia", "iris", "ground:terrace"],
        updatedAt: T_SEEN_BEFORE,
      };
      const events = [
        ev("species_unlocked", OLDER, { seq: 0, speciesId: "dahlia", createdAt: T_RESIM }),
        ev("species_unlocked", OLDER, { seq: 1, speciesId: "iris", createdAt: T_RESIM }),
        ev("region_unlocked", OLDER, { seq: 2, detail: "terrace", createdAt: T_RESIM }),
      ];
      const out = selectArrival(events, seen, TODAY);
      expect(out.ceremonies).toEqual([]);
      expect(out.nextSeen.celebratedSpeciesIds).toEqual(["dahlia", "iris", "ground:terrace"]);
    });

    it("a true (never-celebrated) unlock still fires inside the same kind of rewrite that suppresses the already-celebrated ones", () => {
      const seen = {
        lastSeenDate: TODAY,
        lastSeenSeq: 20,
        celebratedSpeciesIds: ["dahlia"],
        updatedAt: T_SEEN_BEFORE,
      };
      const events = [
        ev("species_unlocked", OLDER, { seq: 0, speciesId: "dahlia", createdAt: T_RESIM }), // already celebrated
        ev("species_unlocked", OLDER, { seq: 1, speciesId: "iris", createdAt: T_RESIM }), // genuinely new
      ];
      const out = selectArrival(events, seen, TODAY);
      expect(out.ceremonies).toEqual([{ kind: "species", speciesId: "iris", fromPreview: false }]);
      expect(out.nextSeen.celebratedSpeciesIds).toEqual(["dahlia", "iris"]);
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
