use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use tauri::{Emitter, Manager};

type Pending = Arc<Mutex<HashMap<u64, Sender<Result<Value, String>>>>>;

/// Owns the Node sidecar process and multiplexes JSON-RPC requests over its stdio.
struct Sidecar {
    stdin: Mutex<ChildStdin>,
    pending: Pending,
    next_id: AtomicU64,
    _child: Mutex<Child>,
}

impl Sidecar {
    fn spawn(script: PathBuf, app: tauri::AppHandle) -> Result<Self, String> {
        let mut child = Command::new(node_executable())
            // node:sqlite is stable in behaviour but still flagged experimental; the
            // warning would otherwise be printed on every launch.
            .arg("--no-warnings=ExperimentalWarning")
            .arg(&script)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|e| format!("failed to spawn sidecar {}: {e}", script.display()))?;

        let stdin = child.stdin.take().ok_or("sidecar stdin unavailable")?;
        let stdout = child.stdout.take().ok_or("sidecar stdout unavailable")?;
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));

        // Reader thread resolves in-flight requests by id and forwards notifications.
        let reader_pending = Arc::clone(&pending);
        let reader_app = app.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                let Ok(message) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };

                let Some(id) = message.get("id").and_then(Value::as_u64) else {
                    // Sidecar-initiated notification: re-emit for the frontend.
                    if let Some(method) = message.get("method").and_then(Value::as_str) {
                        let event = match method {
                            "session.event" => "session-event",
                            "session.loaded" => "session-loaded",
                            "sessions.changed" => "sessions-changed",
                            "permission.requested" => "permission-requested",
                            "permission.resolved" => "permission-resolved",
                            _ => continue,
                        };
                        let payload = message.get("params").cloned().unwrap_or(Value::Null);
                        let _ = reader_app.emit(event, payload);
                    }
                    continue;
                };

                if let Some(tx) = reader_pending.lock().unwrap().remove(&id) {
                    let outcome = match message.get("error") {
                        Some(err) => Err(err
                            .get("message")
                            .and_then(Value::as_str)
                            .unwrap_or("sidecar error")
                            .to_string()),
                        None => Ok(message.get("result").cloned().unwrap_or(Value::Null)),
                    };
                    let _ = tx.send(outcome);
                }
            }
        });

        Ok(Self {
            stdin: Mutex::new(stdin),
            pending,
            next_id: AtomicU64::new(1),
            _child: Mutex::new(child),
        })
    }

    fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = channel();
        self.pending.lock().unwrap().insert(id, tx);

        let payload = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        {
            let mut stdin = self.stdin.lock().unwrap();
            writeln!(stdin, "{payload}").map_err(|e| format!("sidecar write failed: {e}"))?;
            stdin
                .flush()
                .map_err(|e| format!("sidecar flush failed: {e}"))?;
        }

        rx.recv()
            .map_err(|_| "sidecar closed before responding".to_string())?
    }
}

fn node_executable() -> String {
    std::env::var("COPILOT_DESKTOP_NODE").unwrap_or_else(|_| "node".to_string())
}

/// Resolve the built sidecar entrypoint, preferring an explicit override.
fn sidecar_script() -> PathBuf {
    if let Ok(path) = std::env::var("COPILOT_DESKTOP_SIDECAR") {
        return PathBuf::from(path);
    }
    // In development the crate sits at <repo>/src-tauri.
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(|root| {
            root.join("sidecar")
                .join("dist")
                .join("sidecar")
                .join("src")
                .join("index.js")
        })
        .unwrap_or_default()
}

#[tauri::command]
async fn sidecar_request(
    app: tauri::AppHandle,
    method: String,
    params: Option<Value>,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let sidecar = app.state::<Sidecar>();
        sidecar.request(&method, params.unwrap_or(Value::Null))
    })
    .await
    .map_err(|e| format!("sidecar task panicked: {e}"))?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            app.manage(Sidecar::spawn(sidecar_script(), app.handle().clone())?);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![sidecar_request])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
