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
import { and, eq, sql, type SQL } from "drizzle-orm";
import { auditEvents, nativeDeviceSharing } from "@rg/database";
import { newId } from "@rg/domain";
import { runAtomicallyRowsAt, type Db } from "./db.js";

export const SHARING_SET_KIND = "native_device_sharing_set";

/**
 * ONCE SWITCH A HAS BEEN ON, THE ACCOUNT'S COACH IS READ BY ANTHROPIC ONLY (R1.5; DESIGN-3 §3.12.4; the R1.5 review's F1 and
 * re-check N1). LifeOS's switch A promises the day frame is "Read by Claude (Anthropic)". Every Claude call asks the gateway for
 * Anthropic first (`order`), keeping Claude on Bedrock or Vertex as fallbacks; once the owner has ever turned A on, the frame —
 * and whatever the coach wrote after reading it: a workout's name and notes, a proposal, a receipt, a memory, a read — can be
 * anywhere in the account. So the account, not the text, is pinned: every coach model call for it (a run's every step, its
 * sub-runs and repairs, a replay, the wake, an activity's read, the Studio's plan calls, the weekly review) goes
 * `only: ["anthropic"]` (gateway-route.ts) and fails rather than falls back. Turning A off never unpins: what was derived stays.
 *
 * Pinned = the switch's audit rows say A was ever on, OR a phone's switch A is on now. One rule, two sources:
 *  - The audit rows (`setSharing` writes one in the switch's batch) are the account's (`audit_events`, account-tables.ts):
 *    exported and restored with it, removed by delete-all — so "ever on" travels with the data that can hold frame-derived
 *    text. A restore's wipe and "Start fresh" spare them (`SWITCH_AUDIT_SPARED`): the switch itself survives both (a sign-in's
 *    bookkeeping), so its history does too, and a file from before A can't make the account read "never on".
 *  - The live switch (`native_device_sharing`, indexed by `user_id`) is the backstop: whatever happened to the audit rows, a
 *    frame can go only while a phone's switch is on (`frameRefusal`), and then the account is pinned.
 * Both are read inside the budget statement every coach model call already makes (llm.ts `weekSpentMicros`): no statement
 * more. The audit scan stops at the first row that says on; an account that never turned A on reads its way through the table
 * (no `user_id` index yet) and finds no phone on, which is what keeps it routed as before.
 */
export const sharesDaySql = (userId: string): SQL =>
  sql`(exists (select 1 from audit_events a where a.user_id = ${userId} and a.kind = ${SHARING_SET_KIND} and json_valid(a.detail) and json_extract(a.detail, '$.toTraining') = 1) or exists (select 1 from native_device_sharing s where s.user_id = ${userId} and s.to_training = 1))`;

/**
 * What a restore's wipe and "Start fresh" leave of the account (account-tables.ts `wipeAccountData` `spare`): switch A's own
 * audit rows, which the switch (never wiped) keeps beside it, so the pin's "ever on" survives a file from before A (re-check N1).
 * Delete-all spares nothing: it removes the switch and its rows with everything else.
 */
export const SWITCH_AUDIT_SPARED: Readonly<Record<string, SQL>> = { audit_events: eq(auditEvents.kind, SHARING_SET_KIND) };

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

/** The phone's choice, stored with its words' version, and audited in the same batch: answered as stored (review A NIT 6). */
export async function setSharing(db: Db, userId: string, deviceId: string, choice: { toTraining: boolean; disclosureVersion: string }, now: string): Promise<SharingState> {
  const [row] = await runAtomicallyRowsAt<typeof nativeDeviceSharing.$inferSelect>(
    db,
    [
      db
        .insert(nativeDeviceSharing)
        .values({ deviceId, userId, toTraining: choice.toTraining, disclosureVersion: choice.disclosureVersion, setAt: now })
        .onConflictDoUpdate({ target: nativeDeviceSharing.deviceId, set: { toTraining: choice.toTraining, disclosureVersion: choice.disclosureVersion, setAt: now } })
        .returning(),
      db.insert(auditEvents).values({ id: newId(), userId, kind: SHARING_SET_KIND, detail: { deviceId, toTraining: choice.toTraining, disclosureVersion: choice.disclosureVersion }, createdAt: now }),
    ],
    0,
  );
  if (!row) throw new Error("sharing_not_stored");
  return { toTraining: Boolean(row.toTraining), disclosureVersion: row.disclosureVersion, setAt: row.setAt };
}

/**
 * Why a frame can't go with this run, or null when it can: no device (the laptop has no LifeOS day of its own), the phone's
 * switch off, or a frame given under words other than the ones the owner accepted.
 */
export async function frameRefusal(db: Db, userId: string, deviceId: string | undefined, consent: string): Promise<null | { error: "sharing_off"; why: string }> {
  if (!deviceId) return { error: "sharing_off", why: "Only a paired phone can share your day, and only once you turn that on there." };
  return refusalUnder(await sharingOf(db, userId, deviceId), consent, "Sharing your day with your training coach is off on this phone.");
}

/** Why a told note can't go (review A MINOR-3), or null when it can: held to switch A and its words' version, as a frame is. */
export async function toldRefusal(db: Db, userId: string, deviceId: string, consent: string): Promise<null | { error: "sharing_off"; why: string }> {
  return refusalUnder(await sharingOf(db, userId, deviceId), consent, "Telling your training coach from LifeOS is off on this phone.");
}

function refusalUnder(s: SharingState, consent: string, off: string): null | { error: "sharing_off"; why: string } {
  if (!s.toTraining) return { error: "sharing_off", why: off };
  if (s.disclosureVersion !== consent) return { error: "sharing_off", why: "What this phone shares has changed since you turned it on: look at it again on the phone." };
  return null;
}
