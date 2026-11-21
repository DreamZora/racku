//! The net tool's shell. It starts the rack with a token of its own, passes the panel's URL and
//! the token to the window, and stops the rack when the app exits.
//!
//! - A release build runs the sidecar, `net-tool-rack`, from beside its own executable, with its
//!   base directory in the app's local data directory, and `--watch` when the setting
//!   `replaceDevices` is `automatic`. It writes the rack's log to `rack.log` in the app's log
//!   directory. A debug build runs the rack from source with `bun`, and prints its log.
//! - The rack runs with `--stop-on-stdin-close --log json`, and its standard input a pipe that
//!   the shell holds: closing the pipe stops it in order, and so does the system when the shell
//!   ends for any reason, a crash included.
//! - The shell takes the URL from the panel's `listening` entry of the log.
//! - The window's Devices dialog reads the devices, reloads them, and changes the setting, with
//!   three commands that run the rack's `ctl`.
//!
//! @decision .agents/decisions/261118_173845-net-tool-example.md#the-tauri-shell
//! @decision .agents/decisions/261118_173838-running-under-another-program.md
//! @decision .agents/decisions/261120_203926-net-tool-installers.md

// No console window on Windows in a release build.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs::{self, File};
use std::io::{BufRead, BufReader, ErrorKind, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::{Condvar, Mutex, OnceLock};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, RunEvent};

/// How long the shell waits for the rack to stop in order before it kills it.
const STOP_GRACE: Duration = Duration::from_secs(15);
/// How long `endpoint()` waits for the rack to start.
const START_WAIT: Duration = Duration::from_secs(60);
/// How long a `ctl` of the Devices dialog may take before the shell kills it.
const CTL_WAIT: Duration = Duration::from_secs(60);
/// The most bytes of one run's log that `rack.log` takes.
const LOG_LIMIT: u64 = 10 * 1024 * 1024;
/// The sidecar's name, beside the shell's executable in a release build.
#[cfg(not(debug_assertions))]
const SIDECAR: &str = "net-tool-rack";
/// Starts a console program on Windows without a console window of its own.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Where the window connects: the panel's URL, and the token that the `ui` device wants.
#[derive(Clone, Serialize)]
struct Endpoint {
    url: String,
    token: String,
}

/// When a file in the base directory replaces a device: at start and **Reload** only, or also
/// as soon as it is written.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum ReplaceDevices {
    Manual,
    Automatic,
}

/// `settings.json` in the app's config directory.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SettingsFile {
    replace_devices: ReplaceDevices,
}

/// What the Devices dialog shows of the setting.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SettingsView {
    /// The directory that replacements go in.
    base_dir: PathBuf,
    /// Whether this build runs the rack from source, which a debug build does.
    from_source: bool,
    /// The setting in `settings.json`, which applies at the next start.
    replace_devices: ReplaceDevices,
    /// The one the running rack uses.
    in_use: ReplaceDevices,
    /// Why `settings.json` couldn't be used, or written.
    error: Option<String>,
}

/// What the Devices dialog shows: what `ctl status` printed, or why it failed, and the setting.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DevicesView {
    devices: Option<serde_json::Value>,
    error: Option<String>,
    settings: SettingsView,
}

/// How this build runs the rack and its `ctl`.
enum Runner {
    /// A release build: the sidecar beside the shell's executable.
    #[cfg_attr(debug_assertions, allow(dead_code))]
    Sidecar(PathBuf),
    /// A debug build: `bun` from `PATH`, with the repository's `src/cli.ts`.
    #[cfg_attr(not(debug_assertions), allow(dead_code))]
    Source(PathBuf),
}

/// Where the rack runs, and how; known once the app's paths are.
struct Place {
    runner: Runner,
    /// The sidecar's base directory, or in a debug build the example's directory.
    base_dir: PathBuf,
    settings_path: PathBuf,
    /// The setting the rack runs with, read when the app started.
    in_use: ReplaceDevices,
}

impl Place {
    /// The rack's command line, as the shell starts it.
    fn start_command(&self, token: &str) -> Command {
        let mut command = match &self.runner {
            Runner::Sidecar(sidecar) => {
                let mut command = Command::new(sidecar);
                command.arg("--base-dir").arg(&self.base_dir);
                if self.in_use == ReplaceDevices::Automatic {
                    command.arg("--watch");
                }
                // The sidecar reads the .env of the directory where it starts: the app's own.
                command.current_dir(&self.base_dir);
                no_window(&mut command);
                command
            }
            Runner::Source(cli) => {
                let mut command = Command::new("bun");
                command.arg(cli).arg("start").arg(self.base_dir.join("rack.ts"));
                command
            }
        };
        command.args(["--stop-on-stdin-close", "--log", "json"]).env("NET_TOOL_TOKEN", token);
        command
    }

    /// `ctl <op>` for the rack of this base directory.
    fn ctl_command(&self, op: &str) -> Command {
        match &self.runner {
            Runner::Sidecar(sidecar) => {
                let mut command = Command::new(sidecar);
                command.arg("ctl").arg(op).arg("--base-dir").arg(&self.base_dir);
                command.current_dir(&self.base_dir);
                no_window(&mut command);
                command
            }
            Runner::Source(cli) => {
                let mut command = Command::new("bun");
                command.arg(cli).arg("ctl").arg(op).arg("--dir").arg(&self.base_dir);
                command
            }
        }
    }
}

/// Where the rack's log lines go: `rack.log` in a release build, the console in a debug build.
struct Log {
    /// `rack.log`; `None` in a debug build.
    path: Option<PathBuf>,
    file: Mutex<LogFile>,
}

struct LogFile {
    file: Option<File>,
    written: u64,
    /// Why the file couldn't be opened, when it couldn't.
    error: Option<String>,
}

impl Log {
    /// The console's log, for a debug build.
    fn console() -> Self {
        Log { path: None, file: Mutex::new(LogFile { file: None, written: 0, error: None }) }
    }

    /// `rack.log` in `dir`, once the previous run's is renamed to `rack.old.log`.
    #[cfg_attr(debug_assertions, allow(dead_code))]
    fn in_dir(dir: &Path) -> Self {
        let path = dir.join("rack.log");
        let opened = fs::create_dir_all(dir)
            .and_then(|()| match fs::rename(&path, dir.join("rack.old.log")) {
                Err(error) if error.kind() != ErrorKind::NotFound => Err(error),
                _ => Ok(()),
            })
            .and_then(|()| File::create(&path));
        let (file, error) = match opened {
            Ok(file) => (Some(file), None),
            Err(error) => (None, Some(error.to_string())),
        };
        Log { path: Some(path), file: Mutex::new(LogFile { file, written: 0, error }) }
    }

    /// Writes one of the rack's lines.
    fn line(&self, line: &str) {
        if self.path.is_none() {
            println!("{line}");
            return;
        }
        let mut log = self.file.lock().expect("the log's lock");
        let size = line.len() as u64 + 1;
        let full = log.written + size > LOG_LIMIT;
        let Some(file) = log.file.as_mut() else { return };
        if full {
            let _ = file.write_all(
                b"net-tool: this run's log reached 10 MiB, so the shell drops the rest of it\n",
            );
            log.file = None;
            return;
        }
        if file.write_all(format!("{line}\n").as_bytes()).is_ok() {
            log.written += size;
        }
    }

    /// Writes a message of the shell's own.
    fn note(&self, message: &str) {
        if self.path.is_none() {
            eprintln!("net-tool: {message}");
        } else {
            self.line(&format!("net-tool: {message}"));
        }
    }

    /// Where the log is, for a message that sends the user there.
    fn whereabouts(&self) -> Option<String> {
        let path = self.path.as_ref()?;
        let log = self.file.lock().expect("the log's lock");
        Some(match &log.error {
            Some(error) => format!("Its log, {}, couldn't be written: {error}", path.display()),
            None => format!("Its log is {}", path.display()),
        })
    }
}

/// The rack the shell started.
struct Rack {
    child: Mutex<Option<Child>>,
    /// The pipe that keeps the rack running; dropping it stops the rack.
    stdin: Mutex<Option<ChildStdin>>,
    /// `Ok(None)` until the rack has started; an error once it couldn't start.
    endpoint: Mutex<Result<Option<Endpoint>, String>>,
    ready: Condvar,
    place: OnceLock<Place>,
    log: OnceLock<Log>,
    /// The thread that reads the rack's log, which ends once the rack has exited.
    reader: Mutex<Option<JoinHandle<()>>>,
    /// The setting in `settings.json`, and why the file couldn't be used or written.
    settings: Mutex<(ReplaceDevices, Option<String>)>,
}

impl Rack {
    fn place(&self) -> Result<&Place, String> {
        self.place.get().ok_or_else(|| "the shell found no place for the rack".to_string())
    }

    fn log(&self) -> &Log {
        self.log.get_or_init(Log::console)
    }

    fn settings_view(&self, place: &Place) -> SettingsView {
        let (replace_devices, error) = self.settings.lock().expect("the settings' lock").clone();
        SettingsView {
            base_dir: place.base_dir.clone(),
            from_source: matches!(place.runner, Runner::Source(_)),
            replace_devices,
            in_use: place.in_use,
            error,
        }
    }
}

/// Gives the window the panel's URL and the token, once the rack has started.
#[tauri::command(async)]
fn endpoint(rack: tauri::State<'_, Rack>) -> Result<Endpoint, String> {
    let deadline = Instant::now() + START_WAIT;
    let mut known = rack.endpoint.lock().map_err(|error| error.to_string())?;
    loop {
        match &*known {
            Ok(Some(endpoint)) => return Ok(endpoint.clone()),
            Err(message) => return Err(message.clone()),
            Ok(None) => {}
        }
        let now = Instant::now();
        if now >= deadline {
            return Err("the rack didn't start within 60 s".into());
        }
        known =
            rack.ready.wait_timeout(known, deadline - now).map_err(|error| error.to_string())?.0;
    }
}

/// The rack's devices, from `ctl status`, and the setting.
#[tauri::command(async)]
fn devices(rack: tauri::State<'_, Rack>) -> Result<DevicesView, String> {
    let place = rack.place()?;
    let (devices, error) = match ctl(place, "status") {
        Ok(devices) => (Some(devices), None),
        Err(error) => (None, Some(error)),
    };
    Ok(DevicesView { devices, error, settings: rack.settings_view(place) })
}

/// Runs `ctl reload`, and returns what it replaced and what failed.
#[tauri::command(async)]
fn reload_devices(rack: tauri::State<'_, Rack>) -> Result<serde_json::Value, String> {
    ctl(rack.place()?, "reload")
}

/// Writes the setting to `settings.json`, for the next start.
#[tauri::command(async)]
fn set_replace_devices(
    rack: tauri::State<'_, Rack>,
    mode: ReplaceDevices,
) -> Result<SettingsView, String> {
    let place = rack.place()?;
    let written = write_settings(&place.settings_path, mode);
    {
        let mut settings = rack.settings.lock().map_err(|error| error.to_string())?;
        match written {
            Ok(()) => *settings = (mode, None),
            // The setting stays as it was, and the dialog shows why.
            Err(error) => settings.1 = Some(error),
        }
    }
    Ok(rack.settings_view(place))
}

/// Runs `ctl <op>` and returns what it printed, parsed, within [`CTL_WAIT`].
fn ctl(place: &Place, op: &str) -> Result<serde_json::Value, String> {
    let mut child = place
        .ctl_command(op)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("cannot run ctl {op}: {error}"))?;
    // Both pipes are read as the command writes, so that a full one never blocks it.
    let mut stdout = child.stdout.take().expect("ctl's piped stdout");
    let mut stderr = child.stderr.take().expect("ctl's piped stderr");
    let out = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = stdout.read_to_end(&mut bytes);
        bytes
    });
    let err = std::thread::spawn(move || {
        let mut text = String::new();
        let _ = stderr.read_to_string(&mut text);
        text
    });
    let deadline = Instant::now() + CTL_WAIT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("ctl {op} didn't end within 60 s, so the shell killed it"));
            }
            Err(error) => return Err(format!("ctl {op}: {error}")),
        }
    };
    let printed = out.join().unwrap_or_default();
    let message = err.join().unwrap_or_default();
    if !status.success() {
        let message = message.trim();
        return Err(if message.is_empty() {
            format!("ctl {op} exited with {status}")
        } else {
            message.to_string()
        });
    }
    serde_json::from_slice(&printed).map_err(|error| format!("ctl {op} printed no JSON: {error}"))
}

/// Reads `settings.json`: `manual` without it, and with the reason when it can't be used.
fn read_settings(path: &Path) -> (ReplaceDevices, Option<String>) {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == ErrorKind::NotFound => return (ReplaceDevices::Manual, None),
        Err(error) => {
            let reason =
                format!("{} can't be read, so the setting is manual: {error}", path.display());
            return (ReplaceDevices::Manual, Some(reason));
        }
    };
    match serde_json::from_slice::<SettingsFile>(&bytes) {
        Ok(file) => (file.replace_devices, None),
        Err(error) => {
            let reason =
                format!("{} isn't valid, so the setting is manual: {error}", path.display());
            (ReplaceDevices::Manual, Some(reason))
        }
    }
}

/// Writes `settings.json` to a new file beside it, which then replaces it, so that a crash leaves
/// the old setting or the new one.
fn write_settings(path: &Path, mode: ReplaceDevices) -> Result<(), String> {
    let failed = |error: std::io::Error| format!("{} can't be written: {error}", path.display());
    let dir = path.parent().ok_or_else(|| format!("{} has no directory", path.display()))?;
    fs::create_dir_all(dir).map_err(failed)?;
    let mut text = serde_json::to_string_pretty(&SettingsFile { replace_devices: mode })
        .map_err(|error| error.to_string())?;
    text.push('\n');
    let next = dir.join("settings.json.new");
    let mut file = File::create(&next).map_err(failed)?;
    file.write_all(text.as_bytes()).and_then(|()| file.sync_all()).map_err(failed)?;
    drop(file);
    fs::rename(&next, path).map_err(failed)
}

/// Starts a command of the sidecar without a console window, which Windows would open for it,
/// since the shell of a release build has no console.
fn no_window(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    let _ = command;
}

/// 32 random bytes, as 64 hex digits.
fn token() -> String {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).expect("random bytes for the rack's token");
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// A release build's log: `rack.log` in the app's log directory.
#[cfg(not(debug_assertions))]
fn open_log(app: &AppHandle) -> Result<Log, String> {
    let dir = app.path().app_log_dir().map_err(|error| format!("no log directory: {error}"))?;
    Ok(Log::in_dir(&dir))
}

/// A debug build's log: its console.
#[cfg(debug_assertions)]
fn open_log(_app: &AppHandle) -> Result<Log, String> {
    Ok(Log::console())
}

/// Where a release build runs the rack: the sidecar beside the shell, with its base directory,
/// `rack/` in the app's local data directory.
#[cfg(not(debug_assertions))]
fn place(app: &AppHandle, in_use: ReplaceDevices, settings_path: PathBuf) -> Result<Place, String> {
    let data = app.path().app_local_data_dir();
    let base_dir = data.map_err(|error| format!("no local data directory: {error}"))?.join("rack");
    fs::create_dir_all(&base_dir)
        .map_err(|error| format!("{} can't be created: {error}", base_dir.display()))?;
    let exe = std::env::current_exe().map_err(|error| error.to_string())?;
    let dir = exe.parent().ok_or("the shell's executable has no directory")?;
    let sidecar = dir.join(format!("{SIDECAR}{}", std::env::consts::EXE_SUFFIX));
    Ok(Place { runner: Runner::Sidecar(sidecar), base_dir, settings_path, in_use })
}

/// Where a debug build runs the rack: from the repository that holds this shell, with `rack
/// start` whatever the setting says, since `rack dev` would watch `app/` too.
#[cfg(debug_assertions)]
fn place(
    _app: &AppHandle,
    _in_use: ReplaceDevices,
    settings_path: PathBuf,
) -> Result<Place, String> {
    let repository = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../..");
    let repository = repository
        .canonicalize()
        .map_err(|error| format!("the repository that holds the net tool: {error}"))?;
    Ok(Place {
        runner: Runner::Source(repository.join("src").join("cli.ts")),
        base_dir: repository.join("examples").join("net-tool"),
        settings_path,
        in_use: ReplaceDevices::Manual,
    })
}

/// Reads the setting, and starts the rack with it.
fn start(app: &AppHandle) {
    let rack = app.state::<Rack>();
    match open_log(app) {
        Ok(log) => {
            let _ = rack.log.set(log);
        }
        Err(reason) => return failed(app, reason),
    }
    let settings_path = match app.path().app_config_dir() {
        Ok(dir) => dir.join("settings.json"),
        Err(error) => return failed(app, format!("no config directory: {error}")),
    };
    let (in_use, error) = read_settings(&settings_path);
    *rack.settings.lock().expect("the settings' lock") = (in_use, error);
    let place = match place(app, in_use, settings_path) {
        Ok(place) => rack.place.get_or_init(|| place),
        Err(reason) => return failed(app, reason),
    };
    let token = token();
    let release = matches!(place.runner, Runner::Sidecar(_));
    let spawned = place
        .start_command(&token)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        // A release build has no console, so the rack's own messages go to its log too.
        .stderr(if release { Stdio::piped() } else { Stdio::inherit() })
        .spawn();
    let mut child = match spawned {
        Ok(child) => child,
        Err(error) => {
            let program = match &place.runner {
                Runner::Sidecar(sidecar) => sidecar.display().to_string(),
                Runner::Source(_) => "bun".to_string(),
            };
            return failed(app, format!("cannot run {program}: {error}"));
        }
    };
    let stdout = child.stdout.take().expect("the rack's piped stdout");
    let stderr = child.stderr.take();
    *rack.stdin.lock().expect("the pipe's lock") = child.stdin.take();
    *rack.child.lock().expect("the child's lock") = Some(child);
    let errors = stderr.map(|stderr| {
        let handle = app.clone();
        std::thread::spawn(move || read_errors(handle, stderr))
    });
    let handle = app.clone();
    let reader = std::thread::spawn(move || read_log(handle, stdout, token, errors));
    *rack.reader.lock().expect("the reader's lock") = Some(reader);
}

/// Writes the rack's standard error to its log, and returns its last line.
fn read_errors(app: AppHandle, stderr: ChildStderr) -> Option<String> {
    let rack = app.state::<Rack>();
    let mut last = None;
    for line in BufReader::new(stderr).lines() {
        let Ok(line) = line else { break };
        rack.log().line(&line);
        if !line.trim().is_empty() {
            last = Some(line);
        }
    }
    last
}

/// Writes the rack's log, and takes the panel's URL from it. The window gets the URL once the
/// rack's control endpoint listens too, the last step of its start: a rack whose base directory
/// another rack runs for, such as a second copy of the app's, stops at that step. When the log
/// ends before then, the rack couldn't start.
fn read_log(
    app: AppHandle,
    stdout: ChildStdout,
    token: String,
    errors: Option<JoinHandle<Option<String>>>,
) {
    let rack = app.state::<Rack>();
    let mut url = None;
    let mut control = false;
    for line in BufReader::new(stdout).lines() {
        let Ok(line) = line else { break };
        rack.log().line(&line);
        let Ok(entry) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        if entry["device"] == "http-panel" && entry["message"] == "listening" {
            url = entry["data"]["url"].as_str().map(str::to_string);
        } else if entry["message"] == "control listening" {
            control = true;
        } else {
            continue;
        }
        if let (Some(url), true) = (&url, control) {
            let endpoint = Endpoint { url: url.clone(), token: token.clone() };
            *rack.endpoint.lock().expect("the endpoint's lock") = Ok(Some(endpoint));
            rack.ready.notify_all();
        }
    }
    let last = errors.and_then(|reader| reader.join().ok().flatten());
    if matches!(*rack.endpoint.lock().expect("the endpoint's lock"), Ok(None)) {
        let reason = last.unwrap_or_else(|| "it stopped before its panel listened".into());
        failed(&app, reason);
    }
}

/// Shows the window why the rack couldn't start. A release build keeps the window open with the
/// failure; a debug build exits, with the rack's errors on its console.
fn failed(app: &AppHandle, reason: String) {
    let rack = app.state::<Rack>();
    let message = match rack.log().whereabouts() {
        Some(log) => format!("The rack couldn't start: {reason}. {log}."),
        None => format!("The rack couldn't start: {reason}."),
    };
    rack.log().note(&message);
    *rack.endpoint.lock().expect("the endpoint's lock") = Err(message);
    rack.ready.notify_all();
    if cfg!(debug_assertions) {
        app.exit(1);
    }
}

/// Closes the rack's input, waits for it to stop in order, and kills it after the grace period.
fn stop(rack: &Rack) {
    drop(rack.stdin.lock().expect("the pipe's lock").take());
    let Some(mut child) = rack.child.lock().expect("the child's lock").take() else {
        return;
    };
    let deadline = Instant::now() + STOP_GRACE;
    let mut stopped = false;
    while Instant::now() < deadline {
        match child.try_wait() {
            Ok(Some(_)) => {
                stopped = true;
                break;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(_) => break,
        }
    }
    if !stopped {
        rack.log().note("the rack didn't stop within 15 s, so it is killed");
        // It may have exited just now, which leaves nothing to kill.
        let _ = child.kill();
        let _ = child.wait();
    }
    // The rack's last lines, of its shutdown, are still on their way to the log.
    if let Some(reader) = rack.reader.lock().expect("the reader's lock").take() {
        let _ = reader.join();
    }
}

fn main() {
    let rack = Rack {
        child: Mutex::new(None),
        stdin: Mutex::new(None),
        endpoint: Mutex::new(Ok(None)),
        ready: Condvar::new(),
        place: OnceLock::new(),
        log: OnceLock::new(),
        reader: Mutex::new(None),
        settings: Mutex::new((ReplaceDevices::Manual, None)),
    };
    tauri::Builder::default()
        .manage(rack)
        .setup(|app| {
            start(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            endpoint,
            devices,
            reload_devices,
            set_replace_devices
        ])
        .build(tauri::generate_context!())
        .expect("the net tool's window")
        .run(|app, event| {
            if let RunEvent::ExitRequested { .. } | RunEvent::Exit = event {
                stop(app.state::<Rack>().inner());
            }
        });
}
