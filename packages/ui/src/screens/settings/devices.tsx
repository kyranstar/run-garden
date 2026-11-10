/**
 * Settings → Data & account → Devices (native device sign-in, the LifeOS migration's SLICE-CONTRACT revision 2 §10.1, §4):
 * the laptop pairs a phone and can stop it.
 *
 *  - Pair a phone: the account's one code (a new one burns the old), shown once, with its expiry; Done puts it away and
 *    nothing reads it back. While it is out, the list is looked at again every few seconds for the phone that redeems it.
 *  - A pending phone: its label and the check number it shows too, with Confirm (which sends that number) and Revoke.
 *  - An active phone: its label, last use and expiry (and a word when it expires within 7 days), with Revoke.
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
  const [minted, setMinted] = useState<{ code: string; expiresAt: string } | null>(null);
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

  const data = list.data;
  if (!data || !Array.isArray(data.devices) || typeof data.enabled !== "boolean") return null;
  if (!data.enabled && data.devices.length === 0) return null;
  const expired = minted !== null && Date.parse(minted.expiresAt) <= Date.now();
  const busy = revoke.isPending || revokeAll.isPending || confirm.isPending;

  return (
    <Card title="Devices">
      {!data.enabled ? <p className="muted">Device sign-in is off: paired phones can't sign in. You can still revoke them.</p> : null}
      {data.devices.length === 0 ? <p className="muted">No phone is paired.</p> : null}
      {data.devices.map((d) =>
        d.state === "pending" ? (
          <div key={d.id} className="setting-row">
            <span className="place-row-main">
              <b>{d.label}</b>
              <small>Waiting for your confirmation · Check number {d.check}</small>
              <small>Confirm only if your phone shows the same number.</small>
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
        ) : (
          <div key={d.id} className="setting-row">
            <span className="place-row-main">
              <b>{d.label}</b>
              <small>
                {d.lastUsedAt ? `Last used ${relativeTime(d.lastUsedAt)}` : "Never used"} · {expiresIn(daysLeft(d.expiresAt, timezone))}
              </small>
              {/* 7 calendar days or fewer: the phone warns too. */}
              {daysLeft(d.expiresAt, timezone) <= WARN_DAYS ? <small>Pair it again before then: Pair a phone, here.</small> : null}
            </span>
            <span className="setting-row-end">
              <button type="button" className="btn btn-small" disabled={busy} onClick={() => revoke.mutate(d.id)}>
                Revoke
              </button>
            </span>
          </div>
        ),
      )}
      {confirm.isError ? <Banner kind="warn">{confirmRefusal(confirm.error)}</Banner> : null}
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
