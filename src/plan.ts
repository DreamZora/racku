/**
 * Plans of scanned racks: which instances exist, how they are wired, and where they sit.
 *
 * The planner is pure: it works on the FRU data of the scanned device types and never loads
 * device code. The plan file records a plan as text, one line per instance, so that layout
 * changes show up in review.
 *
 * @decision .agents/decisions/261116_233919-automatic-assembly.md#the-plan
 * @decision .agents/decisions/261116_233919-automatic-assembly.md#cycles
 * @decision .agents/decisions/261116_233919-automatic-assembly.md#start-priority
 * @decision .agents/decisions/261116_233919-automatic-assembly.md#placement
 * @decision .agents/decisions/261116_233919-automatic-assembly.md#plan-file
 */
import type { ConnectorInfo } from "./connector.ts";
import { RackError } from "./errors.ts";
import { checkDeviceName } from "./manifest.ts";
import type { NeedInfo } from "./protocol.ts";

/** A model the planner can place: one scanned device file, or a named variant of one. */
export interface PlanType {
  /** The model name: the device's model, or the variant's name. */
  name: string;
  height: number;
  priority: number;
  needs: Readonly<Record<string, NeedInfo>>;
  provides: Readonly<Record<string, ConnectorInfo>>;
}

/** Where a need is wired: an instance and one of its ports. */
export interface PlanWire {
  provider: string;
  port: string;
}

/** One instance of a plan. */
export interface PlannedInstance {
  name: string;
  /** The model the instance is made from. */
  model: string;
  /** The instance whose `own` need this copy serves, if it is a copy. */
  owner: string | undefined;
  /** The lowest slot it occupies. */
  u: number;
  height: number;
  wiring: Readonly<Record<string, PlanWire>>;
}

/** A plan: its instances ordered by slot, and the models that nothing uses. */
export interface Plan {
  instances: readonly PlannedInstance[];
  unused: readonly string[];
}

/** What {@link makePlan} works from. */
export interface PlanInput {
  types: ReadonlyMap<string, PlanType>;
  /** Models that get a shared instance of their own accord. */
  roots: readonly string[];
  /** Provider choices: connector id or `<model>.<need>`, mapped to a model name. */
  use: Readonly<Record<string, string>>;
  /** Rack capacity in U. */
  size: number;
}

interface Draft {
  name: string;
  type: PlanType;
  owner: string | undefined;
  wiring: Record<string, PlanWire>;
}

/**
 * Works out the plan of a scanned rack.
 *
 * @returns The instances with their slots and wiring, and the unused models.
 * @throws RackError `RACK_MANIFEST` for an unknown root, a need without a provider or with
 *   several, a cycle, a name collision, or a plan that does not fit the rack.
 */
export function makePlan(input: PlanInput): Plan {
  const drafts = expand(input);
  const instances = place([...drafts.values()], input.size);
  const used = new Set([...drafts.values()].map((draft) => draft.type.name));
  const unused = [...input.types.keys()].filter((name) => !used.has(name)).sort();
  return { instances, unused };
}

/** One step of an expansion path: an instance, its model, and the need that led to it. */
interface Step {
  instance: string;
  model: string;
  via: string;
}

/** Creates the instances that the roots need, directly or indirectly. */
function expand({ types, roots, use }: PlanInput): Map<string, Draft> {
  const drafts = new Map<string, Draft>();
  const describe = (model: string, owner: string | undefined) =>
    owner === undefined ? `the shared ${model}` : `the copy of ${model} for ${owner}`;
  const create = (name: string, type: PlanType, owner: string | undefined): Draft => {
    checkDeviceName(name);
    const taken = drafts.get(name);
    if (taken !== undefined) {
      throw new RackError(
        "RACK_MANIFEST",
        `${describe(type.name, owner)} and ${describe(taken.type.name, taken.owner)} would both be named ${name}`,
      );
    }
    const draft: Draft = { name, type, owner, wiring: {} };
    drafts.set(name, draft);
    return draft;
  };
  const visit = (draft: Draft, path: Step[]): void => {
    for (const [need, info] of Object.entries(draft.type.needs)) {
      const via = `${draft.name}.${need}`;
      // An every need starts nothing: place() puts what it reaches below the device.
      // @decision .agents/decisions/261121_065823-hot-plug-directories.md#every-needs
      if (info.every) {
        if (Object.hasOwn(use, `${draft.type.name}.${need}`)) {
          throw new RackError(
            "RACK_MANIFEST",
            `use ${draft.type.name}.${need}: an every need reaches every provider, and use picks none`,
          );
        }
        continue;
      }
      const { type, port } = provider(types, use, draft.type.name, need, info);
      const loop = path.findIndex((step) => step.model === type.name);
      if (loop >= 0) {
        const steps = [...path.slice(loop + 1).map((step) => step.via), via];
        const start = (path[loop] as Step).instance;
        throw new RackError("RACK_MANIFEST", `cycle: ${steps.join(" → ")} → ${start}`);
      }
      const shared = drafts.get(type.name);
      let target: Draft;
      if (!info.own && shared !== undefined && shared.owner === undefined && shared.type === type) {
        target = shared;
      } else {
        const owner = info.own ? draft.name : undefined;
        target = create(info.own ? `${draft.name}-${need}` : type.name, type, owner);
        visit(target, [...path, { instance: target.name, model: type.name, via }]);
      }
      draft.wiring[need] = { provider: target.name, port };
    }
  };
  for (const root of roots) {
    const type = types.get(root);
    if (type === undefined) {
      throw new RackError("RACK_MANIFEST", `root ${root} is not a scanned device model`);
    }
    const existing = drafts.get(type.name);
    if (existing !== undefined && existing.owner === undefined && existing.type === type) continue;
    const draft = create(type.name, type, undefined);
    visit(draft, [{ instance: draft.name, model: type.name, via: "" }]);
  }
  return drafts;
}

/**
 * Picks the provider type and port of a need: the one a `use` entry for the need names, the
 * address that `patched()` wires it to, the one a `use` entry for its connector names, or the
 * only candidate.
 *
 * @decision .agents/decisions/261118_071513-http-panel-device.md#needs-from-configuration
 */
function provider(
  types: ReadonlyMap<string, PlanType>,
  use: Readonly<Record<string, string>>,
  consumer: string,
  need: string,
  info: NeedInfo,
): { type: PlanType; port: string } {
  const where = `${consumer}.${need} (${info.id})`;
  const forNeed = use[`${consumer}.${need}`];
  if (forNeed === undefined && info.patched !== undefined) {
    const [model = "", port = ""] = info.patched.split(".");
    const type = types.get(model);
    if (type === undefined) {
      throw new RackError(
        "RACK_MANIFEST",
        `${where}: patched to ${info.patched}, but ${model} is not a scanned device model`,
      );
    }
    if (type.provides[port]?.id !== info.id) {
      throw new RackError(
        "RACK_MANIFEST",
        `${where}: patched to ${info.patched}, which is not a ${info.id} port`,
      );
    }
    return { type, port };
  }
  const chosen = forNeed ?? use[info.id];
  const candidates =
    chosen === undefined
      ? [...types.values()].filter((type) => portsFor(type, info).length > 0)
      : [types.get(chosen)].filter((type): type is PlanType => type !== undefined);
  if (chosen !== undefined && candidates.length === 0) {
    throw new RackError(
      "RACK_MANIFEST",
      `${where}: use names ${chosen}, which is not a scanned device model`,
    );
  }
  const [only, ...others] = candidates;
  if (only === undefined) {
    throw new RackError("RACK_MANIFEST", `${where}: no scanned device provides it`);
  }
  if (others.length > 0) {
    const list = candidates.map((type) => type.name).join(", ");
    throw new RackError(
      "RACK_MANIFEST",
      `${where} is ambiguous: ${list}; add a use entry for ${info.id} or ${consumer}.${need}`,
    );
  }
  const ports = portsFor(only, info);
  if (ports.length !== 1) {
    const reason =
      ports.length === 0 ? "does not provide it" : `provides it on ${ports.join(", ")}`;
    throw new RackError("RACK_MANIFEST", `${where}: ${only.name} ${reason}`);
  }
  return { type: only, port: ports[0] as string };
}

function portsFor(type: PlanType, info: NeedInfo): string[] {
  return Object.entries(type.provides)
    .filter(([, port]) => port.id === info.id)
    .map(([name]) => name);
}

/**
 * Orders the instances and assigns their slots: an instance comes after everything it needs;
 * among the ones that can come next, the highest effective priority goes first, then the lowest
 * layer, then the first name.
 */
function place(drafts: Draft[], size: number): PlannedInstance[] {
  const byName = new Map(drafts.map((draft) => [draft.name, draft]));
  // The instances that a draft's every needs reach sit below it, as the ones it needs do.
  // @decision .agents/decisions/261121_065823-hot-plug-directories.md#every-needs
  const reached = new Map<string, string[]>();
  for (const draft of drafts) {
    const names = new Set<string>();
    for (const info of Object.values(draft.type.needs)) {
      if (!info.every) continue;
      for (const other of drafts) {
        if (other === draft || other.owner !== undefined) continue;
        if (portsFor(other.type, info).length === 1) names.add(other.name);
      }
    }
    reached.set(draft.name, [...names]);
  }
  const providersOf = (draft: Draft) => [
    ...Object.values(draft.wiring).map((wire) => wire.provider),
    ...(reached.get(draft.name) ?? []),
  ];
  const layers = new Map<string, number>();
  const layer = (draft: Draft): number => {
    const known = layers.get(draft.name);
    if (known !== undefined) return known;
    let value = 0;
    for (const name of providersOf(draft)) {
      value = Math.max(value, layer(byName.get(name) as Draft) + 1);
    }
    layers.set(draft.name, value);
    return value;
  };
  const dependents = new Map<string, Draft[]>(drafts.map((draft) => [draft.name, []]));
  for (const draft of drafts) {
    for (const name of new Set(providersOf(draft))) dependents.get(name)?.push(draft);
  }
  const effective = new Map<string, number>();
  const priority = (draft: Draft): number => {
    const known = effective.get(draft.name);
    if (known !== undefined) return known;
    let value = draft.type.priority;
    for (const dependent of dependents.get(draft.name) ?? []) {
      value = Math.max(value, priority(dependent));
    }
    effective.set(draft.name, value);
    return value;
  };
  const placed = new Set<string>();
  const result: PlannedInstance[] = [];
  let u = 1;
  while (result.length < drafts.length) {
    let next: Draft | undefined;
    for (const draft of drafts) {
      if (placed.has(draft.name)) continue;
      if (!providersOf(draft).every((name) => placed.has(name))) continue;
      if (next === undefined || before(draft, next, priority, layer)) next = draft;
    }
    if (next === undefined) {
      const left = drafts.filter((draft) => !placed.has(draft.name));
      throw new RackError("RACK_MANIFEST", `cycle: ${cycleOf(left, byName, providersOf)}`);
    }
    placed.add(next.name);
    const { height } = next.type;
    if (u + height - 1 > size) {
      throw new RackError(
        "RACK_MANIFEST",
        `the plan needs more than the ${size}U of the rack: ${next.name} would end at U${u + height - 1}`,
      );
    }
    result.push({
      name: next.name,
      model: next.type.name,
      owner: next.owner,
      u,
      height,
      wiring: next.wiring,
    });
    u += height;
  }
  return result;
}

/**
 * A cycle among drafts that can't be placed, as `a → b → a`, where each step is a need, every
 * needs included.
 */
function cycleOf(
  left: readonly Draft[],
  byName: ReadonlyMap<string, Draft>,
  providersOf: (draft: Draft) => string[],
): string {
  const waiting = new Set(left.map((draft) => draft.name));
  // Every draft left waits for another one left, so following those steps comes round.
  let at = left[0]?.name ?? "";
  const path: string[] = [];
  while (!path.includes(at)) {
    path.push(at);
    const draft = byName.get(at) as Draft;
    at = providersOf(draft).find((name) => waiting.has(name)) ?? at;
  }
  const loop = path.slice(path.indexOf(at));
  return [...loop, at].join(" → ");
}

function before(
  a: Draft,
  b: Draft,
  priority: (draft: Draft) => number,
  layer: (draft: Draft) => number,
): boolean {
  if (priority(a) !== priority(b)) return priority(a) > priority(b);
  if (layer(a) !== layer(b)) return layer(a) < layer(b);
  return a.name < b.name;
}

// ---- The plan file ----

/**
 * Writes a plan as the text of a plan file.
 *
 * @param rackName Name of the rack, for the header.
 * @param plan The plan.
 * @returns One header comment and one line per instance, in slot order.
 */
export function formatPlan(rackName: string, plan: Plan): string {
  const lines = [
    `# racku plan of rack ${rackName}: slot, instance, model, owner, and wiring.`,
    "# Written by `rack dev` and `rack plan --write`; do not edit by hand.",
  ];
  for (const instance of plan.instances) lines.push(formatInstance(instance));
  return `${lines.join("\n")}\n`;
}

/** One instance as a line of a plan file: its slots, name, model, owner, and wiring. */
export function formatInstance(instance: PlannedInstance): string {
  const slot =
    instance.height === 1 ? `U${instance.u}` : `U${instance.u}-${instance.u + instance.height - 1}`;
  const wires = Object.entries(instance.wiring).map(
    ([need, wire]) => `${need}=${wire.provider}.${wire.port}`,
  );
  return [slot, instance.name, instance.model, instance.owner ?? "-", ...wires].join(" ");
}

/**
 * Reads the text of a plan file.
 *
 * @param text The file's contents.
 * @param where The file's name, for error messages.
 * @returns The instances the file records, in slot order.
 * @throws RackError `RACK_MANIFEST` when a line is malformed.
 */
export function parsePlan(text: string, where: string): PlannedInstance[] {
  const instances: PlannedInstance[] = [];
  for (const [index, raw] of text.split("\n").entries()) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const [slot = "", name = "", model = "", owner = "", ...wires] = line.split(/\s+/);
    const range = /^U(\d+)(?:-(\d+))?$/.exec(slot);
    const malformed = () =>
      new RackError("RACK_MANIFEST", `${where} line ${index + 1} is malformed: ${line}`);
    if (range === null || name === "" || model === "" || owner === "") throw malformed();
    const u = Number(range[1]);
    const top = range[2] === undefined ? u : Number(range[2]);
    if (top < u) throw malformed();
    const wiring: Record<string, PlanWire> = {};
    for (const wire of wires) {
      const match = /^([^=]+)=([^.]+)\.(.+)$/.exec(wire);
      if (match === null) throw malformed();
      wiring[match[1] as string] = { provider: match[2] as string, port: match[3] as string };
    }
    instances.push({
      name,
      model,
      owner: owner === "-" ? undefined : owner,
      u,
      height: top - u + 1,
      wiring,
    });
  }
  return instances.sort((a, b) => a.u - b.u);
}

/** The outcome of comparing a plan file with the plan the graph gives now. */
export type PlanFit =
  | { fits: true; plan: Plan; sameOrder: boolean }
  | { fits: false; differences: string[] };

/**
 * Compares the instances of a plan file with a computed plan. The file fits when it has the same
 * instances with the same models, owners, heights, and wiring, and its slots keep every instance
 * above what it needs, without overlaps, inside the rack.
 *
 * @param recorded The instances the plan file records.
 * @param computed The plan the graph and the priorities give now.
 * @param size Rack capacity in U.
 * @returns The plan to run, with the file's slots, or the differences.
 */
export function fitPlan(
  recorded: readonly PlannedInstance[],
  computed: Plan,
  size: number,
): PlanFit {
  const differences: string[] = [];
  const now = new Map(computed.instances.map((instance) => [instance.name, instance]));
  const then = new Map(recorded.map((instance) => [instance.name, instance]));
  for (const name of now.keys()) {
    if (!then.has(name)) differences.push(`${name} is new`);
  }
  for (const [name, old] of then) {
    const current = now.get(name);
    if (current === undefined) {
      differences.push(`${name} is gone`);
      continue;
    }
    if (old.model !== current.model) {
      differences.push(`${name} is made from ${current.model} now, not ${old.model}`);
    }
    if (old.owner !== current.owner) {
      differences.push(
        `${name} belongs to ${current.owner ?? "nobody"} now, not ${old.owner ?? "nobody"}`,
      );
    }
    if (old.height !== current.height) {
      differences.push(`${name} is ${current.height}U high now, not ${old.height}U`);
    }
    const needs = new Set([...Object.keys(old.wiring), ...Object.keys(current.wiring)]);
    for (const need of needs) {
      const a = old.wiring[need];
      const b = current.wiring[need];
      const text = (wire: PlanWire | undefined) =>
        wire === undefined ? "nothing" : `${wire.provider}.${wire.port}`;
      if (a?.provider !== b?.provider || a?.port !== b?.port) {
        differences.push(`${name}.${need} is wired to ${text(b)} now, not ${text(a)}`);
      }
    }
  }
  if (differences.length === 0) {
    const ordered = [...recorded].sort((a, b) => a.u - b.u);
    for (const [index, instance] of ordered.entries()) {
      const below = ordered[index - 1];
      if (below !== undefined && below.u + below.height > instance.u) {
        differences.push(`${instance.name} at U${instance.u} overlaps ${below.name}`);
      }
      if (instance.u < 1 || instance.u + instance.height - 1 > size) {
        differences.push(`${instance.name} at U${instance.u} is outside the ${size}U rack`);
      }
      for (const wire of Object.values(instance.wiring)) {
        const provider = then.get(wire.provider);
        if (provider !== undefined && provider.u >= instance.u) {
          differences.push(`${instance.name} at U${instance.u} is not above ${provider.name}`);
        }
      }
    }
  }
  if (differences.length > 0) return { fits: false, differences };
  const plan: Plan = {
    instances: recorded
      .map((instance) => ({
        ...instance,
        wiring: (now.get(instance.name) as PlannedInstance).wiring,
      }))
      .sort((a, b) => a.u - b.u),
    unused: computed.unused,
  };
  const sameOrder = computed.instances.every(
    (instance) => then.get(instance.name)?.u === instance.u,
  );
  return { fits: true, plan, sameOrder };
}

// ---- Hot-plug devices ----

/** What {@link placeHotplug} works from. */
export interface HotplugInput {
  /** The plan of the fixed instances that runs, with their slots. */
  fixed: Plan;
  /** The models that `devices` gives: the types of the fixed instances, and those of copies. */
  types: ReadonlyMap<string, PlanType>;
  /** The hot-plug models, each under its model name. */
  hotplug: readonly PlanType[];
  /** Provider choices; only those by connector id apply to hot-plug devices. */
  use: Readonly<Record<string, string>>;
  /** Rack capacity in U. */
  size: number;
}

/** An instance of a rack with hot-plug directories. */
export interface RunningInstance extends PlannedInstance {
  /** A hot-plug device, or a copy that one owns. */
  hotplug: boolean;
}

/** Where the hot-plug devices go, and which can't run. */
export interface HotplugPlan {
  /** The fixed instances at their new slots, and the hot-plug instances, in slot order. */
  instances: readonly RunningInstance[];
  /** The hot-plug models that can't run, each with why. */
  leftOut: ReadonlyMap<string, string>;
}

/** Why a hot-plug device can't run. */
class LeftOut extends Error {}

/**
 * Places hot-plug devices around the plan of the fixed instances, which they leave as it is:
 * each, with its copies, directly below the lowest fixed instance that has an every need for a
 * connector that it provides, or above the top one when none has. Hot-plug devices at the same
 * place go in order of priority, highest first, then of name, and the fixed instances above them
 * move up by their height. A hot-plug device whose needs fixed shared instances don't meet, or
 * that can't sit above them, or that finds no room, is left out.
 *
 * @decision .agents/decisions/261121_065823-hot-plug-directories.md#where-hot-plug-devices-go
 */
export function placeHotplug(input: HotplugInput): HotplugPlan {
  const { fixed, types, use, size } = input;
  const order = [...fixed.instances].sort((a, b) => a.u - b.u);
  const index = new Map(order.map((instance, i) => [instance.name, i]));
  const shared = new Map(
    order.filter((instance) => instance.owner === undefined).map((i) => [i.name, i]),
  );
  const typeOf = (instance: PlannedInstance) => types.get(instance.model);
  const collects = order.map(
    (instance) =>
      new Set(
        Object.values(typeOf(instance)?.needs ?? {})
          .filter((info) => info.every)
          .map((info) => info.id),
      ),
  );
  const taken = new Set(order.map((instance) => instance.name));
  const leftOut = new Map<string, string>();
  const groups = new Map<number, Draft[][]>();
  let end = order.reduce((top, instance) => Math.max(top, instance.u + instance.height - 1), 0);
  const sorted = [...input.hotplug].sort(
    (a, b) => b.priority - a.priority || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  );
  for (const type of sorted) {
    try {
      const group = expandHotplug(type, types, shared, typeOf, use);
      for (const draft of group) {
        if (taken.has(draft.name)) {
          throw new LeftOut(`its instance ${draft.name} would take the name of another instance`);
        }
      }
      // The lowest fixed instance whose every need reaches it, or the top.
      let at = order.findIndex((_, i) =>
        [...(collects[i] ?? [])].some((id) => portsFor(type, { id } as NeedInfo).length === 1),
      );
      if (at < 0) at = order.length;
      const host = order[at];
      for (const draft of group) {
        for (const wire of Object.values(draft.wiring)) {
          const below = index.get(wire.provider);
          if (host !== undefined && below !== undefined && below >= at) {
            throw new LeftOut(
              `it needs ${wire.provider}, which sits above ${host.name}, whose every need reaches it`,
            );
          }
        }
      }
      const height = group.reduce((sum, draft) => sum + draft.type.height, 0);
      if (end + height > size) {
        throw new LeftOut(
          `the rack has no room for it: it would end at U${end + height} of ${size}`,
        );
      }
      end += height;
      for (const draft of group) taken.add(draft.name);
      groups.set(at, [...(groups.get(at) ?? []), group]);
    } catch (error) {
      if (!(error instanceof LeftOut || error instanceof RackError)) throw error;
      leftOut.set(type.name, error.message);
    }
  }
  const instances: RunningInstance[] = [];
  const add = (draft: Draft, u: number) => {
    const { name, type, owner, wiring } = draft;
    instances.push({
      name,
      model: type.name,
      owner,
      u,
      height: type.height,
      wiring,
      hotplug: true,
    });
  };
  let shift = 0;
  let top = 0;
  order.forEach((instance, i) => {
    let u = instance.u + shift;
    for (const group of groups.get(i) ?? []) {
      for (const draft of group) {
        add(draft, u);
        u += draft.type.height;
        shift += draft.type.height;
      }
    }
    instances.push({ ...instance, u: instance.u + shift, hotplug: false });
    top = Math.max(top, instance.u + shift + instance.height - 1);
  });
  let u = top + 1;
  for (const group of groups.get(order.length) ?? []) {
    for (const draft of group) {
      add(draft, u);
      u += draft.type.height;
    }
  }
  return { instances, leftOut };
}

/**
 * A hot-plug device with the copies that it owns, in the order of their slots: copies of copies
 * first, the device last. Shared needs go to fixed shared instances, and own needs to copies of
 * the models that `devices` gives.
 *
 * @throws LeftOut when a need can't be met.
 */
function expandHotplug(
  type: PlanType,
  types: ReadonlyMap<string, PlanType>,
  shared: ReadonlyMap<string, PlannedInstance>,
  typeOf: (instance: PlannedInstance) => PlanType | undefined,
  use: Readonly<Record<string, string>>,
): Draft[] {
  const drafts: Draft[] = [];
  const visit = (draft: Draft, path: string[]): void => {
    for (const [need, info] of Object.entries(draft.type.needs)) {
      const where = `${draft.name}.${need} (${info.id})`;
      if (info.every) {
        throw new LeftOut(`${where} is an every need, which a hot-plug device can't have`);
      }
      if (info.own) {
        const model = copyModel(where, info, types, use);
        if (path.includes(model.name)) {
          throw new LeftOut(`cycle: ${[...path, model.name].join(" → ")}`);
        }
        const port = portsFor(model, info);
        if (port.length !== 1)
          throw new LeftOut(`${where}: ${model.name} provides it on ${port.join(", ")}`);
        const copy: Draft = {
          name: `${draft.name}-${need}`,
          type: model,
          owner: draft.name,
          wiring: {},
        };
        visit(copy, [...path, model.name]);
        drafts.push(copy);
        draft.wiring[need] = { provider: copy.name, port: port[0] as string };
        continue;
      }
      draft.wiring[need] = sharedWire(where, info, shared, typeOf, use);
    }
  };
  const device: Draft = { name: type.name, type, owner: undefined, wiring: {} };
  checkDeviceName(device.name);
  visit(device, [type.name]);
  drafts.push(device);
  return drafts;
}

/** The fixed shared instance and port that meet a shared need of a hot-plug instance. */
function sharedWire(
  where: string,
  info: NeedInfo,
  shared: ReadonlyMap<string, PlannedInstance>,
  typeOf: (instance: PlannedInstance) => PlanType | undefined,
  use: Readonly<Record<string, string>>,
): PlanWire {
  const portOf = (instance: PlannedInstance, port: string): ConnectorInfo | undefined =>
    typeOf(instance)?.provides[port];
  if (info.patched !== undefined) {
    const [model = "", port = ""] = info.patched.split(".");
    const instance = shared.get(model);
    const target = instance && portOf(instance, port);
    if (instance === undefined) {
      throw new LeftOut(`${where}: patched to ${info.patched}, which the rack doesn't run`);
    }
    if (target === undefined || target.id !== info.id || !covers(target, info)) {
      throw new LeftOut(`${where}: patched to ${info.patched}, which is not a ${info.id} port`);
    }
    return { provider: model, port };
  }
  const chosen = use[info.id];
  const candidates =
    chosen === undefined
      ? [...shared.values()].filter((instance) => {
          const type = typeOf(instance);
          return type !== undefined && portsFor(type, info).length > 0;
        })
      : [shared.get(chosen)].filter((instance) => instance !== undefined);
  const [only, ...others] = candidates;
  if (only === undefined) {
    throw new LeftOut(
      chosen === undefined
        ? `${where}: no device of the rack provides it`
        : `${where}: use names ${chosen}, which the rack doesn't run`,
    );
  }
  if (others.length > 0) {
    const list = candidates.map((instance) => instance.name).join(", ");
    throw new LeftOut(`${where} is ambiguous: ${list}; add a use entry for ${info.id}`);
  }
  const type = typeOf(only) as PlanType;
  const ports = portsFor(type, info);
  const port = ports[0];
  if (ports.length !== 1 || port === undefined) {
    throw new LeftOut(`${where}: ${only.name} provides it on ${ports.join(", ")}`);
  }
  if (!covers(type.provides[port] as ConnectorInfo, info)) {
    throw new LeftOut(`${where}: ${only.name}.${port} lacks members that it calls`);
  }
  return { provider: only.name, port };
}

/** The model of `devices` that a copy for an own need of a hot-plug instance is made from. */
function copyModel(
  where: string,
  info: NeedInfo,
  types: ReadonlyMap<string, PlanType>,
  use: Readonly<Record<string, string>>,
): PlanType {
  const chosen = use[info.id];
  const candidates =
    chosen === undefined
      ? [...types.values()].filter((type) => portsFor(type, info).length > 0)
      : [types.get(chosen)].filter((type): type is PlanType => type !== undefined);
  const [only, ...others] = candidates;
  if (only === undefined) throw new LeftOut(`${where}: no model of devices provides it`);
  if (others.length > 0) {
    const list = candidates.map((type) => type.name).join(", ");
    throw new LeftOut(`${where} is ambiguous: ${list}; add a use entry for ${info.id}`);
  }
  return only;
}

function covers(provider: ConnectorInfo, need: ConnectorInfo): boolean {
  return Object.entries(need.members).every(([member, kind]) => provider.members[member] === kind);
}
