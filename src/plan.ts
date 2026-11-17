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

/** Picks the provider type and port of a need: the one `use` names, or the only candidate. */
function provider(
  types: ReadonlyMap<string, PlanType>,
  use: Readonly<Record<string, string>>,
  consumer: string,
  need: string,
  info: NeedInfo,
): { type: PlanType; port: string } {
  const where = `${consumer}.${need} (${info.id})`;
  const chosen = use[`${consumer}.${need}`] ?? use[info.id];
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
  const providersOf = (draft: Draft) => Object.values(draft.wiring).map((wire) => wire.provider);
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
    if (next === undefined) throw new RackError("RACK_MANIFEST", "the plan has a cycle");
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
    `# rack42u plan of rack ${rackName}: slot, instance, model, owner, and wiring.`,
    "# Written by `rack dev` and `rack plan --write`; do not edit by hand.",
  ];
  for (const instance of plan.instances) {
    const slot =
      instance.height === 1
        ? `U${instance.u}`
        : `U${instance.u}-${instance.u + instance.height - 1}`;
    const wires = Object.entries(instance.wiring).map(
      ([need, wire]) => `${need}=${wire.provider}.${wire.port}`,
    );
    lines.push([slot, instance.name, instance.model, instance.owner ?? "-", ...wires].join(" "));
  }
  return `${lines.join("\n")}\n`;
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
