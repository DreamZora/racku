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

const modes = [
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
  if (view.value === undefined) return;
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
    <q-card style="min-width: 560px; max-width: 90vw">
      <q-card-section class="text-h6">Devices</q-card-section>
      <q-banner v-if="problem" class="bg-negative text-white" dense>{{ problem }}</q-banner>
      <template v-if="view">
        <q-banner v-if="view.error" class="bg-warning" dense>{{ view.error }}</q-banner>
        <q-list v-if="view.devices" dense separator>
          <q-item v-for="device in view.devices" :key="device.name">
            <q-item-section>
              <q-item-label>{{ device.name }}</q-item-label>
              <q-item-label caption>{{ runs(device) }}</q-item-label>
              <q-item-label v-if="device.error" caption class="text-negative">
                {{ device.error.code }}: {{ device.error.message }}
              </q-item-label>
            </q-item-section>
            <q-item-section side>
              <q-badge :color="device.state === 'online' ? 'positive' : 'warning'" :label="device.state" />
            </q-item-section>
          </q-item>
        </q-list>
        <q-separator />
        <q-card-section class="q-gutter-sm">
          <div class="text-subtitle2">Replacing a device</div>
          <div v-if="view.settings.fromSource" class="text-caption">
            This build runs the rack from source, with <code>rack start</code>: Reload applies edits of
            <code>devices/</code> there. The setting below is the installed app's.
          </div>
          <div v-else class="text-caption">
            A <code>devices/ui.ts</code> or <code>devices/net.ts</code> in this directory, with
            <code>connectors.ts</code> beside <code>devices/</code>, replaces the device packaged in the app:
          </div>
          <div class="row items-center q-gutter-sm">
            <code class="col">{{ view.settings.baseDir }}</code>
            <q-btn flat dense no-caps :label="copied ? 'Copied' : 'Copy'" @click="copy(view.settings.baseDir)" />
          </div>
          <q-btn-toggle
            :model-value="view.settings.replaceDevices"
            :options="modes"
            no-caps
            dense
            @update:model-value="choose"
          />
          <div class="text-caption">
            Manual: a file applies when the app starts, and at Reload. Automatic: also as soon as it is
            written. The rack uses {{ label(view.settings.inUse) }}<span
              v-if="view.settings.replaceDevices !== view.settings.inUse"
            >; {{ label(view.settings.replaceDevices) }} applies at the next start</span>.
          </div>
          <q-banner v-if="view.settings.error" class="bg-warning" dense>{{ view.settings.error }}</q-banner>
        </q-card-section>
      </template>
      <q-card-section v-if="results" class="q-gutter-xs">
        <div v-if="results.length === 0" class="text-caption">Reload replaced nothing: no firmware changed.</div>
        <div v-for="result in results" :key="result.device">
          <span v-if="result.error" class="text-negative">
            {{ result.device }} failed: {{ result.error.code }}: {{ result.error.message }}
          </span>
          <span v-else>{{ result.device }} replaced, {{ result.mode }}</span>
        </div>
      </q-card-section>
      <q-card-actions align="right">
        <q-btn label="Reload" color="primary" :loading="busy" @click="reload" />
        <q-btn v-close-popup flat label="Close" />
      </q-card-actions>
    </q-card>
  </q-dialog>
</template>
