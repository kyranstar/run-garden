import { useEffect, useState } from "react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { AmbientGarden, App as WebApp, Banner, Card, Sheet } from "@rg/ui";
import { PRODUCT_NAME } from "@rg/domain";
import { desktop, isAmbientWindow, isDesktop, type BridgeState } from "./tauri.js";

const queryClient = new QueryClient();

// The cloud URL the desktop app connects to. Override with VITE_CLOUD_URL at
// build time (e.g. for local dev against http://localhost:8787).
const CLOUD_URL =
  import.meta.env.VITE_CLOUD_URL ?? "https://run-garden-api.kyranadams.workers.dev";

function BridgeStatusRow({ state }: { state: BridgeState }) {
  const dot = !state.running
    ? "dot-offline"
    : state.lastError
      ? "dot-error"
      : state.connected
        ? "dot-online"
        : "dot-offline";
  const label = !state.running
    ? "Bridge stopped"
    : state.paused
      ? "Bridge paused"
      : state.connected
        ? "Bridge online"
        : "Connecting to COROS";
  return (
    <div className="bridge-status">
      <span className={`dot ${dot}`} />
      {label}
    </div>
  );
}

function CorosConnectForm({ onConnected }: { onConnected: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [region, setRegion] = useState<"us" | "eu" | "cn">("us");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await desktop.connectCoros(email, password, region);
      setPassword("");
      onConnected();
    } catch (err) {
      setError("Couldn't connect. Check your email, password, and region.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit}>
      <div className="field">
        <label htmlFor="c-email">COROS email</label>
        <input id="c-email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
      </div>
      <div className="field">
        <label htmlFor="c-pass">COROS password</label>
        <input id="c-pass" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        <span className="hint">Stored only in your Mac's Keychain — never sent to the cloud.</span>
      </div>
      <div className="field">
        <label htmlFor="c-region">Region</label>
        <select id="c-region" value={region} onChange={(e) => setRegion(e.target.value as "us" | "eu" | "cn")}>
          <option value="us">Americas</option>
          <option value="eu">Europe</option>
          <option value="cn">Asia / China</option>
        </select>
      </div>
      {error ? <Banner kind="warn">{error}</Banner> : null}
      <button className="btn btn-primary" style={{ width: "100%", marginTop: "0.6rem" }} disabled={busy} type="submit">
        {busy ? "Testing connection…" : "Test connection & save"}
      </button>
    </form>
  );
}

function CloudConnectCard({ state, onChanged }: { state: BridgeState; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const connect = async () => {
    setBusy(true);
    setNote("Opening your browser to approve this Mac…");
    try {
      const res = await desktop.connectCloud(CLOUD_URL);
      if (res.status === "connected") setNote(null);
      else if (res.status === "pending")
        setNote("Approval didn't finish. Make sure you're signed in on the website, then try again.");
      else setNote("The pairing link expired — try connecting again.");
    } catch {
      setNote("Couldn't reach the Run Garden cloud. Check your connection and retry.");
    } finally {
      setBusy(false);
      onChanged();
    }
  };

  if (state.cloudConnected) {
    return (
      <Card title="Run Garden cloud">
        <div className="bridge-status">
          <span className="dot dot-online" />
          Connected — your plan syncs to the website &amp; phone
        </div>
        <p className="faint">
          This Mac pushes your COROS plan up and quietly applies approved schedule moves.
        </p>
      </Card>
    );
  }

  return (
    <Card title="Run Garden cloud">
      <p className="muted" style={{ marginBottom: "0.6rem" }}>
        Link this Mac to your Run Garden account so your COROS plan appears on the website and your
        iPhone, and reschedules sync back to your watch. You'll approve it once in the browser.
      </p>
      <button className="btn btn-primary btn-small" disabled={busy} onClick={connect}>
        {busy ? "Waiting for approval…" : "Connect to Run Garden cloud"}
      </button>
      {note ? (
        <Banner kind="info" >{note}</Banner>
      ) : null}
    </Card>
  );
}

function AmbientCard({ cloudConnected }: { cloudConnected: boolean }) {
  const [enabled, setEnabled] = useState(false);
  const [thresholdMin, setThresholdMin] = useState(10);
  useEffect(() => {
    desktop
      .getIdleAutoshow()
      .then((s) => {
        setEnabled(s.enabled);
        setThresholdMin(Math.max(1, Math.round(s.thresholdSecs / 60)));
      })
      .catch(() => undefined);
  }, []);

  const persist = (nextEnabled: boolean, nextMin: number) => {
    setEnabled(nextEnabled);
    setThresholdMin(nextMin);
    void desktop.setIdleAutoshow(nextEnabled, nextMin * 60).catch(() => undefined);
  };

  return (
    <Card title="Ambient garden">
      <p className="muted" style={{ marginBottom: "0.6rem" }}>
        A full-screen, living view of your garden — leave it up like a screensaver. Press{" "}
        <kbd>Esc</kbd> or click to exit.
      </p>
      <button
        className="btn btn-primary btn-small"
        disabled={!cloudConnected}
        onClick={() => void desktop.showAmbient()}
      >
        Open ambient garden
      </button>
      {!cloudConnected ? (
        <p className="faint" style={{ marginTop: "0.5rem" }}>
          Connect to the Run Garden cloud above to grow the ambient garden.
        </p>
      ) : null}
      <label className="switch-row" style={{ cursor: "pointer", marginTop: "0.8rem" }}>
        <span>Show when I'm idle</span>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => persist(e.target.checked, thresholdMin)}
        />
      </label>
      {enabled ? (
        <div className="field" style={{ marginTop: "0.5rem" }}>
          <label htmlFor="ambient-idle">Idle time before it appears</label>
          <select
            id="ambient-idle"
            value={thresholdMin}
            onChange={(e) => persist(true, Number(e.target.value))}
          >
            <option value={5}>5 minutes</option>
            <option value={10}>10 minutes</option>
            <option value={20}>20 minutes</option>
            <option value={30}>30 minutes</option>
          </select>
        </div>
      ) : null}
    </Card>
  );
}

function ConnectionPanel() {
  const [spikeOpen, setSpikeOpen] = useState(false);
  const [spikeResult, setSpikeResult] = useState<string | null>(null);
  const [launchLogin, setLaunchLogin] = useState(false);
  useEffect(() => {
    desktop.getLaunchAtLogin().then(setLaunchLogin).catch(() => undefined);
  }, []);
  const state = useQuery({
    queryKey: ["bridge-state"],
    queryFn: desktop.bridgeState,
    refetchInterval: 4000,
  });

  const s = state.data;

  return (
    <div className="desktop-panel">
      <h1>{PRODUCT_NAME}</h1>
      {s ? <BridgeStatusRow state={s} /> : null}

      {!s ? null : !s.connected && s.hasSavedCoros && s.lastError !== "saved_signin_failed" ? (
        // Saved credentials exist and the auto sign-in is still running — never
        // flash a login form at someone who is already signed in.
        <Card title="COROS">
          <div className="bridge-status">
            <span className="dot dot-offline" />
            Signing in with your saved COROS credentials…
          </div>
          <p className="faint">This takes a few seconds after launch.</p>
        </Card>
      ) : !s.connected ? (
        <Card title="Connect COROS">
          {s.lastError === "saved_signin_failed" ? (
            <Banner kind="warn">
              Your saved COROS sign-in stopped working — the password may have changed. Sign in
              again below.
            </Banner>
          ) : null}
          <p className="muted" style={{ marginBottom: "0.8rem" }}>
            The desktop companion reads your COROS plan and updates your training calendar. Your
            password never leaves this Mac.
          </p>
          <CorosConnectForm onConnected={() => state.refetch()} />
        </Card>
      ) : (
        <>
          <Card title="COROS">
            <p style={{ fontWeight: 650 }}>{s.activePlanName ?? "Connected"}</p>
            <p className="muted">
              {s.upcomingWorkoutCount} upcoming workout{s.upcomingWorkoutCount === 1 ? "" : "s"} ·{" "}
              {s.capabilities?.updateExistingScheduledWorkout
                ? "Automatic schedule updates supported"
                : "Calendar-only mode"}
            </p>
            {s.lastSnapshotAt ? (
              <p className="faint">Last sync {new Date(s.lastSnapshotAt).toLocaleTimeString()}</p>
            ) : null}
            <div className="btn-row" style={{ marginTop: "0.7rem" }}>
              <button className="btn btn-small" onClick={() => desktop.testConnection()}>
                Test connection
              </button>
              <button
                className="btn btn-small"
                onClick={() => desktop.setPaused(!s.paused).then(() => state.refetch())}
              >
                {s.paused ? "Resume bridge" : "Pause bridge"}
              </button>
            </div>
          </Card>

          <CloudConnectCard state={s} onChanged={() => state.refetch()} />

          <AmbientCard cloudConnected={s.cloudConnected} />

          <Card title="Schedule write test">
            <p className="muted" style={{ marginBottom: "0.6rem" }}>
              Safely moves one upcoming workout by a day and back to prove COROS writes work on your
              account. Nothing else is changed.
            </p>
            <button className="btn btn-small" onClick={() => setSpikeOpen(true)}>
              Run schedule write test
            </button>
          </Card>

          <Card title="Options">
            <label className="switch-row" style={{ cursor: "pointer" }}>
              <span>Launch at login</span>
              <input
                type="checkbox"
                checked={launchLogin}
                onChange={async (e) => {
                  const next = e.target.checked;
                  setLaunchLogin(next);
                  try {
                    await desktop.setLaunchAtLogin(next);
                  } catch {
                    setLaunchLogin(!next);
                  }
                }}
              />
            </label>
            <button
              className="btn btn-small btn-danger"
              style={{ marginTop: "0.6rem" }}
              onClick={() => desktop.eraseCredentials().then(() => state.refetch())}
            >
              Erase COROS credentials
            </button>
          </Card>
        </>
      )}

      <Sheet open={spikeOpen} onClose={() => setSpikeOpen(false)} title="Schedule write test">
        {spikeResult ? (
          <Banner kind="info">{spikeResult}</Banner>
        ) : (
          <div className="stack">
            <p className="muted">
              This performs a real, reversible change on your COROS training calendar: it moves one
              upcoming non-race workout forward by a day, verifies it, then moves it back. A sanitized
              report is saved locally.
            </p>
            <button
              className="btn btn-primary"
              onClick={async () => {
                try {
                  const res = await desktop.runWriteSpike();
                  setSpikeResult(res.summary);
                } catch {
                  setSpikeResult("The write test could not complete. See diagnostics for details.");
                }
              }}
            >
              Run the test
            </button>
          </div>
        )}
      </Sheet>
    </div>
  );
}

export function DesktopApp() {
  // The ambient (screensaver) window loads this same bundle but renders only the
  // full-bleed garden. This branch is deterministic per window, so the early
  // return before hooks is safe.
  if (isAmbientWindow()) {
    return (
      <AmbientGarden
        fetchGarden={desktop.gardenSnapshot}
        onExit={() => void desktop.hideAmbient()}
      />
    );
  }

  const [running, setRunning] = useState(false);
  useEffect(() => {
    setRunning(isDesktop());
  }, []);

  // When not running inside Tauri (e.g. `vite dev` in a browser), just render
  // the web app so the shared UI can be developed without the native shell.
  if (!running) {
    return <WebApp />;
  }

  return (
    <QueryClientProvider client={queryClient}>
      <div className="desktop-root">
        <ConnectionPanel />
        <div className="desktop-hero">
          <div className="desktop-hero-inner">
            <div className="desktop-hero-mark" aria-hidden>
              🌿
            </div>
            <h2>Run Garden lives in your browser</h2>
            <p className="muted">
              This companion runs quietly in your menu bar, keeping your COROS plan in sync and
              applying approved reschedules to your watch. Open the full app — your plan, garden, and
              insights — in your browser, where signing in with Google works.
            </p>
            <button className="btn btn-primary" onClick={() => void desktop.openExternal(CLOUD_URL)}>
              Open Run Garden in your browser
            </button>
            <p className="faint">
              Keep this app running (or turn on “Launch at login”) so reschedules reach your watch.
            </p>
          </div>
        </div>
      </div>
    </QueryClientProvider>
  );
}
