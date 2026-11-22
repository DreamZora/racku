/**
 * The net tool's rack: the sockets at the bottom, the window's protocol above them, and the HTTP
 * panel on top, on 127.0.0.1 and a port the system picks. The tool's Tauri shell starts it with
 * `--stop-on-stdin-close --log json` and `NET_TOOL_TOKEN` set; see README.md.
 *
 * @decision .agents/decisions/261118_173845-net-tool-example.md#the-rack
 */
import { rack, slot } from "racku";
import { httpPanel } from "racku/std";

/** The development server's origin, and the built app's on macOS and Linux, and on Windows. */
const ORIGINS = ["http://localhost:5173", "tauri://localhost", "http://tauri.localhost"];

export default rack("net-tool", {
  slots: {
    1: slot("./devices/net.ts", { config: { maxSockets: 64 } }),
    2: slot("./devices/ui.ts", { config: { token: process.env.NET_TOOL_TOKEN, origins: ORIGINS } }),
    3: httpPanel({ port: 0, routes: { "/ws": "ui.http" } }),
  },
});
