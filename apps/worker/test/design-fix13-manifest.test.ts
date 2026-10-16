/**
 * TASK 13'S FIX WAVE, THE REVIEW STREAM (fix13-brief.md, S2): THE SUGGESTION'S LINES SPEAK TO THE ATHLETE.
 *
 *  - Every review string the athlete can see — each dimension's note, the must-fix items, the improvements, what changed,
 *    the costs they chose, the note — passes through `athleteText` (a move's id becomes its name, a tool or "validator"
 *    plain words) and is clipped to its cap at a sentence end (§2.1, §2.8; 13b I8, 13c R5, 13d D2). The designer read it
 *    whole; the card shows it fitted.
 *  - A retired rubric id keeps a plain label (LEGACY_LABELS); an id no one knows is put in words — never shown raw
 *    (§2.10).
 *
 * Synthetic data only.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_USER_PREFERENCES } from "@rg/domain";
import type { DesignedOp } from "../src/services/design-approve.js";
import { docWorkoutLines, LEGACY_LABELS } from "../src/services/design-manifest.js";
import { REVIEW_ITEM_MAX, REVIEW_NOTE_MAX } from "../src/services/design-review.js";
import { calmDoc } from "./doc-workout-fixture.js";

const place = () => "Home";
const CLOCK = { now: new Date("2026-10-14T08:00:00.000Z"), prefs: DEFAULT_USER_PREFERENCES };

function op(over: Partial<DesignedOp> = {}): DesignedOp {
  return {
    kind: "doc_workout",
    target: { kind: "new", date: "2026-10-16" },
    date: "2026-10-16",
    doc: calmDoc(),
    review: null,
    issues: [],
    derived: {},
    by: { runId: "run-d1", role: "designer" },
    toolUseId: "toolu_1",
    at: "2026-10-14T08:00:00.000Z",
    ...over,
  } as DesignedOp;
}

const sentences = (n: number) => "The hips get a long easy hold here. ".repeat(Math.ceil(n / 36)).slice(0, n);

describe("the review as the athlete reads it (§2.1, §2.8)", () => {
  it("every string in their words — moves by name, no tool or app words — and fitted to its cap at a sentence end", () => {
    const [line] = docWorkoutLines(
      [
        op({
          review: {
            scores: { intent: 4, recovery: 3 },
            notes: {
              intent: "Swap gobletSquat ahead of deadBug: the validator wants the hinge fresh.",
              recovery: `${sentences(400)}`,
            },
            mustFix: ["read_balance shows no hamstring work: add some."],
            improvements: [`Cue the athlete's jaw on deadBug. ${sentences(300)}`],
            rounds: 2,
            changes: ["Moved gobletSquat earlier."],
            accepted: [{ dimension: "recovery", why: "heavier legs for the athlete's long run" }],
          } as DesignedOp["review"],
        }),
      ],
      place,
      CLOCK,
    );
    const r = line!.review!;
    expect(r.dimensions.find((d) => d.id === "intent")!.note).toBe("Swap Goblet squat ahead of Dead bug: the app's checks wants the hinge fresh.");
    const recovery = r.dimensions.find((d) => d.id === "recovery")!.note!;
    expect(recovery.length).toBeLessThanOrEqual(REVIEW_NOTE_MAX);
    expect(recovery.endsWith(".")).toBe(true);
    expect(r.mustFix).toEqual(["Your recent balance shows no hamstring work: add some."]);
    expect(r.improvements[0]!.startsWith("Cue your jaw on Dead bug.")).toBe(true);
    expect(r.improvements[0]!.length).toBeLessThanOrEqual(REVIEW_ITEM_MAX);
    expect(r.changes).toEqual(["Moved Goblet squat earlier."]);
    expect(r.accepted).toEqual(["Recovery — kept as you asked: heavier legs for your long run"]);
    for (const s of [...r.dimensions.map((d) => d.note ?? ""), ...r.mustFix, ...r.improvements, ...r.changes, ...r.accepted]) {
      expect(s, s).not.toMatch(/\b[a-z]+[A-Z][A-Za-z]*\b|\b[a-z]+_[a-z_]+\b|validator/);
    }
  });

  it("a retired id keeps a plain label; an id no one knows is put in words — never its raw id (§2.10)", () => {
    expect(LEGACY_LABELS).toMatchObject({ time_fit: expect.any(String), equipment_fit: expect.any(String) });
    const [line] = docWorkoutLines(
      [op({ review: { scores: { intent: 5, time_fit: 4, equipment_fit: 3, pace_feel: 2 }, notes: {}, mustFix: [], improvements: [], rounds: 1, changes: [], accepted: [{ dimension: "time_fit", why: "the long version" }] } as DesignedOp["review"] })],
      place,
      CLOCK,
    );
    expect(line!.review!.dimensions).toEqual([
      { id: "intent", label: "Intent clarity", score: 5, note: null },
      { id: "time_fit", label: LEGACY_LABELS.time_fit, score: 4, note: null },
      { id: "equipment_fit", label: LEGACY_LABELS.equipment_fit, score: 3, note: null },
      { id: "pace_feel", label: "Pace feel", score: 2, note: null },
    ]);
    expect(line!.review!.accepted).toEqual([`${LEGACY_LABELS.time_fit} — kept as you asked: the long version`]);
    // An old review's mean is over its own dimensions.
    expect(line!.reviewMean).toBe(3.5);
  });
});
