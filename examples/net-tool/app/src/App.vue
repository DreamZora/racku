<script setup lang="ts">
/**
 * The net tool's window: opens TCP clients, TCP servers, and UDP sockets, lists them with their
 * counters, and sends and shows each socket's bytes as text or hex.
 *
 * @decision .agents/decisions/261118_173845-net-tool-example.md#the-window
 */
import { computed, markRaw, onBeforeUnmount, onMounted, reactive, ref } from "vue";
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

/** The most messages the window keeps per socket. */
const KEPT = 10_000;
/** The most messages it shows at once, the newest. */
const SHOWN = 500;
/** How often it reads the sockets' counters, in ms. */
const REFRESH = 2_000;

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
const kinds: { label: string; value: Kind }[] = [
  { label: "TCP client", value: "tcp-client" },
  { label: "TCP server", value: "tcp-server" },
  { label: "UDP", value: "udp" },
];
const modes = [
  { label: "Text", value: "text" },
  { label: "Hex", value: "hex" },
];

const state = ref<ConnectionState>("connecting");
const detail = ref("");
const problem = ref("");
const sockets = reactive(new Map<number, SocketView>());
const selected = ref<number>();
const view = ref<"text" | "hex">("text");
const form = reactive({ kind: "tcp-client" as Kind, host: "127.0.0.1", port: 9000 });
const outgoing = reactive({ mode: "text" as "text" | "hex", text: "", toHost: "127.0.0.1", toPort: 9000 });
let connection: Connection | undefined;
let timer: ReturnType<typeof setInterval> | undefined;

const sorted = computed(() => [...sockets.values()].sort((a, b) => a.id - b.id));
const current = computed(() => (selected.value === undefined ? undefined : sockets.get(selected.value)));
const shown = computed(() => current.value?.messages.slice(-SHOWN) ?? []);
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
  if (socket === undefined || connection === undefined) return;
  problem.value = "";
  try {
    const bytes = outgoing.mode === "hex" ? hexToBytes(outgoing.text) : textToBytes(outgoing.text);
    const to = socket.kind === "udp" ? { host: outgoing.toHost, port: Number(outgoing.toPort) } : undefined;
    await connection.command("send", { id: socket.id, data: bytesToBase64(bytes), ...(to === undefined ? {} : { to }) });
    remember(socket.id, { at: Date.now(), direction: "out", bytes, ...(to === undefined ? {} : { peer: to }) });
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
  if (socket.kind === "tcp-connection") return `connection of server #${socket.server}`;
  return kinds.find((kind) => kind.value === socket.kind)?.label ?? socket.kind;
}

function addresses(socket: SocketInfo): string {
  const local = `${socket.local.host}:${socket.local.port}`;
  return socket.remote === undefined ? local : `${local} ⇄ ${socket.remote.host}:${socket.remote.port}`;
}

/** The `data` events of a socket that didn't reach the window, as far as the counters tell. */
function missed(socket: SocketInfo): number {
  return Math.max(0, socket.events - socket.delivered);
}

function render(bytes: Uint8Array): string {
  return view.value === "hex" ? bytesToHex(bytes) : bytesToText(bytes);
}

function time(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour12: false }) + `.${String(at % 1000).padStart(3, "0")}`;
}

onMounted(async () => {
  try {
    connection = new Connection(await endpoint(), {
      state(next, text) {
        state.value = next;
        detail.value = text;
        if (next === "open") void refresh();
      },
      event: onEvent,
    });
    timer = setInterval(() => void refresh(), REFRESH);
  } catch (error) {
    state.value = "closed";
    detail.value = error instanceof Error ? error.message : String(error);
  }
});

onBeforeUnmount(() => {
  clearInterval(timer);
  connection?.close();
});
</script>

<template>
  <q-layout view="hHh lpR fFf">
    <q-header elevated>
      <q-toolbar>
        <q-toolbar-title>net-tool</q-toolbar-title>
        <q-chip :color="state === 'open' ? 'positive' : 'warning'" text-color="white" dense>
          {{ state }}
        </q-chip>
        <span class="text-caption">{{ detail }}</span>
      </q-toolbar>
    </q-header>
    <q-page-container>
      <q-page padding class="row q-col-gutter-md">
        <div class="col-12 col-md-4">
          <q-card>
            <q-card-section class="q-gutter-sm">
              <!-- No component here draws an icon: Quasar's icon font isn't among the example's packages. -->
              <q-btn-toggle v-model="form.kind" :options="kinds" spread no-caps dense />
              <q-input v-model="form.host" label="Host" dense outlined />
              <q-input v-model.number="form.port" type="number" label="Port (0 picks one)" dense outlined />
              <q-btn label="Open" color="primary" :disable="state !== 'open'" @click="open" />
            </q-card-section>
          </q-card>
          <q-list bordered separator class="q-mt-md">
            <q-item
              v-for="socket in sorted"
              :key="socket.id"
              clickable
              :active="socket.id === selected"
              @click="selected = socket.id"
            >
              <q-item-section>
                <q-item-label>#{{ socket.id }} {{ kindLabel(socket) }}</q-item-label>
                <q-item-label caption>{{ addresses(socket) }}</q-item-label>
                <q-item-label caption>
                  sent {{ socket.sent }} B · received {{ socket.received }} B
                  <span v-if="missed(socket) > 0"> · {{ missed(socket) }} events missed</span>
                </q-item-label>
              </q-item-section>
              <q-item-section side>
                <q-btn v-if="socket.open" flat dense label="Close" @click.stop="close(socket.id)" />
                <q-badge v-else color="grey" :label="socket.error ?? 'closed'" />
              </q-item-section>
            </q-item>
          </q-list>
        </div>
        <div class="col-12 col-md-8">
          <q-banner v-if="problem" class="bg-negative text-white q-mb-md" dense>{{ problem }}</q-banner>
          <q-card v-if="current">
            <q-card-section class="row items-center">
              <div class="col text-subtitle1">#{{ current.id }} {{ kindLabel(current) }}</div>
              <q-btn-toggle v-model="view" :options="modes" dense />
            </q-card-section>
            <q-separator />
            <q-card-section class="log">
              <div v-for="(message, index) in shown" :key="index" :class="message.direction">
                <span class="time">{{ time(message.at) }}</span>
                <span>{{ message.direction === "in" ? "←" : "→" }}</span>
                <span v-if="message.peer" class="peer">{{ message.peer.host }}:{{ message.peer.port }}</span>
                <span>{{ render(message.bytes) }}</span>
              </div>
            </q-card-section>
            <template v-if="current.open && current.kind !== 'tcp-server'">
              <q-separator />
              <q-card-section class="q-gutter-sm">
                <div v-if="current.kind === 'udp'" class="row q-col-gutter-sm">
                  <q-input v-model="outgoing.toHost" label="To host" dense outlined class="col" />
                  <q-input v-model.number="outgoing.toPort" type="number" label="To port" dense outlined class="col-4" />
                </div>
                <q-input
                  v-model="outgoing.text"
                  :label="outgoing.mode === 'hex' ? 'Hex, such as 68 65 6c 6c 6f' : 'Text'"
                  :error="hexProblem !== ''"
                  :error-message="hexProblem"
                  no-error-icon
                  type="textarea"
                  autogrow
                  outlined
                  dense
                />
                <div class="row items-center q-gutter-sm">
                  <q-btn-toggle v-model="outgoing.mode" :options="modes" dense />
                  <q-btn label="Send" color="primary" :disable="state !== 'open' || hexProblem !== ''" @click="send" />
                </div>
              </q-card-section>
            </template>
          </q-card>
        </div>
      </q-page>
    </q-page-container>
  </q-layout>
</template>

<style>
.log {
  font-family: ui-monospace, monospace;
  max-height: 50vh;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-all;
}
.log .time,
.log .peer {
  color: #888;
  margin-right: 0.5em;
}
.log .in {
  color: #1565c0;
}
.log .out {
  color: #2e7d32;
}
</style>
