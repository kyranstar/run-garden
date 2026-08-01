/**
 * Thin wrapper over the Tauri command surface implemented in Rust
 * (src-tauri/src/lib.rs). Every COROS-credential operation goes through the
 * Rust core so the password never enters JS/webview state — the frontend only
 * ever sees status booleans and capability reports.
 */

type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

// Resolve Tauri's invoke bridge. `__TAURI__.core.invoke` requires
// `withGlobalTauri` in tauri.conf.json; `__TAURI_INTERNALS__.invoke` is always
// present inside the Tauri webview, so it's the reliable detection signal.
function resolveInvoke(): InvokeFn | null {
  const w = window as unknown as {
    __TAURI__?: { core?: { invoke?: InvokeFn } };
    __TAURI_INTERNALS__?: { invoke?: InvokeFn };
  };
  return w.__TAURI__?.core?.invoke ?? w.__TAURI_INTERNALS__?.invoke ?? null;
}

export const isDesktop = () => resolveInvoke() !== null;

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const fn = resolveInvoke();
  if (!fn) throw new Error("not_running_in_tauri");
  return fn<T>(cmd, args);
}

export interface BridgeState {
  running: boolean;
  paused: boolean;
  connected: boolean;
  deviceId: string | null;
  lastError: string | null;
  lastSnapshotAt: string | null;
  lastJobAt: string | null;
  capabilities: Record<string, boolean> | null;
  activePlanName: string | null;
  upcomingWorkoutCount: number;
  cloudConnected: boolean;
}

export const desktop = {
  /** Current bridge/sidecar status for the connection panel. */
  bridgeState: () => invoke<BridgeState>("bridge_state"),

  /** Store COROS credentials in the OS keychain and test the connection. */
  connectCoros: (email: string, password: string, region: "us" | "eu" | "cn") =>
    invoke<{ connected: boolean; capabilities: Record<string, boolean>; activePlanName: string | null; upcomingWorkoutCount: number }>(
      "connect_coros",
      { email, password, region },
    ),

  testConnection: () => invoke<{ connected: boolean }>("test_connection"),

  /** Erase all COROS credentials + tokens from the keychain. */
  eraseCredentials: () => invoke<void>("erase_credentials"),

  /** Pause/resume the background bridge. */
  setPaused: (paused: boolean) => invoke<void>("set_bridge_paused", { paused }),

  setLaunchAtLogin: (enabled: boolean) => invoke<void>("set_launch_at_login", { enabled }),

  /** Current launch-at-login state, so the toggle reflects reality on open. */
  getLaunchAtLogin: () => invoke<boolean>("get_launch_at_login"),

  /** Open a URL in the default browser (sign-in must happen outside the app). */
  openExternal: (url: string) => invoke<void>("open_external", { url }),

  /**
   * Connect this Mac to the Run Garden cloud (pairs a device on first run,
   * opening the browser to approve; reuses the stored identity afterwards).
   * Resolves when synced, or with status "pending"/"expired" if approval
   * didn't complete in time.
   */
  connectCloud: (apiUrl: string) =>
    invoke<{ status: "connected" | "pending" | "expired"; deviceId?: string }>("connect_cloud", {
      apiUrl,
    }),

  /** Run the reversible schedule write test against the real account. */
  runWriteSpike: () => invoke<{ reportPath: string; ok: boolean; summary: string }>("run_write_spike"),
};
