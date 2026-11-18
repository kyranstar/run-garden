/**
 * THE COLLISION PASS NEVER PLACES A SESSION BEFORE NOW (stage 2b review r-m2; the web's pass as much as the phone's).
 *
 * Laying a colliding day out again takes each movable session from its window time (07:00 on a weekday morning), which on
 * a day ahead is the design — the day's anchor gets the time the athlete chose, the fillers queue behind it. On TODAY that
 * put a session planned for 18:00 at 07:00 when it was already 09:00 (RV-D4): a time gone, eleven hours away. Today, now:
 *
 *  - a session whose time has already come stays where it is (the athlete's to move: the pass never rewrites a passed time);
 *  - every other one keeps the time it holds — the athlete's day is planned around it, its event booked — unless it
 *    collides, and then it moves LATER, behind what is placed, never earlier: nothing lands before now;
 *  - which one keeps its time is the day's own rule (the heavier anchors), as before.
 *
 * A day ahead is laid out as it always was. Pure functions; synthetic data only.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_SCHEDULING_PREFERENCES, type SchedulingPreferences } from "@rg/domain";
import { EXERCISES } from "@rg/exercise-library";
import { deriveDoc } from "@rg/workout";
import { localClock, placeDaySessions, relaidDay, type PlaceableSession } from "../src/services/day-placement.js";
import { placedTimes } from "../src/services/design-placement.js";
import { movedSessions } from "../src/services/doc-workouts.js";
import { calmDoc } from "./doc-workout-fixture.js";

const prefs: SchedulingPreferences = { ...DEFAULT_SCHEDULING_PREFERENCES, timezone: "America/Los_Angeles" };
const TODAY = "2026-11-18"; // a Wednesday: the weekday window is 07:00
const AHEAD = "2026-11-19";
const at = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return { today: TODAY, minutes: h! * 60 + m! };
};
const s = (key: string, category: string, minutes: number, currentTime: string, pinned = false): PlaceableSession => ({
  key, category, workoutSeconds: minutes * 60, currentTime, pinned,
});
const minutesOf = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));

describe("today: nothing is placed before now", () => {
  it("RV-D4: a Studio session lengthened into the evening's programme session — the other moves later, never to 07:00", () => {
    // The programme's 30-minute yoga at 18:00; the Studio's strength workout at 17:30, now 50 minutes: they collide.
    const day = [s("programme", "yoga", 30, "18:00"), s("studio", "strength", 50, "17:30")];
    const layout = relaidDay(TODAY, day, prefs, at("09:00"))!;
    expect(layout).not.toBeNull();
    // The heavier (strength) keeps the time it holds; the other queues behind it, later than it was.
    expect(layout.get("studio")).toBe("17:30");
    expect(minutesOf(layout.get("programme")!)).toBeGreaterThan(minutesOf("18:00"));
    for (const t of layout.values()) expect(minutesOf(t)).toBeGreaterThanOrEqual(minutesOf("09:00"));
  });

  it("without the clock (the old pass) the same day put the programme's session at 07:00, before now", () => {
    const day = [s("programme", "yoga", 30, "18:00"), s("studio", "strength", 50, "17:30")];
    expect(relaidDay(TODAY, day, prefs)!.get("studio")).toBe("07:00");
  });

  it("a session whose time has already come stays where it is; the rest are laid out after now", () => {
    const day = [s("morning", "strength", 40, "07:00"), s("noon", "yoga", 30, "12:00"), s("filler", "yoga", 20, "12:10")];
    const layout = relaidDay(TODAY, day, prefs, at("09:00"))!;
    expect(layout.get("morning")).toBe("07:00");
    expect(layout.get("noon")).toBe("12:00");
    expect(minutesOf(layout.get("filler")!)).toBeGreaterThan(minutesOf("12:10"));
  });

  it("sessions whose time has come stay where they are even when they overlap each other: nothing is moved into the past", () => {
    // Two sessions this morning, overlapping, neither done: their times have come, and they are the athlete's to sort out.
    const day = [s("early", "strength", 45, "07:00"), s("filler", "yoga", 20, "07:10"), s("evening", "yoga", 30, "18:00")];
    const layout = relaidDay(TODAY, day, prefs, at("09:00"))!;
    expect(layout).not.toBeNull();
    expect([layout.get("early"), layout.get("filler"), layout.get("evening")]).toEqual(["07:00", "07:10", "18:00"]);
  });

  it("a session that keeps its time never moves earlier, even with the whole morning free", () => {
    const day = [s("a", "strength", 45, "19:00"), s("b", "strength", 45, "19:15")];
    const layout = relaidDay(TODAY, day, prefs, at("09:00"))!;
    expect(layout.get("a")).toBe("19:00");
    expect(minutesOf(layout.get("b")!)).toBeGreaterThan(minutesOf("19:15"));
  });

  it("the athlete's own times (pinned) still stand, and the others clear them, later", () => {
    const day = [s("chosen", "yoga", 30, "18:00", true), s("other", "strength", 40, "17:50")];
    const layout = placeDaySessions(TODAY, day, prefs, at("09:00"));
    expect(layout.get("chosen")).toBe("18:00");
    expect(minutesOf(layout.get("other")!)).toBeGreaterThan(minutesOf("18:00"));
  });

  it("deterministic: the same day and clock give the same layout, whatever order the rows came in", () => {
    const day = [s("programme", "yoga", 30, "18:00"), s("studio", "strength", 50, "17:30"), s("flow", "yoga", 15, "18:10")];
    expect(placeDaySessions(TODAY, [...day].reverse(), prefs, at("09:00"))).toEqual(placeDaySessions(TODAY, day, prefs, at("09:00")));
  });
});

describe("a day ahead is laid out as it always was", () => {
  it("the window time anchors the day; the clock changes nothing", () => {
    const day = [s("programme", "yoga", 30, "18:00"), s("studio", "strength", 50, "17:30")];
    expect(relaidDay(AHEAD, day, prefs, at("09:00"))).toEqual(relaidDay(AHEAD, day, prefs));
    expect(relaidDay(AHEAD, day, prefs, at("09:00"))!.get("studio")).toBe("07:00");
  });
});

describe("the coach designer's card lays today out by the same clock as the write (so the two never disagree)", () => {
  it("a revision that lengthens today's Studio session into the evening: the card's time is later, never the morning window", async () => {
    const base = calmDoc();
    const doc = { ...base, parts: base.parts.map((p) => ({ ...p, items: p.items.map((i) => (i.kind === "exercise" ? { ...i, dose: { ...i.dose, sets: 10, restSec: 90 } } : i)) })) };
    const rows = [
      { id: "studio", date: TODAY, time: "17:30", category: "yoga", source: null, fallback: 1200, block: 1200, state: "scheduled", pinned: 0 },
      { id: "programme", date: TODAY, time: "18:00", category: "strength", source: null, fallback: 2700, block: 2700, state: "scheduled", pinned: 0 },
    ];
    const ops = [{ kind: "doc_workout", by: { runId: "op-1" }, target: { kind: "revise", workoutId: "studio", baseRev: 1 }, date: TODAY, doc }];
    const now = new Date("2026-11-18T17:00:00.000Z"); // 09:00 in Los Angeles
    const placed = await placedTimes("u-1", "proposal-1", ops, rows, { now, today: TODAY, prefs });
    const time = placed.get("op-1")!;
    expect(time >= "17:30", time).toBe(true);
    // And it is the very layout the write's pass makes on the same clock.
    const derived = deriveDoc(doc, EXERCISES);
    const written = relaidDay(TODAY, [s("studio", derived.category, derived.estimatedMinutes, "17:30"), s("programme", "strength", 45, "18:00")], prefs, localClock(now, prefs.timezone))!;
    expect(time).toBe(written.get("studio"));
  });
});

describe("what a document edit's answer says moved (`moved`, the contract's exact shape)", () => {
  it("every other session the pass re-timed, as {workoutId, title, from: {date, time}, to: {date, time}}; an untimed row's time is null", () => {
    const retimed = [
      { workoutId: "edited", date: TODAY, title: "Hips and back", from: "17:30", to: "19:05" },
      { workoutId: "programme", date: TODAY, title: "Lower body", from: "18:00", to: "18:45" },
      { workoutId: "untimed", date: TODAY, title: "A flow", from: "", to: "19:40" },
    ];
    expect(movedSessions(retimed, "edited")).toEqual([
      { workoutId: "programme", title: "Lower body", from: { date: TODAY, time: "18:00" }, to: { date: TODAY, time: "18:45" } },
      { workoutId: "untimed", title: "A flow", from: { date: TODAY, time: null }, to: { date: TODAY, time: "19:40" } },
    ]);
    expect(movedSessions([], "edited")).toEqual([]);
  });
});

describe("the clock on the athlete's own day", () => {
  it("is the account's zone's date and minutes", () => {
    expect(localClock("2026-11-18T17:00:00.000Z", "America/Los_Angeles")).toEqual({ today: "2026-11-18", minutes: 9 * 60 });
    expect(localClock(new Date("2026-11-19T07:30:00.000Z"), "America/Los_Angeles")).toEqual({ today: "2026-11-18", minutes: 23 * 60 + 30 });
  });
});
