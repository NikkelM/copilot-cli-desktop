use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::{Emitter, Manager};

type Pending = Arc<Mutex<HashMap<u64, Sender<Result<Value, String>>>>>;
/// The pipe to the sidecar in use, absent while one is being replaced.
type Link = Arc<Mutex<Option<ChildStdin>>>;

/// Told to every request still waiting when the sidecar goes away.
const SIDECAR_STOPPED: &str = "the runtime stopped; restart the app";
/// Told to a request that arrives while a replacement is starting.
const SIDECAR_RESTARTING: &str = "the runtime is restarting; try again";

/// How many times to replace a sidecar that dies before concluding it will not stay up.
const MAX_RESTARTS: u32 = 3;
/// A sidecar that ran at least this long was working, so its death does not count towards
/// the limit. Only a sidecar dying repeatedly and quickly is a loop worth stopping.
const HEALTHY: Duration = Duration::from_secs(30);

/**
 * Whether to start another sidecar after one has died, and which attempt it would be.
 *
 * Replacing one that dies at once, over and over, only hides the reason it will not run.
 * Replacing one that had been working for a while is worth doing however often it happens,
 * so time spent running resets the count rather than adding to it.
 */
fn next_attempt(attempt: u32, ran_for: Duration) -> Option<u32> {
    let attempt = if ran_for >= HEALTHY { 0 } else { attempt };
    (attempt < MAX_RESTARTS).then_some(attempt + 1)
}

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

/// Everything a sidecar needs to be replaced by another, kept together so the reader
/// thread can start its own successor.
#[derive(Clone)]
struct Supervisor {
    script: PathBuf,
    app: tauri::AppHandle,
    pending: Pending,
    link: Link,
    stopped: Arc<AtomicBool>,
}

impl Supervisor {
    /**
     * Start a sidecar and read from it until it goes, then start another.
     *
     * Little is lost by replacing one: it holds only which sessions are resumed and which
     * requests are outstanding, and both die with it either way. History is on disk, and
     * a session resumes on the next message regardless.
     */
    fn start(&self, attempt: u32) -> Result<(), String> {
        let mut child = Command::new(node_executable())
            // node:sqlite is stable in behaviour but still flagged experimental; the
            // warning would otherwise be printed on every launch.
            .arg("--no-warnings=ExperimentalWarning")
            .arg(&self.script)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|e| format!("failed to spawn sidecar {}: {e}", self.script.display()))?;

        let stdin = child.stdin.take().ok_or("sidecar stdin unavailable")?;
        let stdout = child.stdout.take().ok_or("sidecar stdout unavailable")?;
        *self.link.lock().unwrap() = Some(stdin);

        let supervisor = self.clone();
        std::thread::spawn(move || {
            let started = Instant::now();
            supervisor.read(stdout);

            // Nothing can be sent until a replacement is up, and everything already sent
            // is owed an answer this sidecar will never give.
            *supervisor.link.lock().unwrap() = None;
            let _ = child.kill();
            fail_all(&supervisor.pending, SIDECAR_RESTARTING);

            let restarted = match next_attempt(attempt, started.elapsed()) {
                Some(next) => supervisor.start(next).is_ok(),
                None => false,
            };

            if restarted {
                let _ = supervisor.app.emit("sidecar-restarted", ());
            } else {
                supervisor.stopped.store(true, Ordering::Relaxed);
                fail_all(&supervisor.pending, SIDECAR_STOPPED);
                let _ = supervisor.app.emit("sidecar-stopped", SIDECAR_STOPPED);
            }
        });

        Ok(())
    }

    /// Resolve replies by id and forward notifications, until the sidecar's output ends.
    fn read(&self, stdout: std::process::ChildStdout) {
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
                    let _ = self.app.emit(event, payload);
                }
                continue;
            };

            if let Some(tx) = self.pending.lock().unwrap().remove(&id) {
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
    }
}

/// Owns the Node sidecar process and multiplexes JSON-RPC requests over its stdio.
struct Sidecar {
    pending: Pending,
    next_id: AtomicU64,
    link: Link,
    /// Set once no sidecar will be started again, so later requests fail rather than block.
    stopped: Arc<AtomicBool>,
}

impl Sidecar {
    fn spawn(script: PathBuf, app: tauri::AppHandle) -> Result<Self, String> {
        let supervisor = Supervisor {
            script,
            app,
            pending: Arc::new(Mutex::new(HashMap::new())),
            link: Arc::new(Mutex::new(None)),
            stopped: Arc::new(AtomicBool::new(false)),
        };
        supervisor.start(0)?;

        Ok(Self {
            pending: Arc::clone(&supervisor.pending),
            next_id: AtomicU64::new(1),
            link: Arc::clone(&supervisor.link),
            stopped: Arc::clone(&supervisor.stopped),
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
            let mut link = self.link.lock().unwrap();
            match link.as_mut() {
                Some(stdin) => writeln!(stdin, "{payload}")
                    .and_then(|()| stdin.flush())
                    .map_err(|e| format!("sidecar write failed: {e}")),
                // Between one sidecar dying and its replacement being up. Rare, brief,
                // and better reported than queued against a pipe that may never open.
                None => Err(SIDECAR_RESTARTING.to_string()),
            }
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
        .plugin(tauri_plugin_dialog::init())
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

    const INSTANTLY: Duration = Duration::from_millis(50);

    #[test]
    fn a_sidecar_that_dies_at_once_is_replaced_a_few_times_then_left() {
        let mut attempt = 0;
        let mut starts = 0;

        while let Some(next) = next_attempt(attempt, INSTANTLY) {
            attempt = next;
            starts += 1;
        }

        assert_eq!(starts, MAX_RESTARTS, "should stop rather than loop");
    }

    // Otherwise a long-lived app would use up its restarts on unrelated failures and
    // eventually stop replacing a sidecar that had been running for hours.
    #[test]
    fn a_sidecar_that_had_been_running_is_always_replaced() {
        let worked_for = HEALTHY + Duration::from_secs(1);

        assert_eq!(next_attempt(0, worked_for), Some(1));
        assert_eq!(next_attempt(MAX_RESTARTS, worked_for), Some(1));
        assert_eq!(next_attempt(MAX_RESTARTS * 10, worked_for), Some(1));
    }

    #[test]
    fn a_death_just_short_of_healthy_still_counts() {
        assert_eq!(
            next_attempt(MAX_RESTARTS, HEALTHY - Duration::from_millis(1)),
            None
        );
    }
}
