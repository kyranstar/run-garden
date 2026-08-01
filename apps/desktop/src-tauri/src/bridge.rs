//! Bridge sidecar supervisor: spawns the packaged NDJSON COROS bridge as a
//! child process, forwards requests over stdin, reads responses over stdout,
//! and keeps them correlated by request id. Credentials are read from the OS
//! keychain here and handed to the sidecar over stdin only — never via env,
//! argv, config files, or logs.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin};
use tokio::sync::{oneshot, Mutex};

#[derive(Default)]
pub struct BridgeInner {
    child: Option<Child>,
    stdin: Option<ChildStdin>,
    pending: HashMap<String, oneshot::Sender<Result<Value, String>>>,
    pub connected: bool,
    pub paused: bool,
    pub last_error: Option<String>,
    pub last_snapshot_at: Option<String>,
    pub last_job_at: Option<String>,
    pub capabilities: Option<Value>,
    pub active_plan_name: Option<String>,
    pub upcoming_workout_count: u32,
    pub device_id: Option<String>,
    pub cloud_connected: bool,
}

#[derive(Clone)]
pub struct Bridge {
    pub inner: Arc<Mutex<BridgeInner>>,
}

#[derive(Serialize)]
struct BridgeRequest<'a> {
    id: String,
    op: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    params: Option<Value>,
}

#[derive(Deserialize)]
struct BridgeResponse {
    id: String,
    ok: bool,
    #[serde(default)]
    result: Value,
    #[serde(default)]
    error: Value,
}

impl Bridge {
    pub fn new() -> Self {
        Bridge {
            inner: Arc::new(Mutex::new(BridgeInner::default())),
        }
    }

    /// Start the sidecar process. `program` is the resolved sidecar path
    /// (Tauri resolves the platform-suffixed external binary).
    pub async fn start(&self, program: std::path::PathBuf) -> Result<(), String> {
        let mut cmd = tokio::process::Command::new(program);
        cmd.stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::inherit());
        let mut child = cmd.spawn().map_err(|e| format!("spawn_failed: {e}"))?;

        let stdin = child.stdin.take().ok_or("no_stdin")?;
        let stdout = child.stdout.take().ok_or("no_stdout")?;

        {
            let mut inner = self.inner.lock().await;
            inner.stdin = Some(stdin);
            inner.child = Some(child);
        }

        // Reader task: dispatch responses to their waiting callers.
        let inner_arc = self.inner.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if line.trim().is_empty() {
                    continue;
                }
                if let Ok(resp) = serde_json::from_str::<BridgeResponse>(&line) {
                    let mut inner = inner_arc.lock().await;
                    if let Some(tx) = inner.pending.remove(&resp.id) {
                        let payload = if resp.ok {
                            Ok(resp.result)
                        } else {
                            Err(resp
                                .error
                                .get("message")
                                .and_then(|m| m.as_str())
                                .unwrap_or("bridge_error")
                                .to_string())
                        };
                        let _ = tx.send(payload);
                    }
                }
            }
        });

        Ok(())
    }

    /// Send a request and await its correlated response.
    pub async fn call(&self, op: &str, params: Option<Value>) -> Result<Value, String> {
        let id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel();
        let payload = {
            let mut inner = self.inner.lock().await;
            inner.pending.insert(id.clone(), tx);
            let req = BridgeRequest { id: id.clone(), op, params };
            let mut line = serde_json::to_string(&req).map_err(|e| e.to_string())?;
            line.push('\n');
            if let Some(stdin) = inner.stdin.as_mut() {
                stdin
                    .write_all(line.as_bytes())
                    .await
                    .map_err(|e| format!("write_failed: {e}"))?;
                stdin.flush().await.ok();
            } else {
                inner.pending.remove(&id);
                return Err("bridge_not_running".into());
            }
        };
        let _ = payload;

        match tokio::time::timeout(std::time::Duration::from_secs(60), rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err("bridge_channel_closed".into()),
            Err(_) => {
                self.inner.lock().await.pending.remove(&id);
                Err("bridge_timeout".into())
            }
        }
    }

    pub async fn authenticate(
        &self,
        email: &str,
        password: &str,
        region: &str,
    ) -> Result<Value, String> {
        let res = self
            .call(
                "authenticate",
                Some(json!({ "email": email, "password": password, "region": region })),
            )
            .await?;
        let mut inner = self.inner.lock().await;
        inner.connected = true;
        inner.capabilities = res.get("capabilities").cloned();
        Ok(res)
    }

    pub async fn erase(&self) -> Result<(), String> {
        self.call("eraseCredentials", None).await.ok();
        let mut inner = self.inner.lock().await;
        inner.connected = false;
        inner.capabilities = None;
        inner.active_plan_name = None;
        inner.upcoming_workout_count = 0;
        Ok(())
    }
}
