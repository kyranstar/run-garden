/**
 * Settings → Data & account → Devices (native device sign-in, the LifeOS migration's SLICE-CONTRACT revision 2 §10.1, §4):
 * the laptop pairs a phone and can stop it.
 *
 *  - Pair a phone: the account's one code (a new one burns the old), shown once, with its expiry and what a phone paired
 *    with it can do; Done puts it away and nothing reads it back. While it is out, the list is looked at again every few
 *    seconds for the phone that redeems it.
 *  - A pending phone: its label and the check number it shows too, with Confirm (which sends that number) and Revoke.
 *  - An active phone: its label, last use and expiry (and a word when it expires within 7 days), with Revoke.
 *  - Each phone says what it can do, in plain words (its scope; kit v0.15). An active phone with a next scope has one
 *    button for it, which first says in one line what that adds; Allow grants it in place — the same phone, token and
 *    expiry — and Not now puts the question away. Only while device sign-in is on.
 *  - The step-down (review r-m4): an active phone above the bottom has one button to stop what its last grant allowed,
 *    which first says in one line what stops and that it stays paired; Stop steps it down in place. Like Revoke, it
 *    answers whatever the switch: narrowing a phone never widens one.
 *  - Revoke all: every phone at once.
 *
 * The card shows nothing while the switch is off and no phone is paired, or when the list can't be read. With the switch
 * off and phones still paired, they show and can be revoked, and Pair is not offered.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, type NativeDeviceDto } from "@rg/api-client";
import { daysBetween } from "@rg/domain";
import { Banner, Card, dateInZone, relativeTime } from "../../components.js";

export const NATIVE_DEVICES_QUERY = ["native-devices"] as const;

/** Looked at this often while a code is out: the phone that redeems it shows up as pending. */
const LOOK_AGAIN_MS = 3_000;

/** The phone warns this many days ahead (the worker's NATIVE_DEVICE_WARN_DAYS); the laptop's hint shows from the same day. */
const WARN_DAYS = 7;

const clockOf = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
/** "7K2QXM9D" → "7K2Q-XM9D": two groups of four, as the phone's field takes it (hyphens are ignored). */
const grouped = (code: string) => `${code.slice(0, 4)}-${code.slice(4)}`;

/**
 * What a phone of each scope can do (the worker's auth/device-scope.ts), as the end of "Can …". A scope this laptop has
 * no words for says nothing, rather than guess.
 */
export const CAN: Readonly<Record<string, string>> = {
  "training-slice-v1": "play and save workouts",
  "training-v2": "play, save and move workouts",
  "training-v3": "play, save, move and fit workouts, and record your feedback",
};

/**
 * The grant to each next scope: its button, and the one line that says what it adds — and that it can be stopped here —
 * before anything is sent.
 */
export const GRANTS: Readonly<Record<string, { button: string; line: string }>> = {
  "training-v2": { button: "Allow moving workouts", line: "It will also be able to move, skip and put back workouts on your plan. You can stop it here any time." },
  "training-v3": {
    button: "Allow fitting and feedback",
    line: "It will also be able to fit a workout to the day (its time, place and moves) and record Not for me and harder-move switches. You can stop it here any time.",
  },
};

/** The step-down from each scope (review r-m4): its button, and the one line that says what stops before anything is sent. */
export const STEP_DOWNS: Readonly<Record<string, { button: string; line: string }>> = {
  "training-v2": { button: "Stop moving workouts", line: "It will no longer move, skip or put back workouts on your plan. It stays paired." },
  "training-v3": {
    button: "Stop fitting and feedback",
    line: "It will no longer fit workouts to the day or record Not for me and harder-move switches. It stays paired.",
  },
};

/**
 * Calendar days until an active phone's expiry, on the owner's clock (`timeZone`, the account's; the laptop's own when
 * unknown): 0 on its last day, however few hours are left; 1 the day before, however few (review F8).
 */
export function daysLeft(iso: string, timeZone: string | null | undefined, now = Date.now()): number {
  return daysBetween(dateInZone(new Date(now), timeZone), dateInZone(new Date(iso), timeZone));
}

/** "Expires today", "Expires in 1 day", "Expires in 27 days". */
export function expiresIn(days: number): string {
  if (days < 1) return "Expires today";
  return days === 1 ? "Expires in 1 day" : `Expires in ${days} days`;
}

function confirmRefusal(e: unknown): string {
  const body = e instanceof ApiError ? (e.body as { error?: string; revoked?: boolean } | null) : null;
  if (body?.error === "check_mismatch" && body.revoked) return "The numbers didn't match too many times, so that phone was turned away. Pair it again.";
  if (body?.error === "check_mismatch") return "The numbers didn't match, so nothing was confirmed. Revoke it if it isn't your phone.";
  if (body?.error === "confirm_expired") return "Too late to confirm that one: pair the phone again.";
  return "Couldn't confirm the phone. Try again.";
}

/** Why a grant or a step-down was refused, in words that say what to do (review r-m6: never "try again" when it can't work). */
function scopeRefusal(e: unknown): string {
  const body = e instanceof ApiError ? (e.body as { error?: string } | null) : null;
  // The phone moved on meanwhile (another tab changed it, or this list was old): the list, read again, shows it as it is.
  if (body?.error === "not_next_scope" || body?.error === "not_previous_scope") return "That phone's access changed meanwhile. Here it is as it stands now.";
  if (body?.error === "device_revoked" || body?.error === "device_expired") return "That phone was revoked or has expired: pair it again.";
  if (e instanceof ApiError && e.status === 404) return "Device sign-in is off, or that phone is no longer paired.";
  return "Couldn't change what that phone can do. Try again.";
}

function pairRefusal(e: unknown): string {
  const body = e instanceof ApiError ? (e.body as { error?: string; retryAfter?: number } | null) : null;
  if (e instanceof ApiError && e.status === 429 && body?.error === "too_many_codes") {
    const minutes = Math.max(1, Math.ceil((body.retryAfter ?? 60) / 60));
    return `Too many codes just now. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`;
  }
  return "Couldn't make a pairing code. Try again.";
}

/** `timeZone`: the account's (Settings passes its prefs'), so the days are counted on the owner's calendar. */
export function DevicesSection({ timezone }: { timezone?: string | null } = {}) {
  const qc = useQueryClient();
  const [minted, setMinted] = useState<{ code: string; expiresAt: string; scope?: string } | null>(null);
  /** The phone whose grant or step-down is being asked about (its one line showing), if any. */
  const [asking, setAsking] = useState<{ id: string; step: "grant" | "reduce" } | null>(null);
  const list = useQuery({
    queryKey: NATIVE_DEVICES_QUERY,
    queryFn: api.nativeDevices,
    retry: false,
    refetchInterval: minted ? LOOK_AGAIN_MS : false,
  });
  const refresh = () => qc.invalidateQueries({ queryKey: NATIVE_DEVICES_QUERY });
  const pair = useMutation({ mutationFn: api.nativePair, onSuccess: (m) => setMinted(m) });
  const confirm = useMutation({
    mutationFn: (d: NativeDeviceDto) => api.nativeConfirm(d.id, d.check ?? ""),
    onSuccess: () => setMinted(null),
    onSettled: refresh,
  });
  const revoke = useMutation({ mutationFn: (id: string) => api.nativeRevoke(id), onSettled: refresh });
  const revokeAll = useMutation({ mutationFn: api.nativeRevokeAll, onSettled: refresh });
  const settled = () => {
    setAsking(null);
    return refresh();
  };
  const grant = useMutation({ mutationFn: (d: { id: string; scope: string }) => api.nativeGrant(d.id, d.scope), onSettled: settled });
  const reduce = useMutation({ mutationFn: (d: { id: string; scope: string }) => api.nativeReduce(d.id, d.scope), onSettled: settled });

  const data = list.data;
  if (!data || !Array.isArray(data.devices) || typeof data.enabled !== "boolean") return null;
  if (!data.enabled && data.devices.length === 0) return null;
  const expired = minted !== null && Date.parse(minted.expiresAt) <= Date.now();
  const busy = revoke.isPending || revokeAll.isPending || confirm.isPending || grant.isPending || reduce.isPending;
  /** The grant an active phone can be given now: only while device sign-in is on, and only one this laptop has words for. */
  const grantOf = (d: NativeDeviceDto) => (data.enabled && d.state === "active" && d.nextScope ? (GRANTS[d.nextScope] ?? null) : null);
  /** The step-down an active phone can be given now, whatever the switch (it never widens a phone). */
  const stepDownOf = (d: NativeDeviceDto) => (d.state === "active" && d.previousScope ? (STEP_DOWNS[d.scope] ?? null) : null);
  const pairedCan = minted?.scope ? CAN[minted.scope] : undefined;

  return (
    <Card title="Devices">
      {!data.enabled ? <p className="muted">Device sign-in is off: paired phones can't sign in. You can still revoke them.</p> : null}
      {data.devices.length === 0 ? <p className="muted">No phone is paired.</p> : null}
      {data.devices.map((d) => {
        const can = CAN[d.scope];
        if (d.state === "pending") {
          return (
            <div key={d.id} className="setting-row">
              <span className="place-row-main">
                <b>{d.label}</b>
                <small>Waiting for your confirmation · Check number {d.check}</small>
                <small>Confirm only if your phone shows the same number.</small>
                {can ? <small>Once confirmed, it can {can}.</small> : null}
              </span>
              <span className="setting-row-end">
                <button type="button" className="btn btn-small" disabled={busy} onClick={() => confirm.mutate(d)}>
                  Confirm
                </button>
                <button type="button" className="btn btn-small" disabled={busy} onClick={() => revoke.mutate(d.id)}>
                  Revoke
                </button>
              </span>
            </div>
          );
        }
        const next = grantOf(d);
        const down = stepDownOf(d);
        /** The question this row is asking, if any: its one line, and what its first button sends. */
        const question =
          asking?.id !== d.id
            ? null
            : asking.step === "grant" && next
              ? { line: next.line, yes: "Allow", send: () => (reduce.reset(), grant.mutate({ id: d.id, scope: d.nextScope! })) }
              : asking.step === "reduce" && down
                ? { line: down.line, yes: "Stop", send: () => (grant.reset(), reduce.mutate({ id: d.id, scope: d.previousScope! })) }
                : null;
        return (
          <div key={d.id} className="setting-row">
            <span className="place-row-main">
              <b>{d.label}</b>
              {can ? <small>Can {can}.</small> : null}
              <small>
                {d.lastUsedAt ? `Last used ${relativeTime(d.lastUsedAt)}` : "Never used"} · {expiresIn(daysLeft(d.expiresAt, timezone))}
              </small>
              {/* 7 calendar days or fewer: the phone warns too. */}
              {daysLeft(d.expiresAt, timezone) <= WARN_DAYS ? <small>Pair it again before then: Pair a phone, here.</small> : null}
              {question ? <small>{question.line}</small> : null}
            </span>
            <span className="setting-row-end">
              {question ? (
                <>
                  <button type="button" className="btn btn-small btn-primary" disabled={busy} onClick={question.send}>
                    {question.yes}
                  </button>
                  <button type="button" className="btn btn-small" disabled={busy} onClick={() => setAsking(null)}>
                    Not now
                  </button>
                </>
              ) : (
                <>
                  {next ? (
                    <button type="button" className="btn btn-small" disabled={busy} onClick={() => setAsking({ id: d.id, step: "grant" })}>
                      {next.button}
                    </button>
                  ) : null}
                  {down ? (
                    <button type="button" className="btn btn-small" disabled={busy} onClick={() => setAsking({ id: d.id, step: "reduce" })}>
                      {down.button}
                    </button>
                  ) : null}
                  <button type="button" className="btn btn-small" disabled={busy} onClick={() => revoke.mutate(d.id)}>
                    Revoke
                  </button>
                </>
              )}
            </span>
          </div>
        );
      })}
      {confirm.isError ? <Banner kind="warn">{confirmRefusal(confirm.error)}</Banner> : null}
      {grant.isError ? <Banner kind="warn">{scopeRefusal(grant.error)}</Banner> : null}
      {reduce.isError ? <Banner kind="warn">{scopeRefusal(reduce.error)}</Banner> : null}
      {minted ? (
        <div className="stack">
          {expired ? (
            <p className="muted">That code has expired. Pair again for a new one.</p>
          ) : (
            <>
              <p className="muted">On your phone, enter this code. It works once.</p>
              <p className="pair-code" aria-label={`Pairing code ${minted.code.split("").join(" ")}`}>
                {grouped(minted.code)}
              </p>
              <small className="muted">Expires at {clockOf(minted.expiresAt)}</small>
              {pairedCan ? <small className="muted">A phone paired now can {pairedCan}.</small> : null}
            </>
          )}
          <div>
            <button type="button" className="btn btn-small" onClick={() => setMinted(null)}>
              Done
            </button>
          </div>
        </div>
      ) : null}
      {pair.isError ? <Banner kind="warn">{pairRefusal(pair.error)}</Banner> : null}
      <div className="btn-row">
        {data.enabled ? (
          <button type="button" className="btn" disabled={pair.isPending} onClick={() => pair.mutate()}>
            Pair a phone
          </button>
        ) : null}
        {data.devices.length > 0 ? (
          <button type="button" className="btn btn-danger" disabled={busy} onClick={() => revokeAll.mutate()}>
            Revoke all
          </button>
        ) : null}
      </div>
    </Card>
  );
}
