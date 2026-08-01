//! Run Garden desktop core. Owns the OS keychain and the COROS bridge sidecar.
//! The COROS password is read from the keychain and passed to the sidecar over
//! stdin only; it is never exposed to the webview, cloud, argv, env, or logs.

mod bridge;
mod keychain;

use bridge::Bridge;
use serde::Serialize;
use serde_json::{json, Value};
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::TrayIconBuilder;
use tauri::{Manager, State};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_shell::ShellExt;

pub struct AppState {
    pub bridge: Bridge,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeStateDto {
    running: bool,
    paused: bool,
    connected: bool,
    device_id: Option<String>,
    last_error: Option<String>,
    last_snapshot_at: Option<String>,
    last_job_at: Option<String>,
    capabilities: Option<Value>,
    active_plan_name: Option<String>,
    upcoming_workout_count: u32,
    cloud_connected: bool,
}

#[tauri::command]
async fn bridge_state(state: State<'_, AppState>) -> Result<BridgeStateDto, String> {
    let inner = state.bridge.inner.lock().await;
    Ok(BridgeStateDto {
        running: inner.stdin_is_some(),
        paused: inner.paused,
        connected: inner.connected,
        device_id: inner.device_id.clone(),
        last_error: inner.last_error.clone(),
        last_snapshot_at: inner.last_snapshot_at.clone(),
        last_job_at: inner.last_job_at.clone(),
        capabilities: inner.capabilities.clone(),
        active_plan_name: inner.active_plan_name.clone(),
        upcoming_workout_count: inner.upcoming_workout_count,
        cloud_connected: inner.cloud_connected,
    })
}

#[tauri::command]
async fn connect_coros(
    state: State<'_, AppState>,
    email: String,
    password: String,
    region: String,
) -> Result<Value, String> {
    // Test the connection first; only persist on success.
    let result = state.bridge.authenticate(&email, &password, &region).await?;

    keychain::set(keychain::K_COROS_EMAIL, &email)?;
    keychain::set(keychain::K_COROS_PASSWORD, &password)?;
    keychain::set(keychain::K_COROS_REGION, &region)?;

    // Read an initial snapshot to populate plan name / upcoming count.
    if let Ok(snapshot) = state
        .bridge
        .call("readSnapshot", Some(json!({ "rangeStart": "", "rangeEnd": "" })))
        .await
    {
        let mut inner = state.bridge.inner.lock().await;
        inner.active_plan_name = snapshot
            .get("plan")
            .and_then(|p| p.get("name"))
            .and_then(|n| n.as_str())
            .map(|s| s.to_string());
        inner.upcoming_workout_count = snapshot
            .get("workouts")
            .and_then(|w| w.as_array())
            .map(|a| a.len() as u32)
            .unwrap_or(0);
    }

    let inner = state.bridge.inner.lock().await;
    Ok(json!({
        "connected": true,
        "capabilities": result.get("capabilities").cloned().unwrap_or(Value::Null),
        "activePlanName": inner.active_plan_name,
        "upcomingWorkoutCount": inner.upcoming_workout_count,
    }))
}

#[tauri::command]
async fn test_connection(state: State<'_, AppState>) -> Result<Value, String> {
    let res = state.bridge.call("testConnection", None).await?;
    Ok(json!({ "connected": res.get("connected").and_then(|v| v.as_bool()).unwrap_or(false) }))
}

#[tauri::command]
async fn erase_credentials(state: State<'_, AppState>) -> Result<(), String> {
    keychain::erase_all();
    state.bridge.erase().await
}

#[tauri::command]
async fn set_bridge_paused(state: State<'_, AppState>, paused: bool) -> Result<(), String> {
    let mut inner = state.bridge.inner.lock().await;
    inner.paused = paused;
    Ok(())
}

#[tauri::command]
async fn set_launch_at_login(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    let mgr = app.autolaunch();
    if enabled {
        mgr.enable().map_err(|e| format!("autostart_enable_failed: {e}"))
    } else {
        mgr.disable().map_err(|e| format!("autostart_disable_failed: {e}"))
    }
}

#[tauri::command]
async fn get_launch_at_login(app: tauri::AppHandle) -> Result<bool, String> {
    app.autolaunch()
        .is_enabled()
        .map_err(|e| format!("autostart_query_failed: {e}"))
}

/// Open a URL in the user's default browser. Used so the full web app (where
/// Google sign-in works) opens outside the app window — Google refuses to render
/// its sign-in inside an embedded web view.
#[tauri::command]
async fn open_external(app: tauri::AppHandle, url: String) -> Result<(), String> {
    app.shell()
        .open(url, None)
        .map_err(|e| format!("open_failed: {e}"))
}

/// Connect this Mac to the Run Garden cloud so the plan flows up and schedule
/// moves flow down. On first run it pairs a new device (generates an Ed25519
/// key in the sidecar, registers the public key, opens the browser for the
/// signed-in user to approve, then claims the device id). On later runs it
/// reuses the keychain-stored identity and just starts the sync loop.
#[tauri::command]
async fn connect_cloud(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    api_url: String,
) -> Result<Value, String> {
    keychain::set(keychain::K_CLOUD_URL, &api_url)?;

    // Already paired? Reuse the stored identity and start syncing.
    if let (Some(device_id), Some(pem)) = (
        keychain::get(keychain::K_DEVICE_ID),
        keychain::get(keychain::K_DEVICE_PRIVATE_KEY),
    ) {
        state
            .bridge
            .call(
                "startCloudSync",
                Some(json!({ "apiUrl": api_url, "deviceId": device_id, "privateKeyPem": pem })),
            )
            .await?;
        {
            let mut inner = state.bridge.inner.lock().await;
            inner.device_id = Some(device_id.clone());
            inner.cloud_connected = true;
        }
        return Ok(json!({ "status": "connected", "deviceId": device_id }));
    }

    // First-time pairing: register a fresh device identity.
    let pair = state
        .bridge
        .call("pairDevice", Some(json!({ "apiUrl": api_url, "appVersion": "0.1.0" })))
        .await?;
    let handshake_id = pair.get("handshakeId").and_then(|v| v.as_str()).ok_or("no_handshake_id")?;
    let approve_url = pair.get("approveUrl").and_then(|v| v.as_str()).ok_or("no_approve_url")?;
    let private_pem = pair.get("privateKeyPem").and_then(|v| v.as_str()).ok_or("no_private_key")?;

    // Persist the private key immediately (it never leaves the keychain).
    keychain::set(keychain::K_DEVICE_PRIVATE_KEY, private_pem)?;

    // Open the browser so the signed-in user approves this device.
    app.shell()
        .open(approve_url, None)
        .map_err(|e| format!("open_browser_failed: {e}"))?;

    // Poll for approval + claim (up to ~3 minutes).
    for _ in 0..36 {
        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
        let claim = state
            .bridge
            .call("claimDevice", Some(json!({ "apiUrl": api_url, "handshakeId": handshake_id })))
            .await?;
        match claim.get("status").and_then(|v| v.as_str()) {
            Some("claimed") => {
                let device_id = claim.get("deviceId").and_then(|v| v.as_str()).ok_or("no_device_id")?;
                keychain::set(keychain::K_DEVICE_ID, device_id)?;
                state
                    .bridge
                    .call(
                        "startCloudSync",
                        Some(json!({ "apiUrl": api_url, "deviceId": device_id, "privateKeyPem": private_pem })),
                    )
                    .await?;
                {
                    let mut inner = state.bridge.inner.lock().await;
                    inner.device_id = Some(device_id.to_string());
                    inner.cloud_connected = true;
                }
                return Ok(json!({ "status": "connected", "deviceId": device_id }));
            }
            Some("expired") => return Ok(json!({ "status": "expired" })),
            _ => continue,
        }
    }
    Ok(json!({ "status": "pending" }))
}

#[tauri::command]
async fn run_write_spike(state: State<'_, AppState>) -> Result<Value, String> {
    let res = state.bridge.call("runWriteSpike", None).await?;
    Ok(res)
}

trait InnerExt {
    fn stdin_is_some(&self) -> bool;
}
impl InnerExt for bridge::BridgeInner {
    fn stdin_is_some(&self) -> bool {
        self.connected || self.capabilities.is_some()
    }
}

/// On launch, restore a previous session from the keychain: authenticate to
/// COROS and restart the cloud-sync loop. Best-effort — failures leave the app
/// waiting for a manual reconnect (surfaced via bridge_state).
async fn resume_from_keychain(bridge: &Bridge) {
    let (email, password, region) = match (
        keychain::get(keychain::K_COROS_EMAIL),
        keychain::get(keychain::K_COROS_PASSWORD),
        keychain::get(keychain::K_COROS_REGION),
    ) {
        (Some(e), Some(p), Some(r)) => (e, p, r),
        _ => return,
    };
    if bridge.authenticate(&email, &password, &region).await.is_err() {
        return;
    }
    if let (Some(url), Some(device_id), Some(pem)) = (
        keychain::get(keychain::K_CLOUD_URL),
        keychain::get(keychain::K_DEVICE_ID),
        keychain::get(keychain::K_DEVICE_PRIVATE_KEY),
    ) {
        let _ = bridge
            .call(
                "startCloudSync",
                Some(json!({ "apiUrl": url, "deviceId": device_id, "privateKeyPem": pem })),
            )
            .await;
        let mut inner = bridge.inner.lock().await;
        inner.device_id = Some(device_id);
        inner.cloud_connected = true;
    }
}

/// Reveal and focus the main window (from the tray menu or a dock-icon click).
fn show_main(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        // Launch-at-login support (the "Launch at login" toggle drives this).
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        .on_window_event(|window, event| {
            // Closing the window doesn't quit: Run Garden keeps running in the
            // menu bar so the COROS bridge keeps syncing. Quit from the tray.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .setup(|app| {
            // Menu-bar tray so the app stays reachable while running in the
            // background. Click the icon → menu with Open / Quit.
            let open_item = MenuItemBuilder::with_id("open", "Open Run Garden").build(app)?;
            let quit_item = MenuItemBuilder::with_id("quit", "Quit Run Garden").build(app)?;
            let menu = MenuBuilder::new(app).items(&[&open_item, &quit_item]).build()?;
            let _tray = TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().cloned().ok_or("no default icon")?)
                .tooltip("Run Garden")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "open" => show_main(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            let bridge = Bridge::new();
            // Resolve the packaged sidecar next to the app executable (Tauri
            // bundles externalBin into the same dir, with the target-triple
            // suffix stripped). On failure the app still runs in calendar-only
            // mode (surfaced via bridge_state).
            let suffix = if cfg!(windows) { ".exe" } else { "" };
            let sidecar = std::env::current_exe().ok().and_then(|exe| {
                exe.parent()
                    .map(|dir| dir.join(format!("coros-bridge{suffix}")))
                    .filter(|p| p.exists())
            });
            let bridge_for_setup = bridge.clone();
            if let Some(path) = sidecar {
                tauri::async_runtime::spawn(async move {
                    if bridge_for_setup.start(path).await.is_err() {
                        return;
                    }
                    // Auto-resume: if COROS + device credentials are already in
                    // the keychain, sign in and restart the cloud-sync loop so
                    // the plan keeps flowing without the user re-connecting.
                    resume_from_keychain(&bridge_for_setup).await;
                });
            }
            app.manage(AppState { bridge });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            bridge_state,
            connect_coros,
            test_connection,
            erase_credentials,
            set_bridge_paused,
            set_launch_at_login,
            get_launch_at_login,
            open_external,
            connect_cloud,
            run_write_spike,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Run Garden")
        .run(|app, event| {
            // Clicking the dock icon with no open window re-reveals it.
            if let tauri::RunEvent::Reopen { .. } = event {
                show_main(app);
            }
        });
}
