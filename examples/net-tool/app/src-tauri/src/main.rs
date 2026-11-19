//! The net tool's shell. It starts the rack with a token of its own, passes the panel's URL and
//! the token to the window, and stops the rack when the app exits.
//!
//! - The rack runs with `--stop-on-stdin-close --log json`, and its standard input a pipe that
//!   the shell holds: closing the pipe stops it in order, and so does the system when the shell
//!   ends for any reason, a crash included.
//! - The shell reads the rack's JSON lines, takes the URL from the panel's `listening` entry, and
//!   prints every line to its console.
//!
//! @decision .agents/decisions/261118_173845-net-tool-example.md#the-tauri-shell
//! @decision .agents/decisions/261118_173838-running-under-another-program.md

// No console window on Windows in a release build.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Manager, RunEvent};

/// How long the shell waits for the rack to stop in order before it kills it.
const STOP_GRACE: Duration = Duration::from_secs(15);
/// How long `endpoint()` waits for the panel to listen.
const START_WAIT: Duration = Duration::from_secs(60);

/// Where the window connects: the panel's URL, and the token that the `ui` device wants.
#[derive(Clone, Serialize)]
struct Endpoint {
    url: String,
    token: String,
}

/// The rack the shell started.
struct Rack {
    child: Mutex<Option<Child>>,
    /// The pipe that keeps the rack running; dropping it stops the rack.
    stdin: Mutex<Option<ChildStdin>>,
    /// `Ok(None)` until the panel listens; an error once the rack ended before that.
    endpoint: Mutex<Result<Option<Endpoint>, String>>,
    ready: Condvar,
}

/// Gives the window the panel's URL and the token, once the panel listens.
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
            return Err("the rack's panel didn't listen within 60 s".into());
        }
        known = rack
            .ready
            .wait_timeout(known, deadline - now)
            .map_err(|error| error.to_string())?
            .0;
    }
}

/// 32 random bytes, as 64 hex digits.
fn token() -> String {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).expect("random bytes for the rack's token");
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Starts the rack from the repository that holds this shell, with `bun` from `PATH`.
fn start(token: &str) -> Child {
    let repository = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../..");
    let repository = repository
        .canonicalize()
        .expect("the repository that holds the net tool");
    Command::new("bun")
        .arg(repository.join("src").join("cli.ts"))
        .arg("start")
        .arg(repository.join("examples").join("net-tool").join("rack.ts"))
        .args(["--stop-on-stdin-close", "--log", "json"])
        .env("NET_TOOL_TOKEN", token)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .unwrap_or_else(|error| {
            eprintln!("net-tool: cannot run bun: {error}");
            std::process::exit(1);
        })
}

/// Prints the rack's log, and takes the panel's URL from it. When the log ends before the panel
/// listened, the rack failed to start, and so does the app.
fn read_log(app: AppHandle, stdout: ChildStdout, token: String) {
    let rack = app.state::<Rack>();
    for line in BufReader::new(stdout).lines() {
        let Ok(line) = line else { break };
        println!("{line}");
        let Ok(entry) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        if entry["device"] != "http-panel" || entry["message"] != "listening" {
            continue;
        }
        if let Some(url) = entry["data"]["url"].as_str() {
            let endpoint = Endpoint { url: url.to_string(), token: token.clone() };
            *rack.endpoint.lock().expect("the endpoint's lock") = Ok(Some(endpoint));
            rack.ready.notify_all();
        }
    }
    let mut known = rack.endpoint.lock().expect("the endpoint's lock");
    if matches!(*known, Ok(None)) {
        *known = Err("the rack stopped before its panel listened; its errors are in the console".into());
        rack.ready.notify_all();
        drop(known);
        eprintln!("net-tool: the rack stopped before its panel listened");
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
    while Instant::now() < deadline {
        match child.try_wait() {
            Ok(Some(_)) => return,
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(_) => break,
        }
    }
    eprintln!("net-tool: the rack didn't stop within 15 s, so it is killed");
    // It may have exited just now, which leaves nothing to kill.
    let _ = child.kill();
    let _ = child.wait();
}

fn main() {
    let token = token();
    let mut child = start(&token);
    let stdout = child.stdout.take().expect("the rack's piped stdout");
    let stdin = child.stdin.take();
    let rack = Rack {
        child: Mutex::new(Some(child)),
        stdin: Mutex::new(stdin),
        endpoint: Mutex::new(Ok(None)),
        ready: Condvar::new(),
    };
    tauri::Builder::default()
        .manage(rack)
        .setup(move |app| {
            let handle = app.handle().clone();
            std::thread::spawn(move || read_log(handle, stdout, token));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![endpoint])
        .build(tauri::generate_context!())
        .expect("the net tool's window")
        .run(|app, event| {
            if let RunEvent::ExitRequested { .. } | RunEvent::Exit = event {
                stop(app.state::<Rack>().inner());
            }
        });
}
