use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use tauri::{Emitter, Manager};

type Pending = Arc<Mutex<HashMap<u64, Sender<Result<Value, String>>>>>;

/// Told to every request still waiting when the sidecar goes away.
const SIDECAR_STOPPED: &str = "the runtime stopped; restart the app";

/**
 * Answer every waiting request, so none of them waits on a reply that cannot arrive.
 *
 * A request holds the receiving half of a channel whose sender lives in this map. Leaving
 * the sender here keeps the channel open, and the caller blocks on it for as long as the
 * app runs: a failure that shows as nothing happening at all.
 */
fn fail_all(pending: &Pending, message: &str) {
    let waiting = std::mem::take(&mut *pending.lock().unwrap());
    for (_, tx) in waiting {
        let _ = tx.send(Err(message.to_string()));
    }
}

/// Owns the Node sidecar process and multiplexes JSON-RPC requests over its stdio.
struct Sidecar {
    stdin: Mutex<ChildStdin>,
    pending: Pending,
    next_id: AtomicU64,
    /// Set once the sidecar's output ends, so later requests fail rather than block.
    stopped: Arc<AtomicBool>,
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
        let stopped = Arc::new(AtomicBool::new(false));

        // Reader thread resolves in-flight requests by id and forwards notifications.
        let reader_pending = Arc::clone(&pending);
        let reader_stopped = Arc::clone(&stopped);
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
                            "elicitation.requested" => "elicitation-requested",
                            "elicitation.resolved" => "elicitation-resolved",
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

            // Output ended, so the sidecar is gone and nothing else will ever answer.
            // Without this the app carries on looking busy and never says otherwise.
            reader_stopped.store(true, Ordering::Relaxed);
            fail_all(&reader_pending, SIDECAR_STOPPED);
            let _ = reader_app.emit("sidecar-stopped", SIDECAR_STOPPED);
        });

        Ok(Self {
            stdin: Mutex::new(stdin),
            pending,
            next_id: AtomicU64::new(1),
            stopped,
            _child: Mutex::new(child),
        })
    }

    fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        if self.stopped.load(Ordering::Relaxed) {
            return Err(SIDECAR_STOPPED.to_string());
        }

        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = channel();
        self.pending.lock().unwrap().insert(id, tx);

        // The sidecar can stop between the check above and this line, in which case the
        // sweep that answers waiting requests has already run and would miss this one.
        if self.stopped.load(Ordering::Relaxed) {
            self.pending.lock().unwrap().remove(&id);
            return Err(SIDECAR_STOPPED.to_string());
        }

        let payload = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        let written = {
            let mut stdin = self.stdin.lock().unwrap();
            writeln!(stdin, "{payload}")
                .and_then(|()| stdin.flush())
                .map_err(|e| format!("sidecar write failed: {e}"))
        };

        // Nothing was sent, so nothing will answer: take the entry back rather than
        // leaving it for a reply that was never asked for.
        if let Err(error) = written {
            self.pending.lock().unwrap().remove(&id);
            return Err(error);
        }

        rx.recv().map_err(|_| SIDECAR_STOPPED.to_string())?
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn waiting_requests_are_answered_when_the_sidecar_stops() {
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let (tx, rx) = channel();
        pending.lock().unwrap().insert(1, tx);

        fail_all(&pending, SIDECAR_STOPPED);

        // Without this the caller blocks on a reply that can never arrive.
        assert_eq!(rx.recv().unwrap(), Err(SIDECAR_STOPPED.to_string()));
        assert!(pending.lock().unwrap().is_empty());
    }

    #[test]
    fn every_waiting_request_is_answered_not_just_the_first() {
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let receivers: Vec<_> = (1..=5)
            .map(|id| {
                let (tx, rx) = channel();
                pending.lock().unwrap().insert(id, tx);
                rx
            })
            .collect();

        fail_all(&pending, SIDECAR_STOPPED);

        for rx in receivers {
            assert!(rx.recv().unwrap().is_err());
        }
    }

    #[test]
    fn sweeping_an_idle_sidecar_is_harmless() {
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        fail_all(&pending, SIDECAR_STOPPED);
        assert!(pending.lock().unwrap().is_empty());
    }
}
