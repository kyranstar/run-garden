/**
 * Settings → Developer → LifeOS QA (the phone QA harness; the worker's routes/qa.ts): the owner's panel for the QA account —
 * an account of fixtures only, at an address no sign-in can reach, that the phone's QA app pairs to so its workout flows can
 * be proven on the real phone without touching the owner's own plan, garden, watch or calendar.
 *
 *  - Nothing renders unless the worker answers the status: anyone but the owner gets a 404, and so sees no Developer group.
 *  - Set up: the account made if there is none, its fixtures seeded if it has none, and a pairing code (5 minutes) with the
 *    run's plan and harness tokens — shown once, with the line to paste into `scripts/phone-qa.sh`.
 *  - New pairing code: a fresh code, for pairing by hand (phone-qa.sh mints its own with the harness token, just before it
 *    pairs, so its line carries no code).
 *  - Revoke QA phone: every paired phone of the QA account ends at once — the owner's Devices list shows only the owner's
 *    own, so a phone kept after a run (`phone-qa.sh --keep`) is ended here, or by the purge. The fixtures stay.
 *  - Purge: asks first; then everything the QA account holds is gone, every table checked, and the panel says how many rows
 *    remain — zero, or the worker refuses to call it done.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, type QaMintDto, type QaPurgeDto, type QaStatusDto } from "@rg/api-client";
import { Banner, Card, relativeTime } from "../../components.js";

export const QA_STATUS_QUERY = ["qa-status"] as const;

/** "7K2QXM9D" → "7K2Q-XM9D", as the phone's field takes it (hyphens are ignored). */
const grouped = (code: string) => `${code.slice(0, 4)}-${code.slice(4)}`;
const clockOf = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

/** The status as the worker answers it, or null for anything else (a 404, an older worker, a stand-in's `{}`). */
export function statusOf(data: unknown): QaStatusDto | null {
  if (typeof data !== "object" || data === null) return null;
  const s = data as Partial<QaStatusDto>;
  return "qa" in s && typeof s.today === "string" && typeof s.rows === "number" && Array.isArray(s.devices) && Array.isArray(s.plan) ? (s as QaStatusDto) : null;
}

/** The line `scripts/phone-qa.sh` takes, from a mint's answer: the run's two tokens (the script mints its own fresh code). */
export const harnessLine = (m: Pick<QaMintDto, "harnessToken" | "planToken">) =>
  `QA_HARNESS_TOKEN=${m.harnessToken} QA_PLAN_TOKEN=${m.planToken} scripts/phone-qa.sh`;

/** Set up: the account made, its fixtures seeded (each skipped when already done), and a pairing code — three requests. */
export async function setUp(): Promise<QaMintDto> {
  const already = (e: unknown, code: string) => e instanceof ApiError && e.status === 409 && (e.body as { error?: string } | null)?.error === code;
  await api.qaCreate().catch((e: unknown) => {
    if (!already(e, "qa_exists")) throw e;
  });
  await api.qaSeed().catch((e: unknown) => {
    if (!already(e, "already_seeded")) throw e;
  });
  return api.qaPair();
}

/** The purge's steps (each one request within the worker's budget) until it says done: what went, summed, and the last word. */
export async function purgeAll(): Promise<QaPurgeDto> {
  const removed: Record<string, number> = {};
  for (let step = 0; step < 10; step++) {
    const answer = await api.qaPurge();
    for (const [name, n] of Object.entries(answer.removed)) removed[name] = (removed[name] ?? 0) + n;
    if (answer.done) return { ...answer, removed };
  }
  throw new Error("purge_unfinished");
}

function refusal(e: unknown): string {
  const body = e instanceof ApiError ? (e.body as { error?: string; retryAfter?: number; remaining?: Record<string, number> } | null) : null;
  if (body?.error === "too_many_codes") {
    const minutes = Math.max(1, Math.ceil((body.retryAfter ?? 60) / 60));
    return `Too many codes just now. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`;
  }
  if (body?.error === "purge_incomplete") return `The purge didn't finish: rows remain in ${Object.keys(body.remaining ?? {}).join(", ")}. Purge again.`;
  return "That didn't work. Try again.";
}

export function QaSection() {
  const qc = useQueryClient();
  const [minted, setMinted] = useState<QaMintDto | null>(null);
  const [purged, setPurged] = useState<QaPurgeDto | null>(null);
  const [revoked, setRevoked] = useState<number | null>(null);
  const [asking, setAsking] = useState(false);
  const status = useQuery({ queryKey: QA_STATUS_QUERY, queryFn: api.qaStatus, retry: false });
  const refresh = () => qc.invalidateQueries({ queryKey: QA_STATUS_QUERY });
  const setup = useMutation({ mutationFn: setUp, onSuccess: (m) => (setPurged(null), setMinted(m)), onSettled: refresh });
  const pair = useMutation({ mutationFn: api.qaPair, onSuccess: (m) => setMinted(m), onSettled: refresh });
  const revoke = useMutation({ mutationFn: api.qaRevoke, onSuccess: (r) => setRevoked(r.revoked), onSettled: refresh });
  const purge = useMutation({
    mutationFn: purgeAll,
    onSuccess: (p) => (setMinted(null), setPurged(p)),
    onSettled: () => (setAsking(false), refresh()),
  });

  const data = statusOf(status.data);
  if (!data) return null;
  const busy = setup.isPending || pair.isPending || revoke.isPending || purge.isPending;
  const failed = setup.error ?? pair.error ?? revoke.error ?? purge.error;
  const livePhone = data.devices.some((d) => d.state !== "revoked");
  const removed = purged ? Object.values(purged.removed).reduce((a, b) => a + b, 0) : 0;
  const expired = minted !== null && Date.parse(minted.expiresAt) <= Date.now();

  return (
    <Card title="LifeOS QA">
      <p className="muted">
        A separate account of fixtures only, for proving LifeOS's workout flows on the phone. It never reaches your plan, garden,
        watch or calendar, and nothing it does leaves run-garden.
      </p>
      {data.qa === null ? (
        <p>No QA account.</p>
      ) : (
        <>
          <p>
            QA account <code>{data.qa.accountTag}</code> · {data.rows} rows
            {data.qa.createdAt ? ` · made ${relativeTime(data.qa.createdAt)}` : ""}
          </p>
          {data.plan.length > 0 ? (
            <ul className="muted">
              {data.plan.map((p, i) => (
                <li key={`${p.date}-${p.time}-${i}`}>
                  {p.date === data.today ? "Today" : p.date} {p.time} · {p.title} · {p.state}
                </li>
              ))}
            </ul>
          ) : null}
          {data.devices.map((d, i) => (
            <p key={i} className="muted">
              {d.label} · {d.state} · {d.scope} · {d.lastUsedAt ? `last used ${relativeTime(d.lastUsedAt)}` : "never used"}
            </p>
          ))}
        </>
      )}
      {minted && !expired ? (
        <div className="stack">
          <p>
            Pairing code <b>{grouped(minted.code)}</b>, until {clockOf(minted.expiresAt)}. The harness token lasts until{" "}
            {clockOf(minted.harnessExpiresAt)}.
          </p>
          <code className="qa-harness-line">{harnessLine(minted)}</code>
        </div>
      ) : null}
      {purged ? (
        <p>
          Purged: {removed} rows removed, {purged.total} remain.
        </p>
      ) : null}
      {revoked !== null ? <p>Revoked {revoked === 1 ? "1 QA phone" : `${revoked} QA phones`}.</p> : null}
      {failed ? <Banner kind="warn">{refusal(failed)}</Banner> : null}
      {asking ? (
        <div className="stack">
          <p>Purge everything the QA account holds?</p>
          <div className="row">
            <button type="button" className="btn btn-small" disabled={busy} onClick={() => purge.mutate()}>
              Purge everything
            </button>
            <button type="button" className="btn btn-small" disabled={busy} onClick={() => setAsking(false)}>
              Not now
            </button>
          </div>
        </div>
      ) : (
        <div className="row">
          {data.qa === null ? (
            <button type="button" className="btn btn-small" disabled={busy} onClick={() => setup.mutate()}>
              Set up
            </button>
          ) : (
            <>
              <button type="button" className="btn btn-small" disabled={busy} onClick={() => pair.mutate()}>
                New pairing code
              </button>
              {livePhone ? (
                <button type="button" className="btn btn-small" disabled={busy} onClick={() => revoke.mutate()}>
                  Revoke QA phone
                </button>
              ) : null}
              <button type="button" className="btn btn-small" disabled={busy} onClick={() => setAsking(true)}>
                Purge
              </button>
            </>
          )}
        </div>
      )}
    </Card>
  );
}
