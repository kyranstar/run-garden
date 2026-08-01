import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@rg/api-client";
import type { UserPreferences } from "@rg/domain";
import { Banner, Card, formatDayShort, Sheet, Spinner } from "../components.js";

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

function SchedulingSection({ prefs }: { prefs: UserPreferences }) {
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
      <div className="row" style={{ gap: "0.8rem" }}>
        <NumberField id="s-before" label="Buffer before" value={draft.bufferBeforeMinutes} onChange={(v) => set("bufferBeforeMinutes", v)} suffix="min" />
        <NumberField id="s-after" label="Buffer after" value={draft.bufferAfterMinutes} onChange={(v) => set("bufferAfterMinutes", v)} suffix="min" />
      </div>
      <div className="field">
        <label htmlFor="s-tz">Timezone</label>
        <input id="s-tz" type="text" value={draft.timezone} onChange={(e) => set("timezone", e.target.value)} />
        <span className="hint">IANA name, e.g. America/Los_Angeles</span>
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
  const stravaDisconnect = useMutation({
    mutationFn: api.stravaDisconnect,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["me"] }),
  });

  const conn = (p: string) => me.data?.connections.find((c) => c.provider === p);
  const google = conn("google_calendar");
  const strava = conn("strava");
  const calendarChosen = !!settings.data?.prefs.calendarId;

  return (
    <Card title="Connections">
      <div className="switch-row">
        <div>
          <strong>Google Calendar</strong>
          <p className="faint">
            {google?.status === "connected"
              ? calendarChosen
                ? "Connected · mirroring workouts"
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
            Connect
          </a>
        )}
      </div>

      <div className="switch-row">
        <div>
          <strong>Strava</strong>{" "}
          {strava?.status === "error" ? <span className="pill pill-warn">Reconnect needed</span> : null}
          <p className="faint">
            {strava?.status === "connected"
              ? "Connected · reading completed runs"
              : strava?.status === "error"
                ? "Access stopped (subscription may have lapsed). COROS still provides completions; reconnect for faster updates and routes. Never uploads."
                : "COROS already sends runs to Strava; connecting lets Run Garden see them sooner. Never uploads."}
          </p>
        </div>
        {strava?.status === "connected" ? (
          <button className="btn btn-small" disabled={stravaDisconnect.isPending} onClick={() => stravaDisconnect.mutate()}>
            Disconnect
          </button>
        ) : (
          <a className="btn btn-small" href="/api/strava/connect">
            {strava?.status === "error" ? "Reconnect" : "Connect"}
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

function DevicesSection() {
  const qc = useQueryClient();
  const devices = useQuery({ queryKey: ["devices"], queryFn: api.devices });
  const revoke = useMutation({
    mutationFn: (id: string) => api.revokeDevice(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["devices"] }),
  });
  const pause = useMutation({
    mutationFn: ({ id, paused }: { id: string; paused: boolean }) => api.pauseDevice(id, paused),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["devices"] }),
  });

  const active = devices.data?.devices.filter((d) => !d.revokedAt) ?? [];

  return (
    <Card title="Desktop companion">
      {active.length === 0 ? (
        <p className="muted">
          No Mac connected yet. The desktop companion securely connects to COROS and updates your
          training calendar — your COROS password stays on your Mac.
        </p>
      ) : (
        active.map((d) => (
          <div className="switch-row" key={d.id}>
            <div>
              <strong>{d.name}</strong>{" "}
              {d.online ? (
                <span className="pill pill-ok">Online</span>
              ) : (
                <span className="pill pill-neutral">Offline</span>
              )}
              {d.bridgePaused ? <span className="pill pill-neutral">Bridge paused</span> : null}
              <p className="faint">
                Last seen {new Date(d.lastSeenAt).toLocaleString()} · app {d.appVersion}
                {d.capabilities?.updateExistingScheduledWorkout
                  ? " · COROS schedule updates supported"
                  : " · calendar-only"}
              </p>
            </div>
            <div className="btn-row">
              <button
                className="btn btn-small"
                onClick={() => pause.mutate({ id: d.id, paused: !d.bridgePaused })}
              >
                {d.bridgePaused ? "Resume bridge" : "Pause bridge"}
              </button>
              <button className="btn btn-small btn-danger" onClick={() => revoke.mutate(d.id)}>
                Revoke
              </button>
            </div>
          </div>
        ))
      )}
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
          <strong>Weekly review narration</strong>
          <p className="faint">
            The only AI feature. Everything else is deterministic; the app is fully useful with AI
            off.
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
  const [open, setOpen] = useState(false);
  const diagnostics = useQuery({
    queryKey: ["diagnostics"],
    queryFn: api.diagnostics,
    enabled: open,
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
          <div className="btn-row">
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
  const devices = (data.devices as Array<{ name: string; lastSeenAt: string; bridgeVersion: string | null }>) ?? [];
  const errors = (data.recentErrors as Array<{ category: string; createdAt: string; provider: string | null }>) ?? [];
  return (
    <div className="muted" style={{ fontSize: "0.85rem" }}>
      <p>App {String(data.appVersion)} · fixture mode {data.fixtureMode ? "ON" : "off"}</p>
      <p>
        COROS: last read {coros?.lastRead ? new Date(coros.lastRead).toLocaleString() : "never"} ·{" "}
        {coros?.pendingWriteJobs ?? 0} pending write jobs
      </p>
      {devices.map((d) => (
        <p key={d.name}>
          Device {d.name}: bridge {d.bridgeVersion ?? "?"} · heartbeat {new Date(d.lastSeenAt).toLocaleString()}
        </p>
      ))}
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
      <DevicesSection />
      <SchedulingSection prefs={settings.data.prefs} />
      <AiSection prefs={settings.data.prefs} />
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
