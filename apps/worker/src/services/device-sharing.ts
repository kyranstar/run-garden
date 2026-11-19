/**
 * SWITCH A, ON THE SERVER (R1; the LifeOS migration's DESIGN-3 §3.12, the lead's v0.20 Q1 ruling; CALLS C1): whether a
 * paired phone may send the owner's day frame — free times, energy, how full the day is — with a training ask. Off for every
 * phone until the owner turns it on, on the phone, after reading what it would share (the phone's sharing screen); the v5
 * grant never turns it on, and a step-down below v5 turns it off (native-devices.ts `reduceScope`).
 *
 *  - `native_device_sharing`, one row per phone (migration 0040): no row is off. A sign-in's bookkeeping: never exported,
 *    restored or copied — a restore must never turn a consent back on — and delete-all removes it.
 *  - `setSharing`: the phone's own `PUT /api/native/sharing`, with the version of the words the owner accepted, and an audit
 *    row (`native_device_sharing_set`) in the same batch.
 *  - `frameRefusal`: what a run create with a frame is checked by — the device's row on, and the frame's `consent` the very
 *    version stored. Anything else is refused (`sharing_off`): a frame is never ignored, so the phone never says it shared
 *    what didn't go, and nothing starts without what the owner was told it carries.
 */
import { and, eq } from "drizzle-orm";
import { auditEvents, nativeDeviceSharing } from "@rg/database";
import { newId } from "@rg/domain";
import { runAtomically, type Db } from "./db.js";

export const SHARING_SET_KIND = "native_device_sharing_set";

export interface SharingState {
  /** Switch A: the owner's day frame may go with a training ask. */
  toTraining: boolean;
  /** The words the owner last chose under (null: never chosen). */
  disclosureVersion: string | null;
  setAt: string | null;
}

export async function sharingOf(db: Db, userId: string, deviceId: string): Promise<SharingState> {
  const [row] = await db
    .select()
    .from(nativeDeviceSharing)
    .where(and(eq(nativeDeviceSharing.deviceId, deviceId), eq(nativeDeviceSharing.userId, userId)))
    .limit(1);
  return row ? { toTraining: Boolean(row.toTraining), disclosureVersion: row.disclosureVersion, setAt: row.setAt } : { toTraining: false, disclosureVersion: null, setAt: null };
}

/** The phone's choice, stored with its words' version, and audited in the same batch. */
export async function setSharing(db: Db, userId: string, deviceId: string, choice: { toTraining: boolean; disclosureVersion: string }, now: string): Promise<SharingState> {
  await runAtomically(db, [
    db
      .insert(nativeDeviceSharing)
      .values({ deviceId, userId, toTraining: choice.toTraining, disclosureVersion: choice.disclosureVersion, setAt: now })
      .onConflictDoUpdate({ target: nativeDeviceSharing.deviceId, set: { toTraining: choice.toTraining, disclosureVersion: choice.disclosureVersion, setAt: now } }),
    db.insert(auditEvents).values({ id: newId(), userId, kind: SHARING_SET_KIND, detail: { deviceId, toTraining: choice.toTraining, disclosureVersion: choice.disclosureVersion }, createdAt: now }),
  ]);
  return { toTraining: choice.toTraining, disclosureVersion: choice.disclosureVersion, setAt: now };
}

/**
 * Why a frame can't go with this run, or null when it can: no device (the laptop has no LifeOS day of its own), the phone's
 * switch off, or a frame given under words other than the ones the owner accepted.
 */
export async function frameRefusal(db: Db, userId: string, deviceId: string | undefined, consent: string): Promise<null | { error: "sharing_off"; why: string }> {
  if (!deviceId) return { error: "sharing_off", why: "Only a paired phone can share your day, and only once you turn that on there." };
  const s = await sharingOf(db, userId, deviceId);
  if (!s.toTraining) return { error: "sharing_off", why: "Sharing your day with your training coach is off on this phone." };
  if (s.disclosureVersion !== consent) return { error: "sharing_off", why: "What this phone shares has changed since you turned it on: look at it again on the phone." };
  return null;
}
