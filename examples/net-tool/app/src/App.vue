<script setup lang="ts">
/**
 * The net tool's window: opens TCP clients, TCP servers, and UDP sockets, lists them with their
 * counters, and sends and shows each socket's bytes as text or hex.
 *
 * @decision .agents/decisions/261118_173845-net-tool-example.md#the-window
 * @decision .agents/decisions/261120_203926-net-tool-installers.md#the-devices-dialog
 */
import { computed, markRaw, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import {
  base64ToBytes,
  bytesToBase64,
  bytesToHex,
  bytesToText,
  hexToBytes,
  textToBytes,
} from "./codec.ts";
import {
  type Address,
  type ConnectionState,
  Connection,
  endpoint,
  type NetEvent,
  type SocketInfo,
} from "./connection.ts";
import Devices from "./Devices.vue";
import { icons } from "./icons.ts";

/** The most messages the window keeps per socket. */
const KEPT = 10_000;
/** The most messages it shows at once, the newest. */
const SHOWN = 500;
/** How often it reads the sockets' counters, in ms. */
const REFRESH = 2_000;
/** Bytes per line of the hex view. */
const HEX_LINE = 16;

interface Message {
  at: number;
  direction: "in" | "out";
  bytes: Uint8Array;
  peer?: Address;
}

interface SocketView extends SocketInfo {
  open: boolean;
  error?: string;
  messages: Message[];
}

type Kind = "tcp-client" | "tcp-server" | "udp";
const kinds: { label: string; value: Kind; hint: string }[] = [
  { label: "TCP client", value: "tcp-client", hint: "Connects to a TCP server at this address." },
  { label: "TCP server", value: "tcp-server", hint: "Listens at this address; port 0 picks a free one." },
  { label: "UDP", value: "udp", hint: "Binds to this address, where port 0 picks a free one, and sends anywhere." },
];
const modes: { label: string; value: "text" | "hex" }[] = [
  { label: "Text", value: "text" },
  { label: "Hex", value: "hex" },
];

/** Whether the window runs in the Tauri shell, whose commands the Devices dialog needs. */
const inShell = "__TAURI_INTERNALS__" in window;
const devicesOpen = ref(false);
const state = ref<ConnectionState>("connecting");
const detail = ref("");
const problem = ref("");
const sockets = reactive(new Map<number, SocketView>());
const selected = ref<number>();
const view = ref<"text" | "hex">("text");
const form = reactive({ kind: "tcp-client" as Kind, host: "127.0.0.1", port: 9000 });
const outgoing = reactive({ mode: "text" as "text" | "hex", text: "", toHost: "127.0.0.1", toPort: 9000 });
const log = ref<HTMLElement>();
/** Whether the log follows new messages: while it is scrolled to its end. */
const following = ref(true);
let connection: Connection | undefined;
let timer: ReturnType<typeof setInterval> | undefined;

const sorted = computed(() => [...sockets.values()].sort((a, b) => a.id - b.id));
const current = computed(() => (selected.value === undefined ? undefined : sockets.get(selected.value)));
const shown = computed(() => current.value?.messages.slice(-SHOWN) ?? []);
const hint = computed(() => kinds.find((kind) => kind.value === form.kind)?.hint ?? "");
const stateLabel = computed(() =>
  state.value === "open" ? "Connected" : state.value === "connecting" ? "Connecting…" : "Disconnected",
);
const hexProblem = computed(() => {
  if (outgoing.mode !== "hex") return "";
  try {
    hexToBytes(outgoing.text);
    return "";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
});

function remember(id: number, message: Message): void {
  const socket = sockets.get(id);
  if (socket === undefined) return;
  socket.messages.push(markRaw(message));
  if (socket.messages.length > KEPT) socket.messages.splice(0, socket.messages.length - KEPT);
}

function track(info: SocketInfo): SocketView {
  const known = sockets.get(info.id);
  if (known !== undefined) {
    Object.assign(known, info, { open: true });
    return known;
  }
  const created: SocketView = { ...info, open: true, messages: [] };
  sockets.set(info.id, created);
  return sockets.get(info.id) as SocketView;
}

function failed(error: unknown): void {
  problem.value = error instanceof Error ? error.message : String(error);
  // The rack may have lost sockets, after a crash of `net` for one; the list says which.
  void refresh();
}

async function refresh(): Promise<void> {
  if (connection === undefined || state.value !== "open") return;
  try {
    const listed = await connection.command<SocketInfo[]>("list");
    const present = new Set(listed.map((info) => info.id));
    for (const info of listed) track(info);
    for (const socket of sockets.values()) if (!present.has(socket.id)) socket.open = false;
  } catch {
    // The next refresh tries again; a failure of the connection shows in its state.
  }
}

function onEvent(event: NetEvent): void {
  if (event.event === "opened") {
    const { id, server, local, remote } = event;
    track({ id, kind: server === undefined ? "tcp-client" : "tcp-connection", local, remote, sent: 0, received: 0, events: 0, delivered: 0, ...(server === undefined ? {} : { server }) });
  } else if (event.event === "data") {
    remember(event.id, {
      at: Date.now(),
      direction: "in",
      bytes: base64ToBytes(event.data),
      ...(event.from === undefined ? {} : { peer: event.from }),
    });
  } else {
    const socket = sockets.get(event.id);
    if (socket === undefined) return;
    socket.open = false;
    if (event.error !== undefined) socket.error = event.error;
  }
}

async function open(): Promise<void> {
  problem.value = "";
  try {
    const opened = await connection?.command<{ id: number; local: Address; remote?: Address }>("open", {
      kind: form.kind,
      host: form.host,
      port: Number(form.port),
    });
    if (opened === undefined) return;
    track({ ...opened, kind: form.kind, sent: 0, received: 0, events: 0, delivered: 0 });
    selected.value = opened.id;
  } catch (error) {
    failed(error);
  }
}

async function send(): Promise<void> {
  const socket = current.value;
  if (socket === undefined || connection === undefined || hexProblem.value !== "") return;
  problem.value = "";
  try {
    const bytes = outgoing.mode === "hex" ? hexToBytes(outgoing.text) : textToBytes(outgoing.text);
    const to = socket.kind === "udp" ? { host: outgoing.toHost, port: Number(outgoing.toPort) } : undefined;
    await connection.command("send", { id: socket.id, data: bytesToBase64(bytes), ...(to === undefined ? {} : { to }) });
    remember(socket.id, { at: Date.now(), direction: "out", bytes, ...(to === undefined ? {} : { peer: to }) });
    following.value = true;
  } catch (error) {
    failed(error);
  }
}

async function close(id: number): Promise<void> {
  try {
    await connection?.command("close", { id });
  } catch (error) {
    failed(error);
  }
}

function kindLabel(socket: SocketInfo): string {
  if (socket.kind === "tcp-connection") return "Connection";
  return kinds.find((kind) => kind.value === socket.kind)?.label ?? socket.kind;
}

function address(at: Address): string {
  return `${at.host}:${at.port}`;
}

function addresses(socket: SocketInfo): string {
  return socket.remote === undefined ? address(socket.local) : `${address(socket.local)} ⇄ ${address(socket.remote)}`;
}

/** The session's line under its title: where it listens, or both ends and who accepted it. */
function describe(socket: SocketInfo): string {
  if (socket.kind === "tcp-server") return `Listening on ${address(socket.local)}`;
  if (socket.kind === "udp") return `Bound to ${address(socket.local)}`;
  const ends = addresses(socket);
  return socket.server === undefined ? ends : `${ends} · accepted by server #${socket.server}`;
}

/** A socket's light: open, closed, or closed with an error. */
function status(socket: SocketView): "open" | "closed" | "failed" {
  if (socket.open) return "open";
  return socket.error === undefined ? "closed" : "failed";
}

/** The `data` events of a socket that didn't reach the window, as far as the counters tell. */
function missed(socket: SocketInfo): number {
  return Math.max(0, socket.events - socket.delivered);
}

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

/** The ASCII names of the control characters, which the text view shows in place of them. */
const CONTROL_NAMES = [
  "NUL", "SOH", "STX", "ETX", "EOT", "ENQ", "ACK", "BEL", "BS", "TAB", "LF", "VT", "FF", "CR", "SO", "SI",
  "DLE", "DC1", "DC2", "DC3", "DC4", "NAK", "SYN", "ETB", "CAN", "EM", "SUB", "ESC", "FS", "GS", "RS", "US",
];

/**
 * Text as runs of plain characters, and of control characters by their ASCII names, such as CR
 * LF, so that line ends and binary bytes stay visible. A line feed also ends the line, and a tab
 * stays a tab.
 */
function runs(bytes: Uint8Array): { text: string; control: boolean }[] {
  const found: { text: string; control: boolean; newline?: boolean }[] = [];
  const plain = (text: string) => {
    const last = found.at(-1);
    if (last !== undefined && !last.control) last.text += text;
    else found.push({ text, control: false });
  };
  const control = (name: string, newline = false) => {
    const last = found.at(-1);
    if (last !== undefined && last.control && last.newline !== true) last.text += ` ${name}`;
    else found.push({ text: name, control: true });
    if (newline) {
      (found.at(-1) as { newline?: boolean }).newline = true;
      found.push({ text: "\n", control: false });
    }
  };
  for (const char of bytesToText(bytes)) {
    const code = char.codePointAt(0) ?? 0;
    if (code === 0x0a) control("LF", true);
    else if (code < 0x20 && code !== 0x09) control(CONTROL_NAMES[code] ?? "?");
    else if (code === 0x7f) control("DEL");
    else plain(char);
  }
  return found;
}

/** Bytes as hex, 16 to a line. */
function hexLines(bytes: Uint8Array): string {
  const pairs = bytesToHex(bytes).split(" ").filter(Boolean);
  const lines: string[] = [];
  for (let at = 0; at < pairs.length; at += HEX_LINE) lines.push(pairs.slice(at, at + HEX_LINE).join(" "));
  return lines.join("\n");
}

function time(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour12: false }) + `.${String(at % 1000).padStart(3, "0")}`;
}

function onScroll(): void {
  const element = log.value;
  if (element === undefined) return;
  following.value = element.scrollHeight - element.scrollTop - element.clientHeight < 32;
}

function toEnd(): void {
  void nextTick(() => {
    if (log.value !== undefined) log.value.scrollTop = log.value.scrollHeight;
  });
}

watch(selected, () => {
  following.value = true;
  toEnd();
});
watch(
  () => [current.value?.messages.length, current.value?.messages.at(-1)],
  () => {
    if (following.value) toEnd();
  },
);

onMounted(async () => {
  try {
    connection = new Connection(await endpoint(), {
      state(next, text) {
        state.value = next;
        detail.value = next === "open" ? text.replace(/^\w+:\/\//, "").replace(/\/$/, "") : text;
        if (next === "open") void refresh();
      },
      event: onEvent,
    });
    timer = setInterval(() => void refresh(), REFRESH);
  } catch (error) {
    // Such as a rack that couldn't start, whose reason and log the shell gives.
    state.value = "closed";
    detail.value = "";
    problem.value = error instanceof Error ? error.message : String(error);
  }
});

onBeforeUnmount(() => {
  clearInterval(timer);
  connection?.close();
});
</script>

<template>
  <div class="app">
    <header class="topbar">
      <div class="brand">
        <q-icon :name="icons.rack" size="18px" />
        <span>net-tool</span>
      </div>
      <div class="rack-state" :class="state">
        <span class="light" />
        <span>{{ stateLabel }}</span>
        <span v-if="detail" class="rack-detail mono">{{ detail }}</span>
      </div>
      <div class="grow" />
      <q-btn v-if="inShell" flat dense no-caps class="topbar-button" @click="devicesOpen = true">
        <q-icon :name="icons.rack" size="16px" class="q-mr-xs" />
        Devices
      </q-btn>
    </header>

    <div class="body">
      <aside class="sidebar">
        <section class="new-socket">
          <div class="section-title">New socket</div>
          <div class="segmented">
            <button
              v-for="kind in kinds"
              :key="kind.value"
              type="button"
              :class="{ on: form.kind === kind.value }"
              @click="form.kind = kind.value"
            >
              {{ kind.label }}
            </button>
          </div>
          <p class="hint">{{ hint }}</p>
          <div class="fields">
            <q-input v-model="form.host" label="Host" dense outlined class="grow" />
            <q-input v-model.number="form.port" type="number" label="Port" dense outlined class="port" />
          </div>
          <q-btn unelevated no-caps color="primary" class="full-width" :disable="state !== 'open'" @click="open">
            <q-icon :name="icons.plus" size="18px" class="q-mr-xs" />
            Open
          </q-btn>
        </section>

        <div class="list-head">
          <span class="section-title">Sockets</span>
          <span v-if="sorted.length > 0" class="count">{{ sorted.length }}</span>
        </div>
        <div v-if="sorted.length === 0" class="list-empty">The sockets you open show here.</div>
        <div class="sockets">
          <div
            v-for="socket in sorted"
            :key="socket.id"
            class="socket"
            :class="{ active: socket.id === selected, gone: !socket.open }"
            :title="socket.error"
            @click="selected = socket.id"
          >
            <span class="light" :class="status(socket)" />
            <div class="socket-main">
              <div class="socket-title">
                <span class="grow">{{ kindLabel(socket) }} <span class="faint">#{{ socket.id }}</span></span>
                <span class="socket-meta">
                  <span v-if="missed(socket) > 0" class="warn">{{ missed(socket) }} missed · </span>↑{{ size(socket.sent) }} ↓{{ size(socket.received) }}
                </span>
              </div>
              <div class="socket-address mono" :title="addresses(socket)">{{ addresses(socket) }}</div>
            </div>
            <q-btn
              v-if="socket.open"
              flat
              round
              dense
              size="sm"
              class="socket-close"
              title="Close"
              @click.stop="close(socket.id)"
            >
              <q-icon :name="icons.close" size="14px" />
            </q-btn>
          </div>
        </div>
      </aside>

      <main class="main">
        <div v-if="problem" class="notice">
          <span>{{ problem }}</span>
          <q-btn flat round dense size="sm" title="Dismiss" @click="problem = ''">
            <q-icon :name="icons.close" size="14px" />
          </q-btn>
        </div>

        <template v-if="current">
          <div class="session-head">
            <div class="session-name">
              <div class="session-title">
                {{ kindLabel(current) }} <span class="faint">#{{ current.id }}</span>
                <span v-if="!current.open" class="pill" :class="status(current)">{{ current.error ? "failed" : "closed" }}</span>
              </div>
              <div class="session-line mono" :title="describe(current)">{{ describe(current) }}</div>
            </div>
            <div v-if="current.kind !== 'tcp-server'" class="stats">
              <div>
                <span class="stat-label">Sent</span>
                <span class="stat-value">{{ size(current.sent) }}</span>
              </div>
              <div>
                <span class="stat-label">Received</span>
                <span class="stat-value">{{ size(current.received) }}</span>
              </div>
            </div>
            <div v-if="current.kind !== 'tcp-server'" class="segmented small" title="How the log shows bytes">
              <button v-for="mode in modes" :key="mode.value" type="button" :class="{ on: view === mode.value }" @click="view = mode.value">
                {{ mode.label }}
              </button>
            </div>
            <q-btn v-if="current.open" flat dense no-caps class="session-close" title="Close this socket" @click="close(current.id)">
              <q-icon :name="icons.close" size="14px" class="q-mr-xs" />
              Close
            </q-btn>
          </div>

          <div ref="log" class="log" @scroll="onScroll">
            <div v-if="current.kind === 'tcp-server'" class="log-empty">
              Each connection that this server accepts shows in the list, where you can talk to it.
            </div>
            <div v-else-if="shown.length === 0" class="log-empty">
              No bytes yet. What you send and what arrives show here.
            </div>
            <div v-for="(message, index) in shown" :key="index" class="message" :class="message.direction">
              <span class="message-time">{{ time(message.at) }}</span>
              <span class="message-direction">{{ message.direction === "in" ? "RX" : "TX" }}</span>
              <span class="message-body">
                <span v-if="message.peer" class="message-peer">{{ message.direction === "in" ? "from" : "to" }} {{ address(message.peer) }}</span>
                <template v-if="view === 'hex'">{{ hexLines(message.bytes) }}</template>
                <template v-else>
                  <span v-for="(run, at) in runs(message.bytes)" :key="at" :class="{ control: run.control }">{{ run.text }}</span>
                </template>
              </span>
              <span class="message-size">{{ size(message.bytes.byteLength) }}</span>
            </div>
          </div>

          <div v-if="current.open && current.kind !== 'tcp-server'" class="composer">
            <div v-if="current.kind === 'udp'" class="fields to">
              <span class="to-label">To</span>
              <q-input v-model="outgoing.toHost" placeholder="Host" dense outlined class="grow" />
              <q-input v-model.number="outgoing.toPort" type="number" placeholder="Port" dense outlined class="port" />
            </div>
            <q-input
              v-model="outgoing.text"
              type="textarea"
              autogrow
              outlined
              dense
              class="message-input"
              hide-bottom-space
              :placeholder="outgoing.mode === 'hex' ? 'Hex, such as 68 65 6c 6c 6f' : 'Text to send, as UTF-8'"
              :error="hexProblem !== ''"
              :error-message="hexProblem"
              no-error-icon
              @keydown.enter.ctrl.exact.prevent="send"
              @keydown.enter.meta.exact.prevent="send"
            />
            <div class="composer-bar">
              <div class="segmented small">
                <button v-for="mode in modes" :key="mode.value" type="button" :class="{ on: outgoing.mode === mode.value }" @click="outgoing.mode = mode.value">
                  {{ mode.label }}
                </button>
              </div>
              <span class="faint small">Ctrl+Enter sends</span>
              <div class="grow" />
              <q-btn unelevated no-caps color="primary" :disable="state !== 'open' || hexProblem !== ''" @click="send">
                <q-icon :name="icons.send" size="16px" class="q-mr-xs" />
                Send
              </q-btn>
            </div>
          </div>
          <div v-else-if="!current.open" class="composer ended">
            This socket is closed{{ current.error ? `: ${current.error}` : "" }}.
          </div>
        </template>

        <div v-else class="empty">
          <q-icon :name="icons.rack" size="44px" class="faint" />
          <div class="empty-title">Open a socket to start</div>
          <div class="empty-text">
            A TCP client connects to a server, a TCP server accepts connections, and a UDP socket sends
            and receives datagrams. Pick one on the left; its bytes show here, as text or hex.
          </div>
        </div>
      </main>
    </div>

    <Devices v-if="inShell" v-model="devicesOpen" />
  </div>
</template>

<style>
:root {
  --nt-bg: #f3f4f7;
  --nt-surface: #ffffff;
  --nt-sunken: #f8f9fb;
  --nt-border: #e1e4ea;
  --nt-text: #1b2130;
  --nt-muted: #5f6879;
  --nt-faint: #959cab;
  --nt-accent: #4263eb;
  --nt-accent-soft: rgba(66, 99, 235, 0.1);
  --nt-rx: #1971c2;
  --nt-tx: #2b8a3e;
  --nt-ok: #2f9e44;
  --nt-warn: #d9480f;
  --nt-bad: #e03131;
  --nt-sans: system-ui, -apple-system, "Segoe UI", Roboto, Ubuntu, "Helvetica Neue", Arial, sans-serif;
  --nt-mono: ui-monospace, "SF Mono", "Cascadia Mono", "JetBrains Mono", Menlo, Consolas, "DejaVu Sans Mono", monospace;
}
body.body--dark {
  --nt-bg: #0e1117;
  --nt-surface: #151a22;
  --nt-sunken: #10141b;
  --nt-border: #262d38;
  --nt-text: #e3e7ee;
  --nt-muted: #9aa3b5;
  --nt-faint: #626b7d;
  --nt-accent: #748ffc;
  --nt-accent-soft: rgba(116, 143, 252, 0.15);
  --nt-rx: #4dabf7;
  --nt-tx: #69db7c;
  --nt-ok: #51cf66;
  --nt-warn: #ff922b;
  --nt-bad: #ff6b6b;
}
body {
  background: var(--nt-bg);
  color: var(--nt-text);
  font-family: var(--nt-sans);
  font-size: 13px;
}
.q-btn {
  border-radius: 6px;
}
.q-field--outlined .q-field__control {
  border-radius: 6px;
}
.mono {
  font-family: var(--nt-mono);
}
.faint {
  color: var(--nt-faint);
}
.small {
  font-size: 12px;
}
.grow {
  flex: 1;
  min-width: 0;
}
.warn {
  color: var(--nt-warn);
}
.bad {
  color: var(--nt-bad);
}

.app {
  display: grid;
  grid-template-rows: 48px 1fr;
  height: 100vh;
}
.topbar {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 0 12px 0 16px;
  background: var(--nt-surface);
  border-bottom: 1px solid var(--nt-border);
}
.brand {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
  font-size: 14px;
  color: var(--nt-accent);
}
.brand span {
  color: var(--nt-text);
}
.rack-state {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 10px;
  border-radius: 999px;
  background: var(--nt-sunken);
  border: 1px solid var(--nt-border);
  font-size: 12px;
  min-width: 0;
}
.rack-detail {
  color: var(--nt-faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.topbar-button {
  color: var(--nt-muted);
}

.light {
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--nt-faint);
}
.rack-state.open .light,
.light.open {
  background: var(--nt-ok);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--nt-ok) 20%, transparent);
}
.rack-state.connecting .light {
  background: var(--nt-warn);
}
.rack-state.closed .light,
.light.failed {
  background: var(--nt-bad);
}

.body {
  display: grid;
  grid-template-columns: 300px 1fr;
  min-height: 0;
}
.sidebar {
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--nt-surface);
  border-right: 1px solid var(--nt-border);
}
.new-socket {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 16px;
  border-bottom: 1px solid var(--nt-border);
}
.section-title {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--nt-muted);
}
.hint {
  margin: 0;
  color: var(--nt-muted);
  font-size: 12px;
}
.fields {
  display: flex;
  gap: 8px;
  align-items: center;
}
.fields .port {
  width: 92px;
}

.segmented {
  display: flex;
  padding: 2px;
  gap: 2px;
  border-radius: 8px;
  background: var(--nt-sunken);
  border: 1px solid var(--nt-border);
}
.segmented button {
  flex: 1;
  padding: 5px 10px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--nt-muted);
  font: inherit;
  cursor: pointer;
  white-space: nowrap;
}
.segmented button:hover {
  color: var(--nt-text);
}
.segmented button.on {
  background: var(--nt-surface);
  color: var(--nt-text);
  font-weight: 600;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.12);
}
body.body--dark .segmented button.on {
  background: #232a35;
}
.segmented.small button {
  flex: none;
  padding: 3px 10px;
  font-size: 12px;
}

.list-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 14px 16px 6px;
}
.count {
  padding: 0 7px;
  border-radius: 999px;
  background: var(--nt-sunken);
  border: 1px solid var(--nt-border);
  color: var(--nt-muted);
  font-size: 11px;
}
.list-empty {
  padding: 4px 16px;
  color: var(--nt-faint);
}
.sockets {
  flex: 1;
  overflow: auto;
  padding: 0 8px 12px;
}
.socket {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 9px 8px 9px 10px;
  border-radius: 8px;
  cursor: pointer;
  border: 1px solid transparent;
}
.socket .light {
  margin-top: 5px;
}
.socket:hover {
  background: var(--nt-sunken);
}
.socket.active {
  background: var(--nt-accent-soft);
  border-color: color-mix(in srgb, var(--nt-accent) 35%, transparent);
}
.socket.gone .socket-title,
.socket.gone .socket-address {
  color: var(--nt-faint);
}
.socket-main {
  flex: 1;
  min-width: 0;
}
.socket-title {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-weight: 600;
}
.socket-address {
  margin-top: 2px;
  font-size: 12px;
  color: var(--nt-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.socket-meta {
  flex: none;
  font-size: 11px;
  font-weight: 400;
  color: var(--nt-faint);
  font-variant-numeric: tabular-nums;
}
.socket-close {
  color: var(--nt-faint);
  opacity: 0;
}
.socket:hover .socket-close,
.socket.active .socket-close {
  opacity: 1;
}

.main {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}
.notice {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin: 12px 16px 0;
  padding: 8px 8px 8px 12px;
  border-radius: 8px;
  border: 1px solid color-mix(in srgb, var(--nt-bad) 40%, transparent);
  background: color-mix(in srgb, var(--nt-bad) 10%, var(--nt-surface));
  color: var(--nt-text);
}
.notice span {
  flex: 1;
  padding-top: 3px;
  overflow-wrap: anywhere;
}
.session-head {
  display: flex;
  align-items: center;
  gap: 20px;
  padding: 14px 16px;
  background: var(--nt-surface);
  border-bottom: 1px solid var(--nt-border);
}
.session-name {
  flex: 1;
  min-width: 0;
}
.session-title {
  font-size: 15px;
  font-weight: 600;
}
.session-line {
  margin-top: 3px;
  font-size: 12px;
  color: var(--nt-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pill {
  margin-left: 6px;
  padding: 1px 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 500;
  vertical-align: 2px;
  background: var(--nt-sunken);
  border: 1px solid var(--nt-border);
  color: var(--nt-muted);
}
.pill.failed {
  color: var(--nt-bad);
}
.stats {
  display: flex;
  gap: 18px;
}
.stats > div {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
}
.stat-label {
  font-size: 11px;
  color: var(--nt-faint);
}
.stat-value {
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.log {
  flex: 1;
  overflow: auto;
  padding: 6px 0;
  background: var(--nt-sunken);
  font-family: var(--nt-mono);
  font-size: 12.5px;
  line-height: 1.55;
}
.log-empty {
  padding: 28px 16px;
  color: var(--nt-faint);
  font-family: var(--nt-sans);
  font-size: 13px;
  text-align: center;
}
.message {
  display: grid;
  grid-template-columns: 96px 30px 1fr auto;
  gap: 10px;
  padding: 3px 16px;
}
.message:hover {
  background: color-mix(in srgb, var(--nt-text) 4%, transparent);
}
.message-time {
  color: var(--nt-faint);
  font-variant-numeric: tabular-nums;
}
.message-direction {
  align-self: start;
  margin-top: 2px;
  border-radius: 4px;
  font-size: 10px;
  font-weight: 700;
  line-height: 16px;
  text-align: center;
}
.message.in .message-direction {
  color: var(--nt-rx);
  background: color-mix(in srgb, var(--nt-rx) 14%, transparent);
}
.message.out .message-direction {
  color: var(--nt-tx);
  background: color-mix(in srgb, var(--nt-tx) 14%, transparent);
}
.message-body {
  min-width: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.message.in .message-body {
  color: var(--nt-text);
}
.message.out .message-body {
  color: color-mix(in srgb, var(--nt-tx) 70%, var(--nt-text));
}
.message-peer {
  display: block;
  color: var(--nt-faint);
  font-size: 11px;
}
.message-body .control {
  margin: 0 2px;
  padding: 0 3px;
  border-radius: 3px;
  border: 1px solid var(--nt-border);
  color: var(--nt-faint);
  font-size: 10px;
  vertical-align: 1px;
}
.message-size {
  color: var(--nt-faint);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.composer {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 16px;
  background: var(--nt-surface);
  border-top: 1px solid var(--nt-border);
}
.session-close {
  border: 1px solid var(--nt-border);
  color: var(--nt-muted);
  padding: 2px 10px;
}
.session-close:hover {
  color: var(--nt-bad);
  border-color: color-mix(in srgb, var(--nt-bad) 40%, transparent);
}
.composer.ended {
  color: var(--nt-muted);
}
.to-label {
  color: var(--nt-muted);
  font-size: 12px;
}
.message-input textarea {
  font-family: var(--nt-mono);
  font-size: 12.5px;
  max-height: 160px;
  overflow: auto !important;
}
.message-input.q-field--with-bottom {
  padding-bottom: 18px;
}
.composer-bar {
  display: flex;
  align-items: center;
  gap: 12px;
}

@media (max-width: 900px) {
  .body {
    grid-template-columns: 250px 1fr;
  }
  .session-head {
    gap: 12px;
  }
  .stats {
    display: none;
  }
}

.empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 32px;
  text-align: center;
}
.empty-title {
  font-size: 16px;
  font-weight: 600;
}
.empty-text {
  max-width: 420px;
  color: var(--nt-muted);
  line-height: 1.6;
}
</style>
