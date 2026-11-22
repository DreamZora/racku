/**
 * The net tool's rack: the sockets at the bottom, the window's protocol above them, and the HTTP
 * panel on top, on 127.0.0.1 and a port the system picks. The tool's Tauri shell starts it with
 * `--stop-on-stdin-close --log json` and `NET_TOOL_TOKEN` set, and `NET_TOOL_DEV` in a debug
 * build; see README.md.
 *
 * @decision .agents/decisions/261118_173845-net-tool-example.md#the-rack
 */
import { rack, slot } from "racku";
import { httpPanel } from "racku/std";

/**
 * The built app's origins, on macOS and Linux, and on Windows; and the development server's, only
 * when the shell of a debug build sets `NET_TOOL_DEV`.
 *
 * @decision .agents/decisions/261122_011655-security-review-fixes.md#net-tool-and-ci
 */
const ORIGINS = [
  "tauri://localhost",
  "http://tauri.localhost",
  ...(process.env.NET_TOOL_DEV === "1" ? ["http://localhost:5173"] : []),
];

export default rack("net-tool", {
  slots: {
    1: slot("./devices/net.ts", { config: { maxSockets: 64 } }),
    2: slot("./devices/ui.ts", { config: { token: process.env.NET_TOOL_TOKEN, origins: ORIGINS } }),
    3: httpPanel({ port: 0, routes: { "/ws": "ui.http" } }),
  },
});
