import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@rg/api-client";
import type { UserPreferences } from "@rg/domain";
import { Banner, Card, formatDayShort, relativeTime, Sheet, Spinner } from "../components.js";
import { md5Hex } from "../md5.js";

const TZ_OPTIONS: string[] = (() => {
  const sv = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
  return typeof sv === "function"
    ? sv("timeZone")
    : [
        "America/New_York",
        "America/Chicago",
        "America/Denver",
        "America/Los_Angeles",
        "Europe/London",
        "Europe/Paris",
        "Asia/Tokyo",
        "UTC",
      ];
})();

function TimeField({
  id,
  label,
  value,
  onChange,
  hint,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  hint?: string;
}) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input id={id} type="time" value={value} onChange={(e) => onChange(e.target.value)} />
      {hint ? <span className="hint">{hint}</span> : null}
    </div>
  );
}

function NumberField({
  id,
  label,
  value,
  onChange,
  suffix,
}: {
  id: string;
  label: string;
  value: number;
  onChange: (v: number) => void;
  suffix: string;
}) {
  return (
    <div className="field">
      <label htmlFor={id}>
        {label} ({suffix})
      </label>
      <input
        id={id}
        type="number"
        min={0}
        max={180}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}

/** Exported for the units-selector unit test (settings.test.tsx). */
export function SchedulingSection({ prefs }: { prefs: UserPreferences }) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState(prefs);
  const [saved, setSaved] = useState(false);
  const save = useMutation({
    mutationFn: () => api.updateSettings(draft),
    onSuccess: () => {
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
      void qc.invalidateQueries({ queryKey: ["settings"] });
      void qc.invalidateQueries({ queryKey: ["today"] });
    },
  });
  const set = <K extends keyof UserPreferences>(k: K, v: UserPreferences[K]) =>
    setDraft((d) => ({ ...d, [k]: v }));

  return (
    <Card title="Scheduling">
      <TimeField id="s-wm" label="Weekday morning run" value={draft.weekdayMorningTime} onChange={(v) => set("weekdayMorningTime", v)} />
      <TimeField id="s-we" label="Weekday evening run" value={draft.weekdayEveningTime} onChange={(v) => set("weekdayEveningTime", v)} />
      <TimeField id="s-sm" label="Weekend morning run" value={draft.weekendMorningTime} onChange={(v) => set("weekendMorningTime", v)} />
      <div className="field">
        <label htmlFor="s-window">Preferred window</label>
        <select
          id="s-window"
          value={draft.defaultWindow}
          onChange={(e) => set("defaultWindow", e.target.value as "morning" | "evening")}
        >
          <option value="morning">Morning</option>
          <option value="evening">Evening</option>
        </select>
      </div>
      <TimeField
        id="s-rem"
        label="Previous-evening reminder"
        value={draft.eveningReminderTime}
        onChange={(v) => set("eveningReminderTime", v)}
        hint="“Morning run tomorrow at 7:00 AM. Protect tonight's sleep.”"
      />
      <TimeField id="s-fin" label="Latest evening finish" value={draft.latestEveningFinish} onChange={(v) => set("latestEveningFinish", v)} />
      <div className="field">
        <label htmlFor="s-race">Race day</label>
        <input
          id="s-race"
          type="date"
          value={draft.raceDate ?? ""}
          onChange={(e) => set("raceDate", e.target.value || null)}
        />
        <span className="hint">
          Marked on your plan charts and cards; the coach plans the final weeks around it. Clear it
          when there's no race on the horizon.
        </span>
      </div>
      <div className="row" style={{ gap: "0.8rem" }}>
        <NumberField id="s-before" label="Buffer before" value={draft.bufferBeforeMinutes} onChange={(v) => set("bufferBeforeMinutes", v)} suffix="min" />
        <NumberField id="s-after" label="Buffer after" value={draft.bufferAfterMinutes} onChange={(v) => set("bufferAfterMinutes", v)} suffix="min" />
      </div>
      <div className="field">
        <label htmlFor="s-race-dist">Race distance</label>
        <select
          id="s-race-dist"
          value={draft.raceDistanceKm === null ? "" : String(draft.raceDistanceKm)}
          onChange={(e) => set("raceDistanceKm", e.target.value === "" ? null : Number(e.target.value))}
        >
          <option value="">Not set</option>
          <option value="5">5K</option>
          <option value="10">10K</option>
          <option value="21.0975">Half marathon</option>
          <option value="42.195">Marathon</option>
          {draft.raceDistanceKm !== null &&
          ![5, 10, 21.0975, 42.195].includes(draft.raceDistanceKm) ? (
            <option value={String(draft.raceDistanceKm)}>{draft.raceDistanceKm} km</option>
          ) : null}
        </select>
        <span className="hint">
          Turns your measured threshold into a goal time on the Plan page. Without it the race
          strip shows your threshold pace and makes no time prediction.
        </span>
      </div>
      <div className="field">
        <label htmlFor="s-tz">Timezone</label>
        <input
          id="s-tz"
          type="text"
          list="tz-options"
          value={draft.timezone}
          onChange={(e) => set("timezone", e.target.value)}
          placeholder="Start typing a city…"
          autoComplete="off"
        />
        <datalist id="tz-options">
          {TZ_OPTIONS.map((tz) => (
            <option key={tz} value={tz} />
          ))}
        </datalist>
        <span className="hint">Type to search. Auto-synced from your Google Calendar when you connect it.</span>
      </div>
      <div className="field">
        <label htmlFor="s-units">Distance &amp; pace units</label>
        <select
          id="s-units"
          value={draft.units}
          onChange={(e) => set("units", e.target.value as "km" | "mi")}
        >
          <option value="km">Kilometers</option>
          <option value="mi">Miles</option>
        </select>
        <span className="hint">Paces and distances everywhere follow this.</span>
      </div>
      <div className="row" style={{ gap: "0.6rem" }}>
        <button className="btn btn-primary" disabled={save.isPending} onClick={() => save.mutate()}>
          Save scheduling
        </button>
        {saved ? <span className="pill pill-ok">Saved</span> : null}
        {save.isError ? <span className="pill pill-warn">Couldn't save</span> : null}
      </div>
    </Card>
  );
}

/**
 * The one-shot deep history walk. Distinct from the rolling 14-day snapshot:
 * this reaches back as far as the account goes, across all three disciplines,
 * and runs in the cloud one 90-day chunk at a time (legacy: desktop bridge).
 */
function BackfillRow() {
  const qc = useQueryClient();
  const status = useQuery({
    queryKey: ["backfill-status"],
    queryFn: api.backfillStatus,
    // Poll while there is something to watch: an active or queued walk, or an
    // errored one whose job is still live (the walker can resume it — the
    // copy must catch up when it does).
    refetchInterval: (q) => {
      const d = q.state.data;
      return d?.status === "running" || d?.status === "queued" || (d?.status === "error" && d.jobQueued)
        ? 5000
        : false;
    },
  });
  const coros = useQuery({ queryKey: ["coros-status"], queryFn: api.corosStatus });
  const cloud = coros.data?.connected === true;
  const start = useMutation({
    mutationFn: api.backfillHistory,
    onSuccess: () => {
      void status.refetch();
      void qc.invalidateQueries({ queryKey: ["runs"] });
    },
  });

  const s = status.data;
  const running = s?.status === "running";
  const queued = s?.status === "queued";
  // Honest states: queued names the executor it's waiting on, and an error
  // names which way it went wrong — never a spinner over nothing.
  const detail =
    s?.status === "error"
      ? cloud
        ? "It stalled — press Run again; the cloud walker resumes where it left off."
        : s.lastErrorCategory === "never_started"
        ? "It never started — connect COROS above and press Run again."
        : s.lastErrorCategory === "stalled"
          ? `It stopped partway through (${s.activitiesIngested} sessions so far). Press Run again — the walk resumes where it left off.`
          : "Couldn't read your history — press Run again."
      : queued
        ? cloud
          ? "Queued — running in the cloud; the first chunk lands within a minute."
          : "Queued — connect COROS above and it runs in the cloud."
        : running
          ? `Reading your COROS history — ${s.chunksCompleted} ${s.chunksCompleted === 1 ? "chunk" : "chunks"}, ${s.activitiesIngested} sessions so far${s.earliestDateReached ? `, back to ${s.earliestDateReached}` : ""}.`
          : s?.status === "done"
            ? `History loaded: ${s.activitiesIngested} sessions${s.earliestDateReached ? ` back to ${s.earliestDateReached}` : ""}.`
            : cloud
          ? "Pull your full run, lift, and yoga history from COROS. Runs once, in the cloud."
          : "Pull your full run, lift, and yoga history from COROS. Connect COROS above first — it runs in the cloud.";

  return (
    <div className="switch-row">
      <div>
        <strong>History</strong>
        <p className="faint">{detail}</p>
      </div>
      <button
        className="btn btn-small"
        disabled={start.isPending || running || queued}
        onClick={() => start.mutate()}
      >
        {running
          ? "Reading…"
          : queued
            ? "Queued…"
            : s?.status === "done" || s?.status === "error"
              ? "Run again"
              : "Backfill history"}
      </button>
    </div>
  );
}

function ConnectionsSection() {
  const qc = useQueryClient();
  const me = useQuery({ queryKey: ["me"], queryFn: api.me });
  const calendars = useQuery({ queryKey: ["calendars"], queryFn: api.calendars, retry: false });
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings });
  const [chooseOpen, setChooseOpen] = useState(false);
  const choose = useMutation({
    mutationFn: (opts: { calendarId?: string; createNew?: boolean }) => api.chooseCalendar(opts),
    onSuccess: () => {
      setChooseOpen(false);
      void qc.invalidateQueries();
    },
  });
  const syncNow = useMutation({ mutationFn: api.calendarSync });

  const conn = (p: string) => me.data?.connections.find((c) => c.provider === p);
  const google = conn("google_calendar");
  const calendarChosen = !!settings.data?.prefs.calendarId;

  return (
    <Card title="Connections">
      <div className="switch-row">
        <div>
          <strong>Google Calendar</strong>
          <p className="faint">
            {google?.status === "error"
              ? "Mirroring stopped — Google expired the connection. Reconnect to resume."
              : google?.status === "connected"
                ? calendarChosen
                  ? `Connected · mirroring workouts${google.lastSyncAt ? ` · synced ${relativeTime(google.lastSyncAt)}` : ""}`
                  : "Connected · choose a calendar to start mirroring"
                : "Mirrors workouts with reminders"}
          </p>
        </div>
        {google?.status === "connected" ? (
          <div className="btn-row">
            <button className="btn btn-small" onClick={() => setChooseOpen(true)}>
              {calendarChosen ? "Change calendar" : "Choose calendar"}
            </button>
            {calendarChosen ? (
              <button className="btn btn-small" disabled={syncNow.isPending} onClick={() => syncNow.mutate()}>
                Sync now
              </button>
            ) : null}
          </div>
        ) : (
          <a className="btn btn-small" href="/api/auth/google/start?mode=calendar&redirect=/settings">
            {google?.status === "error" ? "Reconnect" : "Connect"}
          </a>
        )}
      </div>

      <Sheet open={chooseOpen} onClose={() => setChooseOpen(false)} title="Choose a calendar">
        <div className="stack">
          <button
            className="btn btn-primary"
            disabled={choose.isPending}
            onClick={() => choose.mutate({ createNew: true })}
          >
            Create a dedicated “Run Garden” calendar
          </button>
          {calendars.data?.calendars.map((cal) => (
            <button
              key={cal.id}
              className="btn"
              disabled={choose.isPending}
              onClick={() => choose.mutate({ calendarId: cal.id })}
            >
              {cal.summary}
              {cal.primary ? " (primary)" : ""}
            </button>
          ))}
          {calendars.isError ? (
            <Banner kind="warn">Connect Google Calendar first, then choose a calendar.</Banner>
          ) : null}
        </div>
      </Sheet>
    </Card>
  );
}

/** Cloud COROS connection (cloud-direct spec §1): email + password, hashed
 * in the browser before the request — the plaintext never leaves this
 * device. Exposed states: disconnected form / connected line / rejected
 * credentials with the form re-opened. */
export function CorosConnectSection() {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ["coros-status"], queryFn: api.corosStatus });
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [region, setRegion] = useState<"us" | "eu" | "cn">("us");
  const [result, setResult] = useState<string | null>(null);
  const [failCode, setFailCode] = useState<string | null>(null);
  const connect = useMutation({
    mutationFn: () => {
      const pwdMd5 = md5Hex(password);
      return api.corosConnect({ email: email.trim(), pwdMd5, region });
    },
    onSuccess: (r) => {
      setResult(r.status);
      setFailCode(r.code ?? null);
      if (r.status === "connected") {
        setPassword("");
        // The connect kicked the first pull server-side — drop every cache
        // that pull can change, so screens refetch as it lands.
        for (const k of ["coros-status", "sync-status", "coros-read-now", "backfill-status"]) {
          void qc.invalidateQueries({ queryKey: [k] });
        }
      }
    },
    onError: () => {
      setResult("login_failed");
      setFailCode(null);
    },
  });
  const disconnect = useMutation({
    mutationFn: api.corosDisconnect,
    onSuccess: () => {
      setResult(null);
      void qc.invalidateQueries({ queryKey: ["coros-status"] });
    },
  });

  const s = status.data;
  const connected = s?.connected === true;
  const badCreds = s?.lastErrorCategory === "bad_credentials" || result === "bad_credentials";

  return (
    <Card title="COROS connection">
      {connected && !badCreds ? (
        <div className="stack" style={{ gap: "0.5rem" }}>
          <p className="muted">
            Connected as <strong>{s?.email}</strong>
            {s?.lastSyncAt ? ` · last sync ${relativeTime(s.lastSyncAt)}` : " · first sync pending"}.
            Activities and watch updates flow directly.
          </p>
          <div>
            <button className="btn btn-small" disabled={disconnect.isPending} onClick={() => disconnect.mutate()}>
              Disconnect
            </button>
          </div>
        </div>
      ) : (
        <form
          className="stack"
          style={{ gap: "0.5rem", maxWidth: "26rem" }}
          onSubmit={(e) => {
            e.preventDefault();
            if (email.trim() && password) connect.mutate();
          }}
        >
          {badCreds ? (
            <Banner kind="warn">COROS rejected the password — check it and try again.</Banner>
          ) : result === "login_failed" && failCode ? (
            <Banner kind="warn">
              COROS didn't accept this login (code {failCode}). Double-check the email, and if your
              account lives on another COROS server, switch the region below and try again.
            </Banner>
          ) : result === "login_failed" ? (
            <Banner kind="warn">Couldn't reach COROS just now — try again in a moment.</Banner>
          ) : (
            <p className="muted">
              Connect your COROS account so activities appear the moment you open the app. Your
              password is hashed on this device before it's sent, and only the hash is stored —
              encrypted.
            </p>
          )}
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="COROS account email"
            aria-label="COROS account email"
            autoComplete="username"
          />
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="COROS password"
            aria-label="COROS password"
            autoComplete="current-password"
          />
          <label className="row" style={{ gap: "0.5rem" }}>
            <span className="muted">Region</span>
            <select value={region} onChange={(e) => setRegion(e.target.value as "us" | "eu" | "cn")} aria-label="COROS region">
              <option value="us">Americas / global</option>
              <option value="eu">Europe</option>
              <option value="cn">China</option>
            </select>
          </label>
          <div>
            <button className="btn btn-primary" type="submit" disabled={connect.isPending || !email.trim() || !password}>
              {connect.isPending ? "Checking with COROS…" : "Connect"}
            </button>
          </div>
        </form>
      )}
      <BackfillRow />
    </Card>
  );
}


function CorosSyncSection({ prefs }: { prefs: UserPreferences }) {
  const qc = useQueryClient();
  const toggle = useMutation({
    mutationFn: (corosWritesEnabled: boolean) => api.updateSettings({ corosWritesEnabled }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["settings"] });
      void qc.invalidateQueries({ queryKey: ["plan"] });
      void qc.invalidateQueries({ queryKey: ["today"] });
    },
  });
  return (
    <Card title="COROS sync">
      <div className="switch-row">
        <div>
          <strong>Write date changes back to COROS</strong>
          <p className="faint">
            When you move a workout here, your COROS calendar is updated to match (verified
            after every write). When off, moves only change Run Garden and Google Calendar —
            workouts you move show “Not synced to COROS”.
          </p>
        </div>
        <button
          className="btn btn-small"
          disabled={toggle.isPending}
          onClick={() => toggle.mutate(!prefs.corosWritesEnabled)}
        >
          {prefs.corosWritesEnabled ? "Disable" : "Enable"}
        </button>
      </div>
    </Card>
  );
}

function AiSection({ prefs }: { prefs: UserPreferences }) {
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings });
  const toggle = useMutation({
    mutationFn: (aiEnabled: boolean) => api.updateSettings({ aiEnabled }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["settings"] }),
  });
  const llm = settings.data?.llm;
  return (
    <Card title="AI">
      <div className="switch-row">
        <div>
          <strong>Activity reads &amp; weekly narration</strong>
          <p className="faint">
            This switch gates the coach&apos;s automatic activity reads and the weekly review
            narration. Coach chat, check-ins, and Studio plan generation are also AI-powered but
            run only when you ask. Scheduling, sync, and the garden are fully deterministic.
          </p>
        </div>
        <button className="btn btn-small" disabled={toggle.isPending} onClick={() => toggle.mutate(!prefs.aiEnabled)}>
          {prefs.aiEnabled ? "Disable AI" : "Enable AI"}
        </button>
      </div>
      {llm ? (
        <p className="muted" style={{ marginTop: "0.5rem" }}>
          Spend this week: ${llm.spentDollars.toFixed(2)} of ${llm.cutoffDollars.toFixed(0)} cutoff
          {llm.cutoff ? " — AI calls paused until the rolling week clears." : llm.warn ? " — approaching the warning level." : "."}
        </p>
      ) : null}
    </Card>
  );
}

function DiagnosticsSection() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const diagnostics = useQuery({
    queryKey: ["diagnostics"],
    queryFn: api.diagnostics,
    enabled: open,
  });
  const syncStatus = useQuery({
    queryKey: ["sync-status"],
    queryFn: api.syncStatus,
    enabled: open,
  });
  const syncNow = useMutation({
    mutationFn: api.readNow,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["sync-status"] });
      void qc.invalidateQueries({ queryKey: ["diagnostics"] });
    },
  });

  const download = () => {
    const blob = new Blob([JSON.stringify(diagnostics.data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "run-garden-diagnostics.json";
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Card title="Diagnostics">
      {!open ? (
        <button className="btn" onClick={() => setOpen(true)}>
          Show diagnostics
        </button>
      ) : diagnostics.isLoading ? (
        <Spinner />
      ) : diagnostics.data ? (
        <div className="stack">
          <DiagRows data={diagnostics.data} />
          {syncStatus.data?.lastCorosReadAt ? (
            <p className="muted" style={{ fontSize: "0.85rem" }}>
              Last successful COROS read: {new Date(syncStatus.data.lastCorosReadAt).toLocaleString()}
            </p>
          ) : null}
          <div className="btn-row">
            <button className="btn btn-small" disabled={syncNow.isPending} onClick={() => syncNow.mutate()}>
              {syncNow.isPending ? "Syncing…" : "Sync now"}
            </button>
            <button className="btn btn-small" onClick={download}>
              Download sanitized JSON
            </button>
          </div>
        </div>
      ) : (
        <p className="muted">Couldn't load diagnostics.</p>
      )}
    </Card>
  );
}

function DiagRows({ data }: { data: Record<string, unknown> }) {
  const coros = data.coros as { lastRead: string | null; pendingWriteJobs: number } | undefined;
  const versions = data.versions as Record<string, unknown> | undefined;
  const providers = (data.providers as Array<{ provider: string; status: string; lastSyncAt: string | null }>) ?? [];
  const errors = (data.recentErrors as Array<{ category: string; createdAt: string; provider: string | null }>) ?? [];
  return (
    <div className="muted" style={{ fontSize: "0.85rem" }}>
      <p>App {String(data.appVersion)} · fixture mode {data.fixtureMode ? "ON" : "off"}</p>
      <p>
        COROS: last read {coros?.lastRead ? new Date(coros.lastRead).toLocaleString() : "never"} ·{" "}
        {coros?.pendingWriteJobs ?? 0} pending write jobs
      </p>
      {providers.map((p) => (
        <p key={p.provider}>
          {p.provider}: {p.status}
          {p.lastSyncAt ? ` · synced ${new Date(p.lastSyncAt).toLocaleString()}` : ""}
        </p>
      ))}
      <p>
        Versions — simulation {String(versions?.simulation)} · normalizer {String(versions?.normalizer)} · estimator{" "}
        {String(versions?.estimator)} · garden day {String(versions?.gardenLastSimulated)}
      </p>
      <p>LLM cost (7d): ${Number(data.llmCost7dDollars ?? 0).toFixed(2)}</p>
      {errors.length > 0 ? (
        <details>
          <summary>Recent errors ({errors.length})</summary>
          {errors.map((e, i) => (
            <p key={i}>
              {formatDayShort(e.createdAt.slice(0, 10))} · {e.provider ?? "app"} · {e.category}
            </p>
          ))}
        </details>
      ) : (
        <p>No recent errors.</p>
      )}
    </div>
  );
}

function DangerSection() {
  const [confirming, setConfirming] = useState(false);
  const del = useMutation({
    mutationFn: api.deleteAll,
    onSuccess: () => {
      window.location.href = "/";
    },
  });
  return (
    <Card title="Your data">
      <div className="btn-row">
        <a className="btn" href="/api/settings/export" download>
          Export everything (JSON)
        </a>
        {!confirming ? (
          <button className="btn btn-danger" onClick={() => setConfirming(true)}>
            Delete all data
          </button>
        ) : (
          <button className="btn btn-danger" disabled={del.isPending} onClick={() => del.mutate()}>
            Really delete everything — cannot be undone
          </button>
        )}
      </div>
    </Card>
  );
}

function GardenSection() {
  const qc = useQueryClient();
  const garden = useQuery({ queryKey: ["garden"], queryFn: api.garden });
  const [untilDate, setUntilDate] = useState("");
  const rest = (garden.data?.restMode as { active: boolean; until: string | null } | undefined) ?? {
    active: false,
    until: null,
  };
  const toggle = useMutation({
    mutationFn: (next: boolean) => api.gardenRestMode(next, next ? untilDate || null : null),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["garden"] }),
  });
  return (
    <Card title="Garden rest mode">
      {rest.active ? (
        <div className="stack">
          <Banner kind="info">
            Rest mode is active — your garden is peacefully dormant and won't decline.
            {rest.until ? ` Ends ${formatDayShort(rest.until)}.` : ""}
          </Banner>
          <button className="btn" disabled={toggle.isPending} onClick={() => toggle.mutate(false)}>
            End rest mode
          </button>
        </div>
      ) : (
        <div className="stack">
          <p className="muted">
            For injury, illness, travel, or a planned break: pause all garden decline. No reasons
            asked.
          </p>
          <div className="field">
            <label htmlFor="rest-until">Optional end date</label>
            <input
              id="rest-until"
              type="date"
              value={untilDate}
              onChange={(e) => setUntilDate(e.target.value)}
            />
          </div>
          <button className="btn" disabled={toggle.isPending} onClick={() => toggle.mutate(true)}>
            Start rest mode
          </button>
        </div>
      )}
    </Card>
  );
}

const MEMORY_GROUPS: Array<{ kind: "fact" | "rule" | "note"; label: string }> = [
  { kind: "fact", label: "About you" },
  { kind: "rule", label: "Rules & preferences" },
  { kind: "note", label: "Notes (time-boxed)" },
];

/**
 * Coach memory — observable and editable (coach UX spec §6). Deleting is
 * immediate and total: the next dossier simply lacks the item.
 */
function CoachMemorySection() {
  const qc = useQueryClient();
  const memory = useQuery({ queryKey: ["coach-memory"], queryFn: api.coachMemoryList });
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["coach-memory"] });
    void qc.invalidateQueries({ queryKey: ["coach-state"] });
  };
  const update = useMutation({
    mutationFn: (v: { id: string; body: string }) => api.coachMemoryUpdate(v.id, v.body),
    onSettled: invalidate,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.coachMemoryDelete(id),
    onSettled: invalidate,
  });
  const rows = memory.data?.memory ?? [];
  return (
    <div id="coach-memory">
      <Card title="Coach memory">
        <p className="muted">
          Everything the coach knows about you — learned from your messages, editable here,
          deleted for good the moment you say so.
        </p>
        {rows.length === 0 ? (
          <p className="faint">Nothing yet — the coach learns as you talk to it.</p>
        ) : (
          MEMORY_GROUPS.map(({ kind, label }) => {
            const group = rows.filter((m) => m.kind === kind);
            if (group.length === 0) return null;
            return (
              <div key={kind} style={{ marginTop: "0.6rem" }}>
                <div className="card-title">{label}</div>
                {group.map((m) => (
                  <div key={m.id} className="memory-row">
                    {editing === m.id ? (
                      <input
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        aria-label="Edit memory"
                        style={{ flex: 1 }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && draft.trim()) {
                            update.mutate({ id: m.id, body: draft.trim() });
                            setEditing(null);
                          }
                          if (e.key === "Escape") setEditing(null);
                        }}
                      />
                    ) : (
                      <span>
                        {m.body}
                        {m.expiresAt ? <span className="faint"> · until {m.expiresAt}</span> : null}
                        <span className="faint"> · {m.provenance.source}, {m.learnedAt.slice(0, 10)}</span>
                      </span>
                    )}
                    <span className="row" style={{ gap: "0.4rem" }}>
                      <button
                        type="button"
                        className="linklike"
                        onClick={() => {
                          setEditing(m.id);
                          setDraft(m.body);
                        }}
                      >
                        Edit
                      </button>
                      <button type="button" className="linklike" onClick={() => remove.mutate(m.id)}>
                        Delete
                      </button>
                    </span>
                  </div>
                ))}
              </div>
            );
          })
        )}
      </Card>
    </div>
  );
}

export function SettingsScreen() {
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings });
  const me = useQuery({ queryKey: ["me"], queryFn: api.me });
  const logout = useMutation({
    mutationFn: api.logout,
    onSuccess: () => {
      window.location.href = "/welcome";
    },
  });

  if (settings.isLoading) return <Spinner label="Loading settings" />;
  if (!settings.data) return <Banner kind="warn">Couldn't load settings.</Banner>;

  return (
    <div className="stack">
      <div className="row-between screen-title">
        <h1>Settings</h1>
        <span className="faint">{me.data?.email}</span>
      </div>
      <ConnectionsSection />
      <CorosConnectSection />
      <SchedulingSection prefs={settings.data.prefs} />
      <CorosSyncSection prefs={settings.data.prefs} />
      <AiSection prefs={settings.data.prefs} />
      <CoachMemorySection />
      <GardenSection />
      <DiagnosticsSection />
      <DangerSection />
      <div>
        <button className="btn" disabled={logout.isPending} onClick={() => logout.mutate()}>
          Sign out
        </button>
      </div>
    </div>
  );
}
