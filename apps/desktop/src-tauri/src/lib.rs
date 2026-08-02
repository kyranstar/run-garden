//! Run Garden desktop core. Owns the encrypted credential store and the COROS
//! bridge sidecar. The COROS password is read from the store and passed to the
//! sidecar over stdin only; it is never exposed to the webview, cloud, argv,
//! env, or logs.

mod bridge;
mod creds;

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

use bridge::Bridge;
use serde::Serialize;
use serde_json::{json, Value};
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::TrayIconBuilder;
use tauri::{Manager, State};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_updater::UpdaterExt;

/// Open a URL in the user's default browser via the native macOS opener.
/// Deliberately not the shell plugin's `open` (deprecated and unreliable from
/// the app core) — `/usr/bin/open` always works and needs no plugin permission.
fn open_url(url: &str) -> Result<(), String> {
    std::process::Command::new("/usr/bin/open")
        .arg(url)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("open_failed: {e}"))
}

/// Open (or reveal) the borderless fullscreen ambient garden window. Built on
/// demand and torn down on hide so every open shows a freshly-fetched garden.
/// Window creation must happen on the main thread (AppKit requirement), so all
/// work is dispatched there. The `__RG_AMBIENT__` init flag tells the shared
/// web bundle to render the ambient view rather than the connection panel.
fn reveal_ambient(app: &tauri::AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(win) = handle.get_webview_window("ambient") {
            let _ = win.show();
            let _ = win.set_focus();
            let _ = win.set_fullscreen(true);
            return;
        }
        // Built hidden and NOT fullscreen: on macOS, entering native fullscreen
        // while the webview is still initializing races the first paint and can
        // leave a permanently grey window. Show first, then go fullscreen.
        match tauri::WebviewWindowBuilder::new(
            &handle,
            "ambient",
            tauri::WebviewUrl::App("index.html".into()),
        )
        .title("Run Garden")
        .inner_size(1280.0, 800.0)
        .decorations(false)
        .visible(false)
        .skip_taskbar(true)
        .initialization_script("window.__RG_AMBIENT__ = true;")
        .build()
        {
            Ok(win) => {
                tauri::async_runtime::spawn(async move {
                    // Let the webview load and paint its dark backdrop…
                    tokio::time::sleep(std::time::Duration::from_millis(600)).await;
                    let _ = win.show();
                    let _ = win.set_focus();
                    // …then transition to fullscreen with content on screen.
                    tokio::time::sleep(std::time::Duration::from_millis(250)).await;
                    let _ = win.set_fullscreen(true);
                });
            }
            Err(e) => eprintln!("ambient window build failed: {e}"),
        }
    });
}

/// Tear down the ambient window (closes cleanly — the CloseRequested handler
/// only intercepts the main window, so this actually closes).
fn conceal_ambient(app: &tauri::AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(win) = handle.get_webview_window("ambient") {
            let _ = win.close();
        }
    });
}

/// Seconds since the last user input (keyboard/mouse), via CoreGraphics — used
/// only for the opt-in "auto-show ambient garden when idle" feature. The
/// framework is always present on macOS, so no extra dependency is needed.
#[cfg(target_os = "macos")]
fn user_idle_seconds() -> f64 {
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        // CGEventSourceStateID is a signed enum (kCGEventSourceStatePrivate = -1);
        // kCGEventSourceStateCombinedSessionState = 0, kCGAnyInputEventType = 0xFFFFFFFF.
        fn CGEventSourceSecondsSinceLastEventType(state: i32, event_type: u32) -> f64;
    }
    unsafe { CGEventSourceSecondsSinceLastEventType(0, 0xFFFF_FFFF) }
}
#[cfg(not(target_os = "macos"))]
fn user_idle_seconds() -> f64 {
    0.0
}

/// Background poller: when auto-show is on and the Mac has been idle past the
/// threshold, open the ambient garden; when the user returns, hide the copy the
/// poller opened. Cheap (a CoreGraphics read every 15s) and a no-op when off.
async fn idle_watch(
    app: tauri::AppHandle,
    enabled: Arc<AtomicBool>,
    threshold: Arc<AtomicU64>,
    auto_shown: Arc<AtomicBool>,
) {
    loop {
        // 5s so the screensaver both appears promptly and dismisses promptly
        // when you come back (a single CoreGraphics read — effectively free).
        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
        if !enabled.load(Ordering::Relaxed) {
            continue;
        }
        let idle = user_idle_seconds() as u64;
        let threshold = threshold.load(Ordering::Relaxed);
        let open = app.get_webview_window("ambient").is_some();
        if idle >= threshold && !open {
            auto_shown.store(true, Ordering::Relaxed);
            reveal_ambient(&app);
        } else if idle < 5 && open && auto_shown.load(Ordering::Relaxed) {
            auto_shown.store(false, Ordering::Relaxed);
            conceal_ambient(&app);
        }
    }
}

pub struct AppState {
    pub bridge: Bridge,
    /// Ambient garden "auto-show when idle" preference and its threshold, shared
    /// with the background idle poller.
    pub idle_autoshow: Arc<AtomicBool>,
    pub idle_threshold_secs: Arc<AtomicU64>,
    /// True while the ambient window is on screen *because the idle poller
    /// opened it* — so activity auto-hides it, but a window the user opened by
    /// hand stays until they close it.
    pub ambient_auto_shown: Arc<AtomicBool>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeStateDto {
    running: bool,
    paused: bool,
    connected: bool,
    /// COROS credentials exist in the encrypted store — the UI must show
    /// "signing you in" rather than a login form while the resume runs.
    has_saved_coros: bool,
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
    let has_saved_coros =
        creds::get(creds::K_COROS_EMAIL).is_some() && creds::get(creds::K_COROS_PASSWORD).is_some();
    let inner = state.bridge.inner.lock().await;
    Ok(BridgeStateDto {
        running: inner.stdin_is_some(),
        paused: inner.paused,
        connected: inner.connected,
        has_saved_coros,
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

    creds::set(creds::K_COROS_EMAIL, &email)?;
    creds::set(creds::K_COROS_PASSWORD, &password)?;
    creds::set(creds::K_COROS_REGION, &region)?;

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
    creds::erase_all();
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
async fn open_external(_app: tauri::AppHandle, url: String) -> Result<(), String> {
    open_url(&url)
}

/// Connect this Mac to the Run Garden cloud so the plan flows up and schedule
/// moves flow down. On first run it pairs a new device (generates an Ed25519
/// key in the sidecar, registers the public key, opens the browser for the
/// signed-in user to approve, then claims the device id). On later runs it
/// reuses the keychain-stored identity and just starts the sync loop.
#[tauri::command]
async fn connect_cloud(
    _app: tauri::AppHandle,
    state: State<'_, AppState>,
    api_url: String,
) -> Result<Value, String> {
    creds::set(creds::K_CLOUD_URL, &api_url)?;

    // Already paired? Reuse the stored identity and start syncing.
    if let (Some(device_id), Some(pem)) = (
        creds::get(creds::K_DEVICE_ID),
        creds::get(creds::K_DEVICE_PRIVATE_KEY),
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
    creds::set(creds::K_DEVICE_PRIVATE_KEY, private_pem)?;

    // Open the browser so the signed-in user approves this device.
    open_url(approve_url)?;

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
                creds::set(creds::K_DEVICE_ID, device_id)?;
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

/// Fetch the current renderable garden over the device's signed channel, for the
/// ambient window. Errors with "not_connected" if cloud sync isn't running yet;
/// the ambient view treats that as "keep showing the last-good garden".
#[tauri::command]
async fn garden_snapshot(state: State<'_, AppState>) -> Result<Value, String> {
    state.bridge.call("readGarden", None).await
}

/// Open the fullscreen ambient garden (from the "Open ambient garden" button).
/// Marks it user-opened so returning to the keyboard won't auto-hide it.
#[tauri::command]
async fn show_ambient(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    state.ambient_auto_shown.store(false, Ordering::Relaxed);
    reveal_ambient(&app);
    Ok(())
}

/// Close the ambient garden (Esc/click inside it, or the idle poller).
#[tauri::command]
async fn hide_ambient(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    state.ambient_auto_shown.store(false, Ordering::Relaxed);
    conceal_ambient(&app);
    Ok(())
}

#[tauri::command]
async fn set_idle_autoshow(
    state: State<'_, AppState>,
    enabled: bool,
    threshold_secs: u64,
) -> Result<(), String> {
    let threshold = threshold_secs.clamp(30, 3600);
    state.idle_autoshow.store(enabled, Ordering::Relaxed);
    state.idle_threshold_secs.store(threshold, Ordering::Relaxed);
    creds::set(creds::K_IDLE_AUTOSHOW, if enabled { "1" } else { "0" })?;
    creds::set(creds::K_IDLE_THRESHOLD, &threshold.to_string())?;
    Ok(())
}

#[tauri::command]
async fn get_idle_autoshow(state: State<'_, AppState>) -> Result<Value, String> {
    Ok(json!({
        "enabled": state.idle_autoshow.load(Ordering::Relaxed),
        "thresholdSecs": state.idle_threshold_secs.load(Ordering::Relaxed),
    }))
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
        creds::get(creds::K_COROS_EMAIL),
        creds::get(creds::K_COROS_PASSWORD),
        creds::get(creds::K_COROS_REGION),
    ) {
        (Some(e), Some(p), Some(r)) => (e, p, r),
        _ => return,
    };
    if bridge.authenticate(&email, &password, &region).await.is_err() {
        // Surface the failure so the UI stops saying "signing you in" and shows
        // the login form with a clear reason instead of hanging forever.
        let mut inner = bridge.inner.lock().await;
        inner.last_error = Some("saved_signin_failed".into());
        return;
    }
    if let (Some(url), Some(device_id), Some(pem)) = (
        creds::get(creds::K_CLOUD_URL),
        creds::get(creds::K_DEVICE_ID),
        creds::get(creds::K_DEVICE_PRIVATE_KEY),
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

/// Check GitHub releases for a newer signed build and install it silently; the
/// update applies on next launch. Best-effort — any failure is logged and
/// ignored so the app runs normally offline or when no update exists.
async fn check_for_updates(app: &tauri::AppHandle) -> Result<(), String> {
    let updater = app.updater().map_err(|e| e.to_string())?;
    if let Some(update) = updater.check().await.map_err(|e| e.to_string())? {
        update
            .download_and_install(|_downloaded, _total| {}, || {})
            .await
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        // Launch-at-login support (the "Launch at login" toggle drives this).
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        // Self-update from signed GitHub releases (see plugins.updater config).
        .plugin(tauri_plugin_updater::Builder::new().build())
        .on_window_event(|window, event| {
            // Closing the main window doesn't quit: Run Garden keeps running in
            // the menu bar so the COROS bridge keeps syncing. Quit from the tray.
            // The ambient window is exempt — it closes for real.
            if window.label() == "main" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    let _ = window.hide();
                    api.prevent_close();
                }
            }
        })
        .setup(|app| {
            // Menu-bar tray so the app stays reachable while running in the
            // background. Click the icon → menu with Open / Quit.
            let open_item = MenuItemBuilder::with_id("open", "Open Run Garden").build(app)?;
            let ambient_item = MenuItemBuilder::with_id("ambient", "Ambient Garden").build(app)?;
            let quit_item = MenuItemBuilder::with_id("quit", "Quit Run Garden").build(app)?;
            let menu = MenuBuilder::new(app)
                .items(&[&open_item, &ambient_item, &quit_item])
                .build()?;
            let _tray = TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().cloned().ok_or("no default icon")?)
                .tooltip("Run Garden")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "open" => show_main(app),
                    "ambient" => {
                        // Tray-opened counts as user-opened: stays until closed.
                        if let Some(state) = app.try_state::<AppState>() {
                            state.ambient_auto_shown.store(false, Ordering::Relaxed);
                        }
                        reveal_ambient(app);
                    }
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
            // Silently self-update on launch (applies next start).
            let updater_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = check_for_updates(&updater_handle).await {
                    eprintln!("updater: {e}");
                }
            });

            // Ambient-garden idle auto-show: restore the saved preference and run
            // the background poller. ON by default (10-minute threshold) — it's
            // the screensaver; the Ambient card's toggle turns it off.
            let idle_autoshow = Arc::new(AtomicBool::new(
                creds::get(creds::K_IDLE_AUTOSHOW).as_deref().map(|v| v == "1").unwrap_or(true),
            ));
            let idle_threshold_secs = Arc::new(AtomicU64::new(
                creds::get(creds::K_IDLE_THRESHOLD)
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(600),
            ));
            let ambient_auto_shown = Arc::new(AtomicBool::new(false));
            let idle_handle = app.handle().clone();
            let (en, th, shown) = (
                idle_autoshow.clone(),
                idle_threshold_secs.clone(),
                ambient_auto_shown.clone(),
            );
            tauri::async_runtime::spawn(async move {
                idle_watch(idle_handle, en, th, shown).await;
            });

            app.manage(AppState {
                bridge,
                idle_autoshow,
                idle_threshold_secs,
                ambient_auto_shown,
            });
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
            garden_snapshot,
            show_ambient,
            hide_ambient,
            set_idle_autoshow,
            get_idle_autoshow,
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
