import { CALENDAR_EVENT_PROPERTY_NS } from "@rg/domain";
import { extractUserNotes, eventContentFingerprint, type GoogleEventResource, workoutIdFromEvent } from "./event-body.js";

/**
 * Pure reconciliation between Run Garden's desired managed events and the
 * actual state of the Google Calendar (from incremental sync). The worker
 * executes the returned operations; this module only decides them.
 */

export interface DesiredEvent {
  workoutId: string;
  resource: GoogleEventResource;
}

export interface ActualEvent {
  eventId: string;
  status: "confirmed" | "tentative" | "cancelled";
  startDateTime?: string;
  endDateTime?: string;
  summary?: string;
  description?: string;
  extendedProperties?: { private?: Record<string, string> };
  updated?: string;
}

export interface EventLink {
  workoutId: string;
  eventId: string;
  lastWrittenFingerprint?: string;
  userNotes?: string;
}

export interface Suppression {
  workoutId: string;
}

export type ReconcileOp =
  | { op: "create"; workoutId: string; resource: GoogleEventResource }
  | { op: "update"; workoutId: string; eventId: string; resource: GoogleEventResource }
  | { op: "delete"; workoutId: string; eventId: string }
  | {
      /** The user moved the managed event by hand — adopt their change. */
      op: "accept_user_move";
      workoutId: string;
      eventId: string;
      newStart: string;
      newEnd: string;
    }
  | {
      /** The user deleted the managed event — do not recreate; offer restore. */
      op: "mark_user_deleted";
      workoutId: string;
      eventId: string;
    }
  | {
      /** The user edited the description — preserve their notes, restore structure. */
      op: "preserve_notes_update";
      workoutId: string;
      eventId: string;
      userNotes: string;
      resource: GoogleEventResource;
    };

export interface ReconcileInput {
  desired: DesiredEvent[];
  actual: ActualEvent[];
  links: EventLink[];
  suppressions: Suppression[];
  /** Workouts that no longer exist upstream → their events should be removed. */
  removedWorkoutIds?: string[];
}

function sameInstant(a?: string, b?: string): boolean {
  if (!a || !b) return a === b;
  return new Date(a).getTime() === new Date(b).getTime();
}

export function reconcileCalendar(input: ReconcileInput): ReconcileOp[] {
  const ops: ReconcileOp[] = [];
  const suppressed = new Set(input.suppressions.map((s) => s.workoutId));
  const removed = new Set(input.removedWorkoutIds ?? []);
  const linkByWorkout = new Map(input.links.map((l) => [l.workoutId, l]));
  const actualById = new Map(input.actual.map((a) => [a.eventId, a]));
  const actualByWorkout = new Map<string, ActualEvent>();
  for (const a of input.actual) {
    const wid = workoutIdFromEvent(a.extendedProperties);
    if (wid) actualByWorkout.set(wid, a);
  }

  for (const desired of input.desired) {
    const { workoutId } = desired;
    if (suppressed.has(workoutId)) continue; // user deleted it; never recreate

    const link = linkByWorkout.get(workoutId);
    const actual = link ? (actualById.get(link.eventId) ?? actualByWorkout.get(workoutId)) : actualByWorkout.get(workoutId);

    if (!link && !actual) {
      ops.push({ op: "create", workoutId, resource: desired.resource });
      continue;
    }

    if (actual && actual.status === "cancelled") {
      ops.push({ op: "mark_user_deleted", workoutId, eventId: actual.eventId });
      continue;
    }

    if (!actual) {
      // Link exists but the event vanished from the feed without a cancel —
      // treat as deleted by the user (confirmed by absence on a full read).
      if (link) ops.push({ op: "mark_user_deleted", workoutId, eventId: link.eventId });
      continue;
    }

    const desiredFp = eventContentFingerprint(desired.resource);
    const lastWritten = link?.lastWrittenFingerprint;
    const userMovedTime =
      !sameInstant(actual.startDateTime, desired.resource.start.dateTime) ||
      !sameInstant(actual.endDateTime, desired.resource.end.dateTime);
    const weChangedContent = lastWritten !== desiredFp;

    // Did the user edit the event since we last wrote it? Compare the actual
    // event against what we last wrote (start/end drive the decision; the
    // stored fingerprint covers description/title edits).
    const actualFp =
      actual.extendedProperties?.private?.[`${CALENDAR_EVENT_PROPERTY_NS}Fingerprint`];
    const userEditedDescription =
      actual.description !== undefined &&
      lastWritten !== undefined &&
      actualFp === lastWritten && // props unchanged (Google preserves them on user edits)
      actual.description !== undefined &&
      extractUserNotes(actual.description) !== link?.userNotes;

    if (userMovedTime && lastWritten !== undefined && !weChangedContent) {
      // We didn't intend a change; the user moved it. Adopt their placement.
      ops.push({
        op: "accept_user_move",
        workoutId,
        eventId: actual.eventId,
        newStart: actual.startDateTime!,
        newEnd: actual.endDateTime!,
      });
      continue;
    }

    if (userEditedDescription) {
      const notes = extractUserNotes(actual.description);
      ops.push({
        op: "preserve_notes_update",
        workoutId,
        eventId: actual.eventId,
        userNotes: notes ?? "",
        resource: desired.resource,
      });
      continue;
    }

    if (weChangedContent || userMovedTime) {
      // Our intended state differs from what the calendar shows → write ours.
      ops.push({ op: "update", workoutId, eventId: actual.eventId, resource: desired.resource });
    }
    // else: fingerprints match and times match → nothing to do (idempotent).
  }

  // Events whose workouts disappeared upstream (confirmed removals).
  for (const workoutId of removed) {
    const link = linkByWorkout.get(workoutId);
    if (link) ops.push({ op: "delete", workoutId, eventId: link.eventId });
  }

  return ops;
}
