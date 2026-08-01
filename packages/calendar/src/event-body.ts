import { DateTime } from "luxon";
import {
  CALENDAR_EVENT_PROPERTY_NS,
  PRODUCT_NAME,
  fingerprint,
  type WorkoutCategory,
} from "@rg/domain";
import type { ReminderPlan, ScheduledBlock } from "@rg/scheduling";

/**
 * Managed Google Calendar event construction. One padded block per workout,
 * private extended properties for stable association, and a user-notes section
 * that survives every rewrite of the structural description.
 */

export interface EventWorkoutInfo {
  workoutId: string;
  title: string;
  category: WorkoutCategory;
  workoutSeconds: number;
  calendarSeconds: number;
  stageSummary?: string;
  corosDate: string; // lastVerifiedCorosDate
  effectiveDate: string;
  effectiveTime: string;
  corosStatusLabel: string; // "Synced" | "Waiting for Mac" | ...
  sleepReminderText?: string;
}

export interface BuildEventInput {
  workout: EventWorkoutInfo;
  block: ScheduledBlock;
  reminders: ReminderPlan;
  timezone: string;
  /** e.g. "https://rungarden.example.com" — deep link base. */
  appUrl: string;
  userNotes?: string;
}

const CATEGORY_LABEL: Partial<Record<WorkoutCategory, string>> = {
  recovery: "Run",
  easy: "Run",
  long: "Run",
  quality: "Run",
  race: "Race",
  cross_training: "Cross-train",
  strength: "Strength",
  unknown: "Run",
};

export function buildEventTitle(w: EventWorkoutInfo): string {
  const prefix = CATEGORY_LABEL[w.category] ?? "Run";
  return `${prefix} · ${w.title}`;
}

export const NOTES_MARKER = "――― Your notes (kept when this event updates) ―――";

function humanDate(date: string): string {
  return DateTime.fromISO(date).toFormat("cccc, LLLL d");
}

function humanTime(date: string, time: string): string {
  const dt = DateTime.fromISO(`${date}T${time}`);
  return dt.toFormat(dt.minute === 0 ? "h a" : "h:mm a");
}

export function buildEventDescription(w: EventWorkoutInfo, appUrl: string, userNotes?: string): string {
  // Whole minutes, matching the product copy ("Workout: 54 min · Calendar: 79 min").
  const min = (seconds: number) => `${Math.round(seconds / 60)} min`;
  const lines: string[] = [w.title, ""];
  lines.push(`Workout estimate: ${min(w.workoutSeconds)}`);
  lines.push(`Calendar block: ${min(w.calendarSeconds)}`);
  if (w.stageSummary) {
    lines.push("", "Structure");
    for (const part of w.stageSummary.split(" · ")) lines.push(`• ${part}`);
  }
  lines.push("");
  lines.push(`COROS date: ${humanDate(w.corosDate)}`);
  lines.push(
    `Scheduled: ${humanDate(w.effectiveDate)} at ${humanTime(w.effectiveDate, w.effectiveTime)}`,
  );
  lines.push(`COROS status: ${w.corosStatusLabel}`);
  if (w.sleepReminderText) lines.push("", w.sleepReminderText);
  if (userNotes && userNotes.trim().length > 0) {
    lines.push("", NOTES_MARKER, userNotes.trim());
  }
  lines.push("", `Managed by ${PRODUCT_NAME}.`);
  lines.push(`Open workout: ${appUrl}/plan?workout=${encodeURIComponent(w.workoutId)}`);
  return lines.join("\n");
}

/** Pull the user's notes back out of a (possibly user-edited) description. */
export function extractUserNotes(description: string | undefined): string | undefined {
  if (!description) return undefined;
  const idx = description.indexOf(NOTES_MARKER);
  if (idx === -1) return undefined;
  const after = description.slice(idx + NOTES_MARKER.length);
  // Notes end where our managed footer begins (if the user left it in place).
  const footerIdx = after.indexOf(`Managed by ${PRODUCT_NAME}.`);
  const notes = (footerIdx === -1 ? after : after.slice(0, footerIdx)).trim();
  return notes.length > 0 ? notes : undefined;
}

export interface GoogleEventResource {
  summary: string;
  description: string;
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
  reminders: { useDefault: false; overrides: Array<{ method: "popup"; minutes: number }> };
  extendedProperties: { private: Record<string, string> };
  transparency?: "opaque";
}

/** Fingerprint of everything we would write — used to detect user edits and avoid update loops. */
export function eventContentFingerprint(resource: GoogleEventResource): string {
  return fingerprint({
    summary: resource.summary,
    description: resource.description,
    start: resource.start.dateTime,
    end: resource.end.dateTime,
    reminders: resource.reminders.overrides,
  });
}

export function buildEventResource(input: BuildEventInput): GoogleEventResource {
  const { workout: w, block, reminders, timezone, appUrl, userNotes } = input;
  const resource: GoogleEventResource = {
    summary: buildEventTitle(w),
    description: buildEventDescription(w, appUrl, userNotes),
    start: { dateTime: block.startInstant, timeZone: timezone },
    end: { dateTime: block.endInstant, timeZone: timezone },
    reminders: {
      useDefault: false,
      overrides: reminders.overrideMinutes.map((minutes) => ({ method: "popup" as const, minutes })),
    },
    extendedProperties: {
      private: {
        [`${CALENDAR_EVENT_PROPERTY_NS}WorkoutId`]: w.workoutId,
        [`${CALENDAR_EVENT_PROPERTY_NS}App`]: PRODUCT_NAME,
      },
    },
    transparency: "opaque",
  };
  resource.extendedProperties.private[`${CALENDAR_EVENT_PROPERTY_NS}Fingerprint`] =
    eventContentFingerprint(resource);
  return resource;
}

export function workoutIdFromEvent(extendedProperties?: {
  private?: Record<string, string>;
}): string | undefined {
  return extendedProperties?.private?.[`${CALENDAR_EVENT_PROPERTY_NS}WorkoutId`];
}
