import { describe, expect, it } from "vitest";
import { DEFAULT_SCHEDULING_PREFERENCES } from "@rg/domain";
import { computeBlock, planReminders } from "@rg/scheduling";
import {
  buildEventDescription,
  buildEventResource,
  buildEventTitle,
  eventContentFingerprint,
  extractUserNotes,
  NOTES_MARKER,
  workoutIdFromEvent,
  type EventWorkoutInfo,
} from "../src/event-body.js";
import { reconcileCalendar, type ActualEvent } from "../src/reconcile.js";

const prefs = { ...DEFAULT_SCHEDULING_PREFERENCES, timezone: "America/Los_Angeles" };
const APP_URL = "https://rg.example.com";

const workoutInfo = (over: Partial<EventWorkoutInfo> = {}): EventWorkoutInfo => ({
  workoutId: "w-11",
  title: "Threshold 5x5",
  category: "quality",
  workoutSeconds: 3240,
  calendarSeconds: 3240 + 1500,
  stageSummary: "15 min warmup · 5 × 5 min / 2 min recovery · 10 min cooldown",
  corosDate: "2026-08-04",
  effectiveDate: "2026-08-04",
  effectiveTime: "07:00",
  corosStatusLabel: "Synced",
  ...over,
});

function makeResource(over: Partial<EventWorkoutInfo> = {}, userNotes?: string) {
  const w = workoutInfo(over);
  const block = computeBlock(w.effectiveDate, w.effectiveTime, w.workoutSeconds, prefs);
  const reminders = planReminders(w.effectiveDate, w.effectiveTime, block.startInstant, prefs);
  return buildEventResource({ workout: w, block, reminders, timezone: prefs.timezone, appUrl: APP_URL, userNotes });
}

describe("event body", () => {
  it("builds the title, padded block, and reminder overrides", () => {
    const r = makeResource();
    expect(r.summary).toBe("Run · Threshold 5x5");
    // 06:50 PDT start (10 min buffer), 3240s + 15 min after → ends 08:09 PDT.
    expect(r.start.dateTime).toBe("2026-08-04T13:50:00Z");
    expect(r.end.dateTime).toBe("2026-08-04T15:09:00Z");
    expect(r.reminders.useDefault).toBe(false);
    const minutes = r.reminders.overrides.map((o) => o.minutes);
    expect(minutes).toContain(30); // pre-run
    expect(minutes).toContain(620); // previous evening 20:30
  });

  it("writes the spec description fields", () => {
    const d = buildEventDescription(workoutInfo(), APP_URL);
    expect(d).toContain("Workout estimate: 54 min");
    expect(d).toContain("Calendar block: 79 min");
    expect(d).toContain("• 15 min warmup");
    expect(d).toContain("COROS date: Tuesday, August 4");
    expect(d).toContain("Scheduled: Tuesday, August 4 at 7 AM");
    expect(d).toContain("COROS status: Synced");
    expect(d).toContain("Managed by Run Garden.");
    expect(d).toContain("Open workout: https://rg.example.com/plan?workout=w-11");
  });

  it("round-trips user notes through the marker section", () => {
    const d = buildEventDescription(workoutInfo(), APP_URL, "Bring gels.\nMeet Sam at the track.");
    expect(d).toContain(NOTES_MARKER);
    expect(extractUserNotes(d)).toBe("Bring gels.\nMeet Sam at the track.");
    expect(extractUserNotes(buildEventDescription(workoutInfo(), APP_URL))).toBeUndefined();
  });

  it("stamps stable private extended properties", () => {
    const r = makeResource();
    expect(workoutIdFromEvent(r.extendedProperties)).toBe("w-11");
    expect(r.extendedProperties.private["rgFingerprint"]).toBe(eventContentFingerprint(r));
  });
});

describe("reconciliation", () => {
  const desired = () => ({ workoutId: "w-11", resource: makeResource() });

  const actualFromResource = (r = makeResource(), eventId = "ev-1"): ActualEvent => ({
    eventId,
    status: "confirmed",
    startDateTime: r.start.dateTime,
    endDateTime: r.end.dateTime,
    summary: r.summary,
    description: r.description,
    extendedProperties: r.extendedProperties,
  });

  it("creates events for new workouts", () => {
    const ops = reconcileCalendar({ desired: [desired()], actual: [], links: [], suppressions: [] });
    expect(ops).toEqual([expect.objectContaining({ op: "create", workoutId: "w-11" })]);
  });

  it("is idempotent when calendar matches desired state", () => {
    const d = desired();
    const fp = eventContentFingerprint(d.resource);
    const ops = reconcileCalendar({
      desired: [d],
      actual: [actualFromResource(d.resource)],
      links: [{ workoutId: "w-11", eventId: "ev-1", lastWrittenFingerprint: fp }],
      suppressions: [],
    });
    expect(ops).toHaveLength(0);
  });

  it("updates when our intended content changed", () => {
    const before = makeResource();
    const after = { workoutId: "w-11", resource: makeResource({ effectiveTime: "19:00" }) };
    const ops = reconcileCalendar({
      desired: [after],
      actual: [actualFromResource(before)],
      links: [
        { workoutId: "w-11", eventId: "ev-1", lastWrittenFingerprint: eventContentFingerprint(before) },
      ],
      suppressions: [],
    });
    expect(ops).toEqual([expect.objectContaining({ op: "update", eventId: "ev-1" })]);
  });

  it("adopts a manual user move instead of overwriting it", () => {
    const d = desired();
    const fp = eventContentFingerprint(d.resource);
    const moved = actualFromResource(d.resource);
    moved.startDateTime = "2026-08-05T13:50:00Z";
    moved.endDateTime = "2026-08-05T15:09:00Z";
    const ops = reconcileCalendar({
      desired: [d],
      actual: [moved],
      links: [{ workoutId: "w-11", eventId: "ev-1", lastWrittenFingerprint: fp }],
      suppressions: [],
    });
    expect(ops).toEqual([
      expect.objectContaining({
        op: "accept_user_move",
        newStart: "2026-08-05T13:50:00Z",
      }),
    ]);
  });

  it("treats cancelled or vanished events as user deletions and never recreates suppressed ones", () => {
    const d = desired();
    const cancelled = { ...actualFromResource(d.resource), status: "cancelled" as const };
    const ops = reconcileCalendar({
      desired: [d],
      actual: [cancelled],
      links: [{ workoutId: "w-11", eventId: "ev-1", lastWrittenFingerprint: eventContentFingerprint(d.resource) }],
      suppressions: [],
    });
    expect(ops).toEqual([expect.objectContaining({ op: "mark_user_deleted" })]);

    const opsSuppressed = reconcileCalendar({
      desired: [d],
      actual: [],
      links: [],
      suppressions: [{ workoutId: "w-11" }],
    });
    expect(opsSuppressed).toHaveLength(0);
  });

  it("preserves user notes when the description was edited", () => {
    const d = desired();
    const fp = eventContentFingerprint(d.resource);
    const edited = actualFromResource(d.resource);
    edited.description = `${d.resource.description}\n${NOTES_MARKER}\nRemember new shoes.`;
    const ops = reconcileCalendar({
      desired: [d],
      actual: [edited],
      links: [{ workoutId: "w-11", eventId: "ev-1", lastWrittenFingerprint: fp }],
      suppressions: [],
    });
    expect(ops).toEqual([
      expect.objectContaining({ op: "preserve_notes_update", userNotes: "Remember new shoes." }),
    ]);
  });

  it("deletes managed events for workouts removed upstream", () => {
    const ops = reconcileCalendar({
      desired: [],
      actual: [],
      links: [{ workoutId: "w-99", eventId: "ev-9" }],
      suppressions: [],
      removedWorkoutIds: ["w-99"],
    });
    expect(ops).toEqual([expect.objectContaining({ op: "delete", eventId: "ev-9" })]);
  });
});
