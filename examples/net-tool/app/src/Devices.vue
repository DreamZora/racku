<script setup lang="ts">
/**
 * The Devices dialog: each device of the rack, with its state, what it runs, and its error; the
 * directory that replacements go in; the setting `replaceDevices`, and the one the rack uses; and
 * Reload, which runs `ctl reload` and shows what it replaced and what failed.
 *
 * @decision .agents/decisions/261120_203926-net-tool-installers.md#the-devices-dialog
 */
import { invoke } from "@tauri-apps/api/core";
import { copyToClipboard } from "quasar";
import { ref, watch } from "vue";
import { icons } from "./icons.ts";

const open = defineModel<boolean>({ required: true });

type Mode = "manual" | "automatic";

interface WireError {
  code: string;
  message: string;
}

/** What the shell knows of the setting. */
interface Settings {
  baseDir: string;
  fromSource: boolean;
  replaceDevices: Mode;
  inUse: Mode;
  error: string | null;
}

/** A device as `ctl status` reports it. */
interface Device {
  name: string;
  state: string;
  source: string;
  packaged?: true;
  firmware: string | null;
  error?: WireError;
}

interface DevicesView {
  devices: Device[] | null;
  error: string | null;
  settings: Settings;
}

/** What `ctl reload` did to one device. */
interface ReloadResult {
  device: string;
  mode: string;
  from: string | null;
  to: string | null;
  error?: WireError;
}

const modes: { label: string; value: Mode }[] = [
  { label: "Manual", value: "manual" },
  { label: "Automatic", value: "automatic" },
];

const view = ref<DevicesView>();
const problem = ref("");
const busy = ref(false);
const results = ref<ReloadResult[]>();
const copied = ref(false);

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function load(): Promise<void> {
  try {
    view.value = await invoke<DevicesView>("devices");
  } catch (error) {
    problem.value = message(error);
  }
}

async function reload(): Promise<void> {
  busy.value = true;
  problem.value = "";
  results.value = undefined;
  try {
    results.value = await invoke<ReloadResult[]>("reload_devices");
  } catch (error) {
    problem.value = message(error);
  } finally {
    busy.value = false;
  }
  await load();
}

async function choose(mode: Mode): Promise<void> {
  if (view.value === undefined || view.value.settings.replaceDevices === mode) return;
  try {
    view.value.settings = await invoke<Settings>("set_replace_devices", { mode });
  } catch (error) {
    problem.value = message(error);
  }
}

async function copy(text: string): Promise<void> {
  try {
    await copyToClipboard(text);
    copied.value = true;
  } catch (error) {
    problem.value = message(error);
  }
}

/** What a device runs: its packaged firmware, or its file, by its path in the base directory. */
function runs(device: Device): string {
  if (device.packaged === true) return "packaged";
  const base = view.value?.settings.baseDir ?? "";
  return device.source.startsWith(base) ? device.source.slice(base.length + 1) : device.source;
}

function label(mode: Mode): string {
  return mode === "manual" ? "Manual" : "Automatic";
}

watch(open, (now) => {
  if (!now) return;
  problem.value = "";
  results.value = undefined;
  copied.value = false;
  void load();
});
</script>

<template>
  <q-dialog v-model="open">
    <q-card class="devices">
      <div class="devices-head">
        <div class="grow">
          <div class="devices-title">Devices</div>
          <div class="devices-subtitle">The rack's devices, and how files replace them.</div>
        </div>
        <q-btn v-close-popup flat round dense size="sm" title="Close">
          <q-icon :name="icons.close" size="16px" />
        </q-btn>
      </div>

      <div v-if="problem" class="notice devices-notice">
        <span>{{ problem }}</span>
      </div>

      <template v-if="view">
        <div v-if="view.error" class="notice devices-notice">
          <span>{{ view.error }}</span>
        </div>
        <div v-if="view.devices" class="device-list">
          <div v-for="device in view.devices" :key="device.name" class="device">
            <span class="light" :class="device.state === 'online' ? 'open' : 'warn-light'" />
            <span class="device-name">{{ device.name }}</span>
            <span class="device-runs mono" :class="{ packaged: device.packaged }">{{ runs(device) }}</span>
            <span class="device-state" :class="device.state">{{ device.state }}</span>
            <div v-if="device.error" class="device-error mono">
              {{ device.error.code }}: {{ device.error.message }}
            </div>
          </div>
        </div>

        <div class="devices-section">
          <div class="section-title">Replacing a device</div>
          <p v-if="view.settings.fromSource" class="devices-text">
            This build runs the rack from source, with <code>rack start</code>. Reload applies your edits of
            <code>devices/</code> in this directory; the setting below is the installed app's.
          </p>
          <p v-else class="devices-text">
            A <code>devices/ui.ts</code> or <code>devices/net.ts</code> in this directory replaces the
            device packaged in the app. Both import <code>../connectors.ts</code>, so put a
            <code>connectors.ts</code> beside <code>devices/</code> too.
          </p>
          <div class="path">
            <span class="path-text mono">{{ view.settings.baseDir }}</span>
            <q-btn flat dense no-caps size="sm" class="path-copy" @click="copy(view.settings.baseDir)">
              <q-icon :name="copied ? icons.check : icons.copy" size="14px" class="q-mr-xs" />
              {{ copied ? "Copied" : "Copy" }}
            </q-btn>
          </div>
        </div>

        <div class="devices-section">
          <div class="section-title">When a file applies</div>
          <div class="segmented modes">
            <button
              v-for="mode in modes"
              :key="mode.value"
              type="button"
              :class="{ on: view.settings.replaceDevices === mode.value }"
              @click="choose(mode.value)"
            >
              {{ mode.label }}
            </button>
          </div>
          <p class="devices-text">
            <b>Manual:</b> when the app starts, and at Reload. <b>Automatic:</b> also as soon as the file
            is written.
          </p>
          <p class="devices-text in-use">
            The rack uses {{ label(view.settings.inUse) }}<span v-if="view.settings.replaceDevices !== view.settings.inUse">;
              {{ label(view.settings.replaceDevices) }} applies at the next start</span>.
          </p>
          <div v-if="view.settings.error" class="notice">
            <span>{{ view.settings.error }}</span>
          </div>
        </div>
      </template>

      <div v-if="results" class="devices-section results">
        <div v-if="results.length === 0" class="faint">Reload replaced nothing: no firmware changed.</div>
        <div v-for="result in results" :key="result.device" class="result" :class="{ failed: result.error }">
          <q-icon :name="result.error ? icons.close : icons.check" size="14px" />
          <span v-if="result.error" class="mono">
            {{ result.device }} failed: {{ result.error.code }}: {{ result.error.message }}
          </span>
          <span v-else>
            <b>{{ result.device }}</b> replaced, {{ result.mode }}
          </span>
        </div>
      </div>

      <div class="devices-actions">
        <q-btn v-close-popup flat no-caps label="Close" class="devices-close" />
        <q-btn unelevated no-caps color="primary" :loading="busy" @click="reload">
          <q-icon :name="icons.reload" size="16px" class="q-mr-xs" />
          Reload
        </q-btn>
      </div>
    </q-card>
  </q-dialog>
</template>

<style>
.devices {
  width: 600px;
  max-width: 92vw;
  border-radius: 12px !important;
  background: var(--nt-surface) !important;
  color: var(--nt-text);
}
.devices-head {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 18px 16px 12px 20px;
}
.devices-title {
  font-size: 16px;
  font-weight: 600;
}
.devices-subtitle {
  margin-top: 2px;
  color: var(--nt-muted);
}
.devices-notice {
  margin: 0 20px 12px;
}
.device-list {
  margin: 0 20px;
  border: 1px solid var(--nt-border);
  border-radius: 10px;
  overflow: hidden;
}
.device {
  display: grid;
  grid-template-columns: 8px 110px 1fr auto;
  align-items: center;
  gap: 4px 12px;
  padding: 10px 14px;
}
.device + .device {
  border-top: 1px solid var(--nt-border);
}
.light.warn-light {
  background: var(--nt-warn);
}
.device-name {
  font-weight: 600;
}
.device-runs {
  font-size: 12px;
  color: var(--nt-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.device-runs.packaged {
  color: var(--nt-faint);
}
.device-state {
  padding: 1px 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
  color: var(--nt-muted);
  background: var(--nt-sunken);
  border: 1px solid var(--nt-border);
}
.device-state.online {
  color: var(--nt-ok);
  background: color-mix(in srgb, var(--nt-ok) 10%, transparent);
  border-color: color-mix(in srgb, var(--nt-ok) 30%, transparent);
}
.device-state.degraded {
  color: var(--nt-warn);
  background: color-mix(in srgb, var(--nt-warn) 10%, transparent);
  border-color: color-mix(in srgb, var(--nt-warn) 30%, transparent);
}
.device-error {
  grid-column: 2 / -1;
  font-size: 11.5px;
  color: var(--nt-bad);
  overflow-wrap: anywhere;
}
.devices-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 16px 20px 0;
}
.devices-text {
  margin: 0;
  color: var(--nt-muted);
  line-height: 1.55;
}
.devices-text code {
  padding: 0 4px;
  border-radius: 4px;
  background: var(--nt-sunken);
  font-family: var(--nt-mono);
  font-size: 12px;
  color: var(--nt-text);
}
.devices-text.in-use {
  color: var(--nt-text);
}
.path {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 4px 4px 12px;
  border-radius: 8px;
  border: 1px solid var(--nt-border);
  background: var(--nt-sunken);
}
.path-text {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.path-copy {
  color: var(--nt-muted);
}
.segmented.modes {
  align-self: flex-start;
}
.segmented.modes button {
  min-width: 110px;
}
.results {
  padding: 10px 12px;
  border-radius: 10px;
  border: 1px solid var(--nt-border);
  background: var(--nt-sunken);
  gap: 6px;
}
.result {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  color: var(--nt-ok);
}
.result span {
  color: var(--nt-text);
  overflow-wrap: anywhere;
}
.result.failed,
.result.failed span {
  color: var(--nt-bad);
}
.result .q-icon {
  margin-top: 2px;
}
.devices-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 18px 20px 18px;
}
.devices-close {
  color: var(--nt-muted);
}
</style>
