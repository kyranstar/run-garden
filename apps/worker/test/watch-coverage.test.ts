import { describe, expect, it } from "vitest";
import {
  coachSessionSchema,
  sessionWatchCoverage,
  watchCoverage,
  watchSessionShape,
  type CoachSession,
  type WatchSessionShape,
} from "@rg/domain";
import { watchPushable } from "../src/services/coach-apply.js";
import { deriveWorkoutSync, type CloudPresence } from "../src/services/sync-status.js";

/**
 * WHAT THE WATCH WILL SHOW, and whether the app is allowed to say it.
 *
 * Two properties are load-bearing here and neither is about copy:
 *
 *  1. The disclosure and the push are the SAME decision. `watchCoverage` says
 *     `none` exactly when `watchPushable` says false. If those two ever part
 *     company the app starts telling athletes a session is app-only while it
 *     is on their watch, or the reverse — which is the family of bug this
 *     whole field exists to end.
 *  2. Full coverage is silence. A session that crosses whole must produce no
 *     gaps, because the UI renders gaps and a normal run must stay quiet.
 */

const session = (o: Record<string, unknown>): CoachSession =>
  coachSessionSchema.parse({ title: "S", durationMinutes: 40, ...o });

const run = (...kinds: Array<"duration" | "distance">) =>
  session({
    category: "easy",
    run: { blocks: kinds.map((k) => (k === "duration" ? { kind: "duration", value: 10 } : { kind: "distance", value: 400 })) },
  });

const lift = (exercises: Array<Record<string, unknown>>) =>
  session({ category: "strength", lift: { exercises } });

const mobility = (exercises: Array<Record<string, unknown>>) =>
  session({ category: "yoga", mobility: { exercises } });

/** A whole session vocabulary, so the equivalence below is a claim about the
 * vocabulary rather than about four hand-picked examples. */
const CORPUS: Array<[string, CoachSession]> = [
  ["a timed easy run", run("duration", "duration")],
  ["a single timed block", run("duration")],
  ["one distance block among timed ones", run("duration", "distance", "duration")],
  ["a wholly distance-measured run", run("distance")],
  ["an unstructured run (no blocks)", session({ category: "easy", run: { blocks: [] } })],
  ["a session with no body at all", session({ category: "easy" })],
  ["a rest day", session({ category: "rest", durationMinutes: 0 })],
  ["a lift with catalog ids", lift([{ name: "Squat", sets: 3, reps: 8, originId: "e1" }])],
  ["a lift with an unknown movement", lift([{ name: "Skier hops", sets: 3, reps: 8 }])],
  ["a bodyless strength day", lift([])],
  ["a mobility circuit", mobility([{ name: "Wall sit", sets: 3, holdSeconds: 45, originId: "e2" }])],
  ["a per-side, tempo'd lift", lift([{ name: "Nordic curl", sets: 3, reps: 8, perSide: true, eccentricSeconds: 4, originId: "e3" }])],
];

describe("watchCoverage agrees with the predicate that decides the push", () => {
  for (const [label, s] of CORPUS) {
    it(`${label}: coverage !== "none" ⟺ watchPushable`, () => {
      expect(sessionWatchCoverage(s).coverage !== "none").toBe(watchPushable(s));
    });
  }
});

describe("watchCoverage names the reason", () => {
  it("a lift is app-only because it is a lift, not because of its movements", () => {
    const view = sessionWatchCoverage(lift([{ name: "Squat", sets: 3, reps: 8, originId: "e1" }]));
    expect(view).toEqual({
      coverage: "none",
      discipline: "lift",
      gaps: [{ code: "discipline_off_wire" }],
    });
  });

  it("names the movements the watch library has never heard of, as a second fact", () => {
    const view = sessionWatchCoverage(
      lift([
        { name: "Squat", sets: 3, reps: 8, originId: "e1" },
        { name: "Skier hops", sets: 3, reps: 12 },
      ]),
    );
    // Discipline FIRST: renaming "Skier hops" would not put this on the watch,
    // and a reason list that led with the catalog would imply it might.
    expect(view.gaps.map((g) => g.code)).toEqual(["discipline_off_wire", "off_catalog"]);
    expect(view.gaps[1]!.names).toEqual(["Skier hops"]);
  });

  it("files mobility as mobility, so the copy can say 'a mobility session'", () => {
    expect(sessionWatchCoverage(mobility([])).discipline).toBe("mobility");
  });

  it("refuses a run the moment one block is measured in distance", () => {
    expect(sessionWatchCoverage(run("duration", "distance")).gaps).toEqual([{ code: "distance_target" }]);
  });

  it("has nothing to hold when a run has no blocks", () => {
    expect(sessionWatchCoverage(session({ category: "easy" })).gaps).toEqual([{ code: "empty_body" }]);
  });

  it("is silent — no gaps at all — for a session that crosses whole", () => {
    expect(sessionWatchCoverage(run("duration", "duration"))).toEqual({
      coverage: "full",
      discipline: "run",
      gaps: [],
    });
  });

  it("declines to guess pace coverage from ops alone", () => {
    // The manifest holds no threshold pace, so the session adapter reports 0
    // owed rather than telling half the athletes their targets are missing.
    expect(watchSessionShape(run("duration")).paceTargetsOwed).toBe(0);
  });

  it("reports a partial crossing when steps will arrive with no pace band", () => {
    const shape: WatchSessionShape = {
      discipline: "run",
      runBlocks: ["duration", "duration"],
      paceTargetsOwed: 2,
      exercises: [],
    };
    expect(watchCoverage(shape)).toEqual({
      coverage: "partial",
      discipline: "run",
      gaps: [{ code: "pace_targets_owed", count: 2 }],
    });
  });
});

// ── The derivation ──────────────────────────────────────────────────────────

const online: CloudPresence = { registered: true, online: true, writeCapable: true };
const base = {
  effectiveDate: "2026-08-20",
  lastVerifiedCorosDate: "2026-08-20",
  hasOpenContentIntent: false,
  hasPendingJob: false,
  hasFailedJob: false,
  presence: online,
  writesEnabled: true,
};

describe("deriveWorkoutSync sees content, not just dates", () => {
  it("still reads synced when COROS has the session as written", () => {
    expect(deriveWorkoutSync(base)).toBe("synced");
  });

  it("reads content_stale when an approved ease rewrote a session COROS holds", () => {
    // THE BUG THIS FIXES: no job is enqueued for a content change, so nothing
    // is pending and nothing has failed. The date still matches, so the old
    // derivation returned "synced", `hideWhenHealthy` hid the pill, and the
    // sheet's banner was gated on the same comparison. Zero indicators.
    expect(deriveWorkoutSync({ ...base, hasOpenContentIntent: true })).toBe("content_stale");
  });

  it("lets a wrong DATE outrank a stale copy — that is the fact you act on", () => {
    expect(
      deriveWorkoutSync({ ...base, effectiveDate: "2026-08-21", hasOpenContentIntent: true }),
    ).toBe("calendar_only");
  });

  it("keeps every other state exactly where it was", () => {
    expect(deriveWorkoutSync({ ...base, hasPendingJob: true })).toBe("syncing");
    expect(
      deriveWorkoutSync({
        ...base,
        hasPendingJob: true,
        presence: { registered: true, online: false, writeCapable: false },
      }),
    ).toBe("waiting_for_device");
    expect(deriveWorkoutSync({ ...base, effectiveDate: "2026-08-21", hasFailedJob: true })).toBe("sync_issue");
    expect(deriveWorkoutSync({ ...base, effectiveDate: "2026-08-21" })).toBe("calendar_only");
    // A never-verified row: "" can never equal a real date.
    expect(deriveWorkoutSync({ ...base, lastVerifiedCorosDate: "" })).toBe("calendar_only");
  });
});
