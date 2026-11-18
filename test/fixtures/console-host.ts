/**
 * Windows only: runs a command on a console of its own, so that a test can stop it in order with
 * Ctrl+C or Ctrl+Break. Those reach a process only through its console, while Bun's `kill()` ends
 * a Windows process at once, without a signal it can handle. The processes of a CI job have no
 * console, and a console of its own keeps the events from reaching any other process.
 *
 * - `bun console-host.ts <command...>` runs the command. Each line on stdin names a signal:
 *   `SIGINT` sends Ctrl+C, and `SIGBREAK` sends Ctrl+Break, to the command's console. Any other
 *   signal ends the command at once, and so does the end of stdin. The command's output passes
 *   through, and this process exits with the command's exit code.
 * - `bun console-host.ts --send <pid> <event>` joins the console of process `pid` and sends it
 *   `event`, 0 for Ctrl+C or 1 for Ctrl+Break.
 *
 * Every process on a console receives the events sent to it, the sender included, and the host
 * must outlive them. So the host leaves the console once the command runs on it, and each event
 * comes from a sender of its own, which may end with it.
 *
 * @decision .agents/decisions/261118_015204-windows.md#changes-to-the-repository-and-the-tests
 */
import { dlopen, FFIType } from "bun:ffi";

const kernel32 = dlopen("kernel32.dll", {
  FreeConsole: { args: [], returns: FFIType.i32 },
  AllocConsole: { args: [], returns: FFIType.i32 },
  AttachConsole: { args: [FFIType.u32], returns: FFIType.i32 },
  GetConsoleWindow: { args: [], returns: FFIType.u64 },
  SetConsoleCtrlHandler: { args: [FFIType.u64, FFIType.i32], returns: FFIType.i32 },
  GenerateConsoleCtrlEvent: { args: [FFIType.u32, FFIType.u32], returns: FFIType.i32 },
}).symbols;

if (process.argv[2] === "--send") {
  kernel32.FreeConsole();
  if (kernel32.AttachConsole(Number(process.argv[3])) === 0) process.exit(2);
  // The sender ignores its own Ctrl+C. Ctrl+Break may end it, but only once the event is out.
  kernel32.SetConsoleCtrlHandler(0n, 1);
  process.exit(kernel32.GenerateConsoleCtrlEvent(Number(process.argv[4]), 0) === 0 ? 3 : 0);
}

const user32 = dlopen("user32.dll", {
  ShowWindow: { args: [FFIType.u64, FFIType.i32], returns: FFIType.i32 },
}).symbols;
const EVENTS: Record<string, number> = { SIGINT: 0, SIGBREAK: 1 };
const SW_HIDE = 0;

kernel32.FreeConsole();
if (kernel32.AllocConsole() === 0) throw new Error("console-host: AllocConsole failed");
user32.ShowWindow(kernel32.GetConsoleWindow(), SW_HIDE);
const child = Bun.spawn(process.argv.slice(2), {
  stdin: "ignore",
  stdout: "pipe",
  stderr: "pipe",
  // A hidden subprocess gets no console, and so no Ctrl+C.
  windowsHide: false,
});
// The command keeps the console alive; the host leaves it, out of reach of the events.
kernel32.FreeConsole();

async function send(event: number): Promise<void> {
  const sender = Bun.spawn(
    [process.execPath, import.meta.path, "--send", String(child.pid), String(event)],
    // Without a console of its own, the sender can join the command's.
    { stdin: "ignore", stdout: "ignore", stderr: "inherit", windowsHide: true },
  );
  const code = await sender.exited;
  if (code === 2 || code === 3) console.error(`console-host: event ${event} not sent (${code})`);
}

async function relay(from: ReadableStream<Uint8Array>, to: NodeJS.WriteStream): Promise<void> {
  for await (const chunk of from) to.write(chunk);
  await new Promise<void>((resolve) => to.write("", () => resolve()));
}
const output = Promise.all([
  relay(child.stdout, process.stdout),
  relay(child.stderr, process.stderr),
]);

let pending = "";
process.stdin.on("data", (chunk: Buffer) => {
  pending += chunk.toString();
  for (let end = pending.indexOf("\n"); end >= 0; end = pending.indexOf("\n")) {
    const event = EVENTS[pending.slice(0, end).trim()];
    pending = pending.slice(end + 1);
    if (event === undefined) child.kill();
    else void send(event);
  }
});
// The test is gone, or done with the command.
process.stdin.on("end", () => child.kill());

const code = await child.exited;
await output;
process.exit(code);
