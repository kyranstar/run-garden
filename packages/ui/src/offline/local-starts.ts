/**
 * STARTS MADE OFFLINE (R11). A quick start, or a template whose document is on the device, started with no network: the
 * builder makes its build on the device (`player/local-build.ts`) and the player plays it under a provisional id,
 * `local:<clientId>`. This store (`starts`) keeps what the server needs to record it — the document, the day and time it
 * was played, the device's key (`clientId`) — until the outbox has sent its session: first the workout, recorded once
 * (`POST /api/workouts` with `playedOffline`; the key makes a retry name the same row), then the session onto it. Its
 * before-reading travels in the session's own checks (`pre`, at its day and time): no check-in is sent on its own.
 *
 * Two starts of one kind (a quick start's kind, or one template) on one day are one session: the one still to finish
 * is offered again (Continue) rather than a second.
 */
import { ApiError, type CreateDocWorkoutRequest } from "@rg/api-client";
import type { PerformedSessionWire, WorkoutDoc } from "@rg/domain";
import type { OfflineDb } from "./idb.js";

export const LOCAL_PREFIX = "local:";
/** A session played under the device's own provisional id: its workout is not on the server yet. */
export const isLocalId = (id: string | null | undefined): id is string => !!id && id.startsWith(LOCAL_PREFIX);
export const localIdOf = (clientId: string): string => `${LOCAL_PREFIX}${clientId}`;

export interface LocalStart {
  localId: string;
  /** The device's key for the workout's create: the same on every retry. */
  clientId: string;
  /** The account it was started for: recorded for it alone (ruling 2b-R6). */
  userId: string;
  /** What it was started from — `quick_start:<kind>` or `template:<id>`: two of one kind on one day are one session. */
  kind: string;
  title: string;
  doc: WorkoutDoc;
  /** The day it was played (the account's today at Start) and the time: the workout's, whenever it is recorded. */
  date: string;
  time: string;
  /** Epoch ms. */
  createdAt: number;
  /** The workout the server recorded for it, once it has. */
  workoutId?: string;
}

export function rememberLocalStart(db: OfflineDb, start: LocalStart): Promise<void> {
  return db.put("starts", start.localId, start);
}

export function loadLocalStart(db: OfflineDb, localId: string): Promise<LocalStart | undefined> {
  return db.get<LocalStart>("starts", localId);
}

export function forgetLocalStart(db: OfflineDb, localId: string): Promise<void> {
  return db.delete("starts", localId);
}

/** The account's starts made offline, oldest first. */
export async function localStarts(db: OfflineDb, userId: string): Promise<LocalStart[]> {
  return (await db.all<LocalStart>("starts")).filter((s) => s.userId === userId).sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * The start of this kind made offline on `date` whose session is still to finish — not saved yet — for Continue: two
 * starts of one kind on one day are one session. One saved (waiting in the outbox) is done; another may begin.
 */
export async function unfinishedLocalStart(db: OfflineDb, userId: string, kind: string, date: string): Promise<LocalStart | undefined> {
  // The outbox's store read as it is (the outbox reads this module: no import back).
  const saved = new Set((await db.all<{ payload: { workoutId: string | null } }>("outbox")).map((e) => e.payload.workoutId));
  return (await localStarts(db, userId)).find((s) => s.kind === kind && s.date === date && !saved.has(s.localId));
}

/** The kind a document is started as: a quick start's, or a template's; null for anything else (never started offline). */
export function startKindOf(doc: WorkoutDoc): string | null {
  if (doc.basedOn?.kind === "template") return `template:${doc.basedOn.id}`;
  if (doc.source.kind === "studio" && doc.source.ref?.startsWith("quick_start:")) return doc.source.ref;
  return null;
}

/** A start made offline whose record is gone (its account's data deleted here): its session cannot be recorded. */
export class LocalStartMissingError extends Error {
  constructor(readonly localId: string) {
    super(`local_start_missing:${localId}`);
  }
}

/** What recording a start needs of the server: the create. */
export interface LocalStartApi {
  createWorkout(body: CreateDocWorkoutRequest): Promise<{ workout: { id: string } }>;
}

/**
 * The server's workout for a start made offline: recorded once (`playedOffline`, the device's key) and kept here. When
 * today already holds the same quick start or template still to finish (409 `started_today`), the session goes onto
 * that one. Any other refusal is thrown as it came (the outbox flags the session's entry `failed`: Retry, Discard).
 */
export async function recordedWorkoutId(db: OfflineDb, api: LocalStartApi, localId: string): Promise<string> {
  const start = await loadLocalStart(db, localId);
  if (!start) throw new LocalStartMissingError(localId);
  if (start.workoutId) return start.workoutId;
  let id: string;
  try {
    const made = await api.createWorkout({ date: start.date, time: start.time, doc: start.doc, clientId: start.clientId, startNow: true, playedOffline: true });
    id = made.workout.id;
  } catch (e) {
    const body = e instanceof ApiError ? ((e.body ?? null) as { error?: string; workout?: { id?: string } } | null) : null;
    const held = e instanceof ApiError && e.status === 409 && body?.error === "started_today" ? body.workout?.id : undefined;
    if (!held) throw e;
    id = held;
  }
  await db.update<LocalStart>("starts", localId, (current) => (current ? { ...current, workoutId: id } : current));
  return id;
}

/** A session played under a provisional id, as the server takes it: onto the workout recorded for it, with no build. */
export async function onTheServer(db: OfflineDb, api: LocalStartApi, payload: PerformedSessionWire): Promise<PerformedSessionWire> {
  if (!isLocalId(payload.workoutId)) return payload;
  const workoutId = await recordedWorkoutId(db, api, payload.workoutId);
  return { ...payload, workoutId, buildId: null };
}
