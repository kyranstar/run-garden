import { useEffect, useState } from "react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { App as WebApp, Banner, Card, Sheet } from "@rg/ui";
import { PRODUCT_NAME } from "@rg/domain";
import { desktop, isDesktop, type BridgeState } from "./tauri.js";

const queryClient = new QueryClient();

// The cloud URL the desktop app connects to. In a packaged build this is baked
// in via the Tauri config; for dev it points at the local worker.
const CLOUD_URL = import.meta.env.VITE_CLOUD_URL ?? "http://localhost:8787";

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

function ConnectionPanel() {
  const [spikeOpen, setSpikeOpen] = useState(false);
  const [spikeResult, setSpikeResult] = useState<string | null>(null);
  const [launchLogin, setLaunchLogin] = useState(false);
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

      {!s?.connected ? (
        <Card title="Connect COROS">
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
                onChange={(e) => {
                  setLaunchLogin(e.target.checked);
                  void desktop.setLaunchAtLogin(e.target.checked);
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
        <div className="desktop-webview">
          <iframe title="Run Garden" src={CLOUD_URL} />
        </div>
      </div>
    </QueryClientProvider>
  );
}
