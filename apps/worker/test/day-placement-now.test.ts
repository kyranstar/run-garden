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
import { localClock, placeDaySessions, relaidDay, type PlaceableSession } from "../src/services/day-placement.js";

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

describe("the clock on the athlete's own day", () => {
  it("is the account's zone's date and minutes", () => {
    expect(localClock("2026-11-18T17:00:00.000Z", "America/Los_Angeles")).toEqual({ today: "2026-11-18", minutes: 9 * 60 });
    expect(localClock(new Date("2026-11-19T07:30:00.000Z"), "America/Los_Angeles")).toEqual({ today: "2026-11-18", minutes: 23 * 60 + 30 });
  });
});
