//! Run Garden desktop core. Owns the OS keychain and the COROS bridge sidecar.
//! The COROS password is read from the keychain and passed to the sidecar over
//! stdin only; it is never exposed to the webview, cloud, argv, env, or logs.

mod bridge;
mod keychain;

use bridge::Bridge;
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{Manager, State};
use tauri_plugin_shell::ShellExt;

pub struct AppState {
    pub bridge: Bridge,
}

#[derive(Serialize)]
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
async fn set_launch_at_login(_enabled: bool) -> Result<(), String> {
    // Implemented via the tauri-plugin-autostart plugin in packaging; the
    // command exists so the UI has a stable contract.
    Ok(())
}

#[tauri::command]
async fn start_pairing(app: tauri::AppHandle, api_url: String) -> Result<Value, String> {
    keychain::set(keychain::K_CLOUD_URL, &api_url)?;
    // The device keypair + handshake are created by the sidecar's cloud-sync;
    // here we open the approval URL in the system browser.
    let approve = format!("{api_url}/welcome");
    app.shell()
        .open(&approve, None)
        .map_err(|e| format!("open_browser_failed: {e}"))?;
    Ok(json!({ "handshakeId": "" }))
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let bridge = Bridge::new();
            // Resolve and start the packaged sidecar; on failure the app still
            // runs in calendar-only mode (surfaced via bridge_state).
            let sidecar = app
                .shell()
                .sidecar("coros-bridge")
                .ok()
                .and_then(|c| c.into_command().get_program().to_str().map(std::path::PathBuf::from));
            let bridge_for_setup = bridge.clone();
            if let Some(path) = sidecar {
                tauri::async_runtime::spawn(async move {
                    let _ = bridge_for_setup.start(path).await;
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
            start_pairing,
            run_write_spike,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Run Garden");
}
