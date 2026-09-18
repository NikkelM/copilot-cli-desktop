use std::collections::HashMap;
use std::fs::{create_dir_all, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::{Emitter, Manager};

/// Where anything worth reading after the fact is written, once the app knows where that is.
static LOG: OnceLock<Mutex<Option<File>>> = OnceLock::new();

/**
 * Record a line, to the log file and to stdout.
 *
 * An installed app has no console: `stderr(Stdio::inherit())` sent the sidecar's own
 * diagnostics nowhere, so a sidecar that died on startup left no trace of why. Everything
 * that could explain a failure now goes to a file next to the app's data.
 *
 * Printing as well is a convenience for `tauri dev`, and it must stay one. `println!` panics
 * when the pipe it writes to has closed, which happens whenever the terminal running the dev
 * server goes away first - and the task that panicked was the one reading the sidecar's
 * output, so a closed pipe stopped the app logging anything at all. The file is the record;
 * a failure to echo it is not worth a line, let alone a task.
 */
fn log(line: &str) {
    let stamped = format!(
        "{} {line}",
        chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f")
    );
    let _ = writeln!(std::io::stdout(), "{stamped}");

    if let Some(handle) = LOG.get() {
        if let Ok(mut file) = handle.lock() {
            if let Some(file) = file.as_mut() {
                let _ = writeln!(file, "{stamped}");
                let _ = file.flush();
            }
        }
    }
}

/// Open the log file for this run, appending to whatever previous runs left.
fn open_log(app: &tauri::AppHandle) {
    let Ok(dir) = app.path().app_log_dir() else {
        return;
    };
    if create_dir_all(&dir).is_err() {
        return;
    }

    let file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("copilot-cli-desktop.log"))
        .ok();

    let opened = file.is_some();
    let _ = LOG.set(Mutex::new(file));
    if opened {
        log(&format!("--- started, logging to {} ---", dir.display()));
    }
}

type Pending = Arc<Mutex<HashMap<u64, Sender<Result<Value, String>>>>>;
/// The pipe to the sidecar in use, absent while one is being replaced.
type Link = Arc<Mutex<Option<ChildStdin>>>;

/// Told to every request still waiting when the sidecar goes away.
const SIDECAR_STOPPED: &str = "the runtime stopped; restart the app";
/// Told to a request that arrives while a replacement is starting.
const SIDECAR_RESTARTING: &str = "the runtime is restarting; try again";
/// Told to a request the sidecar never answered.
const SIDECAR_SILENT: &str = "the runtime did not answer; it may still be working";

/**
 * How long to wait for a reply before giving up on it.
 *
 * A sidecar that dies answers everything waiting, so this is not about a runtime that goes
 * away - it is about one that stays up and loses a request. That should not happen, and
 * every path in the sidecar is meant to answer, but the cost of being wrong is a caller
 * blocked for as long as the app runs, on a channel nothing will ever send to: a spinner
 * that never stops and no way back short of a restart.
 *
 * Deliberately far longer than any request should take, because its job is to break a hang
 * rather than to enforce a deadline. The slowest by a distance is the first message to a
 * cold session, which starts a Copilot process and replays the conversation into it; that
 * is seconds, not minutes. Anything past this is a bug, and saying so beats waiting.
 */
const REQUEST_TIMEOUT: Duration = Duration::from_secs(300);

/**
 * Wait for a reply, or conclude that none is coming.
 *
 * Split out from the request itself so both endings can be tested: a channel that answers,
 * and one that never does. `RecvTimeoutError` does not distinguish a sender that hung up
 * from one that is merely slow, so the two are told apart here - a dropped sender means the
 * sidecar went away, which is the sweep having already run.
 */
fn await_reply(
    rx: &std::sync::mpsc::Receiver<Result<Value, String>>,
    timeout: Duration,
) -> Result<Value, String> {
    use std::sync::mpsc::RecvTimeoutError;
    match rx.recv_timeout(timeout) {
        Ok(reply) => reply,
        Err(RecvTimeoutError::Timeout) => Err(SIDECAR_SILENT.to_string()),
        Err(RecvTimeoutError::Disconnected) => Err(SIDECAR_STOPPED.to_string()),
    }
}

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
    /// Shared and re-read on every start, so a replacement can be pointed somewhere else
    /// than the one before it - which is how a rebuilt sidecar gets to run (#169).
    script: Arc<Mutex<PathBuf>>,
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
        let node = node_executable();
        let script = self.script.lock().unwrap().clone();
        log(&format!(
            "starting sidecar (attempt {attempt}): {node} {}",
            script.display()
        ));

        let mut command = Command::new(&node);
        command
            // Node 24, which package.json asks for, loads node:sqlite quietly. This is kept
            // because the app runs on whatever node is installed, and 22 warns on every launch.
            .arg("--no-warnings=ExperimentalWarning")
            .arg(&script)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            // Piped rather than inherited: an installed app has no console to inherit, so
            // everything the sidecar said about why it was failing went nowhere.
            .stderr(Stdio::piped());

        // Without this every sidecar start flashes a console window on Windows, and a
        // sidecar that dies and is replaced flashes one per attempt - which looks like the
        // app is doing something furtive rather than starting a helper it owns.
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }

        let mut child = command.spawn().map_err(|e| {
            let message = format!("failed to spawn sidecar: {node} {}: {e}", script.display());
            log(&message);
            message
        })?;

        let stdin = child.stdin.take().ok_or("sidecar stdin unavailable")?;
        let stdout = child.stdout.take().ok_or("sidecar stdout unavailable")?;

        // Its own thread, because the sidecar can fill this pipe while nothing is reading
        // stdout - and a full pipe would block the process that is trying to explain itself.
        if let Some(stderr) = child.stderr.take() {
            std::thread::spawn(move || {
                for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                    // The sidecar labels its own lines, for when it is run on its own. Only
                    // the ones it did not label - a Node stack trace, say - need labelling
                    // here, and doubling the label on the rest reads as a bug.
                    log(&format!(
                        "[sidecar] {}",
                        line.strip_prefix("[sidecar] ").unwrap_or(&line)
                    ));
                }
            });
        }
        *self.link.lock().unwrap() = Some(stdin);

        let supervisor = self.clone();
        std::thread::spawn(move || {
            let started = Instant::now();
            supervisor.read(stdout);
            log(&format!(
                "sidecar output ended after {:?} (attempt {attempt})",
                started.elapsed()
            ));

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
                log("sidecar stopped and will not be replaced");
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
                        "session.changes" => "session-changes",
                        "sessions.changed" => "sessions-changed",
                        "permission.requested" => "permission-requested",
                        "permission.resolved" => "permission-resolved",
                        "elicitation.requested" => "elicitation-requested",
                        "elicitation.resolved" => "elicitation-resolved",
                        "plan.requested" => "plan-requested",
                        "plan.resolved" => "plan-resolved",
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
    /// Where the next one will be started from, so a rebuilt sidecar can replace this one.
    script: Arc<Mutex<PathBuf>>,
    /// Set once no sidecar will be started again, so later requests fail rather than block.
    stopped: Arc<AtomicBool>,
}

impl Sidecar {
    fn spawn(script: PathBuf, app: tauri::AppHandle) -> Result<Self, String> {
        let supervisor = Supervisor {
            script: Arc::new(Mutex::new(script)),
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
            script: Arc::clone(&supervisor.script),
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

        let reply = await_reply(&rx, REQUEST_TIMEOUT);

        // A reply that never came leaves its sender in the map, where it would sit for the
        // life of the app. Taking the entry back also means a late reply finds nothing to
        // send to and is dropped, rather than being matched to a caller that gave up.
        if reply.as_ref().err().is_some_and(|e| e == SIDECAR_SILENT) {
            self.pending.lock().unwrap().remove(&id);
            log(&format!(
                "no reply to {method} (id {id}) within {REQUEST_TIMEOUT:?}"
            ));
        }

        reply
    }
}

fn node_executable() -> String {
    std::env::var("COPILOT_DESKTOP_NODE").unwrap_or_else(|_| "node".to_string())
}

/**
 * Drop the `\\?\` prefix Windows uses for extended-length paths.
 *
 * `resource_dir()` hands back a verbatim path, and Rust is perfectly happy with it - which
 * is why the existence check below passed while the app was still broken. Node is not: its
 * module resolver walks the path component by component and tries to `lstat` the first one,
 * which for `\\?\C:\...` is the bare `C:`, and that fails with EISDIR. The installed app
 * therefore started a sidecar that died instantly, three times, and gave up.
 *
 * Only the plain drive form is unwrapped. `\\?\UNC\server\share` means something different
 * and is left alone rather than being turned into a path to nowhere.
 */
fn readable_path(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy().to_string();
    match text.strip_prefix(r"\\?\") {
        Some(rest) if !rest.starts_with("UNC\\") => PathBuf::from(rest),
        _ => path,
    }
}

/// Resolve the built sidecar entrypoint, preferring an explicit override.
///
/// Three places, in the order they can be trusted. An override wins, because a developer
/// pointing at a specific build means it. Then the app's own resource directory, which is
/// where the bundled sidecar lives once installed. Only then the source tree, which exists
/// while developing and nowhere else.
///
/// The source-tree path is baked in at compile time by `CARGO_MANIFEST_DIR`, so on an
/// installed copy it names a directory on whichever machine did the build. That was the only
/// branch there was, which is why an installer could never have started its sidecar.
fn sidecar_script(app: &tauri::AppHandle) -> PathBuf {
    if let Ok(path) = std::env::var("COPILOT_DESKTOP_SIDECAR") {
        log(&format!(
            "sidecar script from COPILOT_DESKTOP_SIDECAR: {path}"
        ));
        return PathBuf::from(path);
    }

    if let Ok(resources) = app.path().resource_dir() {
        // The compiled tree is copied wholesale rather than flattened, because its files
        // import each other by relative path. Node resolves `node_modules` by walking up,
        // so the dependencies sit beside `dist` rather than inside it.
        let bundled = readable_path(
            resources
                .join("sidecar")
                .join("dist")
                .join("sidecar")
                .join("src")
                .join("index.js"),
        );
        log(&format!(
            "looking for the bundled sidecar at {} (exists: {})",
            bundled.display(),
            bundled.exists()
        ));
        if bundled.exists() {
            return bundled;
        }
    } else {
        log("no resource directory; falling back to the source tree");
    }

    // In development the crate sits at <repo>/src-tauri.
    built_sidecar()
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

/// Where `npm run build:sidecar` leaves its output, on the machine this was built on.
///
/// `CARGO_MANIFEST_DIR` is baked in at compile time, so on an installed copy this names a
/// directory that belongs to whoever did the build and will not exist. That is the point:
/// it resolves to something only while developing, which is the only time it is wanted.
fn built_sidecar() -> PathBuf {
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

/**
 * Replace the sidecar with one started from what has just been built.
 *
 * Closing its stdin is how shutdown already ends one: the process drains the work it has
 * and exits, and the thread reading its output starts the replacement.
 *
 * The replacement is pointed at `sidecar/dist` rather than left where this one came from.
 * A running app loads the sidecar out of its own resource directory, which cargo fills
 * while building the shell and nothing refreshes afterwards - so rebuilding and restarting
 * without this ran the same code over again, said it had done something, and sent the
 * reader back to where they started. Found by planting a line in the sidecar's startup log
 * and watching the restart not print it.
 *
 * Nothing here compiles anything. The dev server does that first, because it is the piece
 * that lives in the source tree and has npm within reach; this only swaps the process,
 * which is the half it cannot do.
 */
#[tauri::command]
fn restart_runtime(app: tauri::AppHandle) {
    let sidecar = app.state::<Sidecar>();

    let built = built_sidecar();
    if built.exists() {
        log(&format!("replacing the sidecar, from {}", built.display()));
        *sidecar.script.lock().unwrap() = built;
    } else {
        // No source tree, so there is nothing newer to start: restart what is already here
        // rather than refusing, since a fresh process is still what was asked for.
        log("replacing the sidecar, from where the last one came");
    }

    *sidecar.link.lock().unwrap() = None;
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Registered before anything else, which is what the plugin requires: a second
        // launch has to be turned away before it can start a sidecar of its own. Two of
        // them would run two Copilot servers with no idea of each other, doubling the
        // memory this app exists to keep down, and racing over the same stored settings.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        // Restores the size, position and maximised state the window was left in. The
        // plugin clamps a restored position to a monitor that still exists, which doing
        // this by hand would have to get right for an unplugged screen or a resolution
        // change; the saved coordinates otherwise point off every display there is.
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .setup(|app| {
            open_log(app.handle());

            app.manage(Sidecar::spawn(
                sidecar_script(app.handle()),
                app.handle().clone(),
            )?);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![sidecar_request, restart_runtime])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    /**
     * The bug that made every installed copy fail: `resource_dir()` returns a verbatim path,
     * Rust accepts it happily, and Node's module resolver then tries to `lstat` the bare
     * `C:` and dies. Nothing else in the app noticed, because the existence check passed.
     */
    #[test]
    fn a_verbatim_path_is_made_readable_for_node() {
        assert_eq!(
            readable_path(PathBuf::from(r"\\?\C:\Program Files\app\index.js")),
            PathBuf::from(r"C:\Program Files\app\index.js")
        );
    }

    #[test]
    fn an_ordinary_path_is_left_alone() {
        assert_eq!(
            readable_path(PathBuf::from(r"C:\Program Files\app\index.js")),
            PathBuf::from(r"C:\Program Files\app\index.js")
        );
    }

    // `\\?\UNC\server\share` is not a drive path with a prefix; stripping it would leave
    // `UNC\server\share`, which names nothing.
    #[test]
    fn a_verbatim_network_path_is_left_alone() {
        let unc = PathBuf::from(r"\\?\UNC\server\share\app\index.js");
        assert_eq!(readable_path(unc.clone()), unc);
    }

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

    #[test]
    fn a_reply_is_handed_back_as_it_arrived() {
        let (tx, rx) = channel();
        tx.send(Ok(json!({ "ok": true }))).unwrap();
        assert_eq!(await_reply(&rx, INSTANTLY), Ok(json!({ "ok": true })));

        let (tx, rx) = channel();
        tx.send(Err("no".to_string())).unwrap();
        assert_eq!(await_reply(&rx, INSTANTLY), Err("no".to_string()));
    }

    /// The hole this closes: a sidecar that stays up but loses a request used to block its
    /// caller forever, which shows as a spinner that never stops.
    #[test]
    fn a_request_that_is_never_answered_gives_up_rather_than_waiting_forever() {
        let (tx, rx) = channel::<Result<Value, String>>();

        assert_eq!(await_reply(&rx, INSTANTLY), Err(SIDECAR_SILENT.to_string()));

        // Held to the end so the channel is open throughout: a dropped sender would have
        // ended the wait for the wrong reason and the test would pass without proving it.
        drop(tx);
    }

    // Which is the sweep having already answered everything, so the caller is told the
    // runtime went rather than that it stayed quiet.
    #[test]
    fn a_sidecar_that_went_away_says_so_instead() {
        let (tx, rx) = channel::<Result<Value, String>>();
        drop(tx);
        assert_eq!(
            await_reply(&rx, Duration::from_secs(30)),
            Err(SIDECAR_STOPPED.to_string())
        );
    }
}
