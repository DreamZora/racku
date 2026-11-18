/**
 * Tests for applying a changed plan, or an edited manifest, to a running rack: devices are
 * plugged, moved, rewired, replaced, and unplugged while the rest keeps running.
 *
 * @decision .agents/decisions/261116_233956-cold-swaps-and-restarts.md#applying-a-changed-plan
 */
import { afterEach, describe, expect, test } from "bun:test";
import { type RackSpec, rack, slot } from "rack42u";
import { errorOf, type TempApp, tempApp, useRacks } from "./fixtures/app.ts";

const startRack = useRacks();

const apps: TempApp[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.remove()));
});

const CONNECTORS = `import { connector, rpc } from "rack42u";
import * as v from "valibot";

const counter = (id: string) => connector(id, { inc: rpc(v.undefined(), v.number()) });
export const D = counter("demo.d/v1");
export const E = counter("demo.e/v1");
export const F = counter("demo.f/v1");
/** Increments through one of the device's needs, named by the input. */
export const Poke = connector("demo.poke/v1", { inc: rpc(v.string(), v.number()) });
/** Reports a device's configured label. */
export const Label = connector("demo.label/v1", { label: rpc(v.undefined(), v.string()) });
`;

function counter(model: string, connector: string): string {
  return `import { device } from "rack42u";
import { D, E, F } from "../connectors.ts";

let n = 0;

export default device({
  model: "${model}",
  provides: { ${model}: ${connector} },
  powerOn: () => ({ ${model}: { inc: () => ++n } }),
});
`;
}

function consumer(model: string, needs: Record<string, string>): string {
  const list = Object.entries(needs)
    .map(([need, connector]) => `${need}: ${connector}`)
    .join(", ");
  return `import { device, own } from "rack42u";
import { D, E, F, Poke } from "../connectors.ts";

export default device({
  model: "${model}",
  needs: { ${list} },
  provides: { poke: Poke },
  powerOn: (ctx) => ({ poke: { inc: (need) => ctx.ports[need].inc(undefined) } }),
});
`;
}

const LABEL = `import { device } from "rack42u";
import * as v from "valibot";
import { Label } from "../connectors.ts";

export default device({
  model: "label",
  config: v.object({ label: v.string() }),
  provides: { label: Label },
  powerOn: (ctx) => ({ label: { label: () => ctx.config.label } }),
});
`;

async function app(files: Record<string, string>): Promise<TempApp> {
  const created = await tempApp();
  apps.push(created);
  await created.write("connectors.ts", CONNECTORS);
  for (const [path, content] of Object.entries(files)) await created.write(path, content);
  return created;
}

/** A, B, and C over D, E, and F: A owns D and F, B shares E, C shares E and owns F. */
function scannedFiles(): Record<string, string> {
  return {
    "devices/a.ts": consumer("a", { d: "own(D)", f: "own(F)" }),
    "devices/b.ts": consumer("b", { e: "E" }),
    "devices/c.ts": consumer("c", { e: "E", f: "own(F)" }),
    "devices/d.ts": counter("d", "D"),
    "devices/e.ts": counter("e", "E"),
    "devices/f.ts": counter("f", "F"),
  };
}

const SCANNED = { devices: ["./devices"], roots: ["a", "b", "c"] };

function summary(results: { device: string; mode: string; error?: { code: string } }[]) {
  return results.map((result) => [result.device, result.mode, result.error?.code ?? null]);
}

describe("changed plans", () => {
  test("README.md: under rack dev, reload plugs, replaces, and unplugs instances to follow a changed plan", async () => {
    const created = await app(scannedFiles());
    const { running } = await startRack(SCANNED, { baseDir: created.dir, plan: "update" });
    await running.call("a.poke", "inc", "f");
    // b now also needs the shared d, and c shares f instead of owning a copy.
    await created.write("devices/b.ts", consumer("b", { e: "E", d: "D" }));
    await created.write("devices/c.ts", consumer("c", { e: "E", f: "F" }));
    expect(summary(await running.reload())).toEqual([
      ["d", "plug", null],
      ["f", "plug", null],
      ["b", "hot", null],
      ["c", "hot", null],
      ["c-f", "unplug", null],
    ]);
    expect(running.status().map((s) => s.name)).toEqual([
      "a-d",
      "a-f",
      "d",
      "e",
      "f",
      "a",
      "b",
      "c",
    ]);
    expect([
      await running.call("b.poke", "inc", "d"),
      await running.call("c.poke", "inc", "f"),
    ]).toEqual([1, 1]);
    // a's own copy of f kept running, and kept its count.
    expect(await running.call("a.poke", "inc", "f")).toBe(2);
    const plan = await created.read("test.plan");
    expect(plan).toContain("\nU5 f f -\n");
    expect(plan).not.toContain("c-f");
  });

  test("README.md: a changed use entry rewires needs without restarting their devices", async () => {
    const created = await app({ ...scannedFiles(), "devices/e2.ts": counter("e2", "E") });
    const first = { ...SCANNED, use: { "demo.e/v1": "e" } };
    const { running, rec } = await startRack(first, { baseDir: created.dir, plan: false });
    await running.call("b.poke", "inc", "e");
    const results = await running.reload(rack("test", { ...SCANNED, use: { "demo.e/v1": "e2" } }));
    expect(summary(results)).toEqual([
      ["e2", "plug", null],
      ["e", "unplug", null],
    ]);
    expect([
      await running.call("b.poke", "inc", "e"),
      await running.call("c.poke", "inc", "e"),
    ]).toEqual([1, 2]);
    // The recorder listens from the end of start(), so b powering on again would show here.
    const restartsOfB = rec.events.filter(
      (event) => event.type === "power" && "device" in event && event.device === "b",
    );
    expect(restartsOfB).toEqual([]);
  });
});

describe("edited manifests", () => {
  const files = () => ({
    "devices/d.ts": counter("d", "D"),
    "devices/e.ts": counter("e", "E"),
    "devices/x.ts": consumer("x", { d: "D" }),
    "devices/y.ts": consumer("y", { e: "E" }),
    "devices/label.ts": LABEL,
  });

  test("README.md: an edited manifest plugs new devices, moves others, and unplugs removed ones while the rack runs", async () => {
    const created = await app(files());
    const { running } = await startRack(
      { slots: { 1: slot("./devices/d.ts"), 3: slot("./devices/x.ts") } },
      { baseDir: created.dir },
    );
    await running.call("x.poke", "inc", "d");
    const edited: RackSpec = {
      slots: {
        1: slot("./devices/d.ts"),
        2: slot("./devices/e.ts"),
        4: slot("./devices/x.ts"),
        5: slot("./devices/y.ts"),
      },
    };
    expect(summary(await running.reload(rack("test", edited)))).toEqual([
      ["e", "plug", null],
      ["y", "plug", null],
    ]);
    expect(running.status().map((s) => `U${s.u} ${s.name}`)).toEqual([
      "U1 d",
      "U2 e",
      "U4 x",
      "U5 y",
    ]);
    // x moved to U4 without a restart: its provider kept its count.
    expect(await running.call("x.poke", "inc", "d")).toBe(2);
    expect(await running.call("y.poke", "inc", "e")).toBe(1);
    const shrunk = await running.reload(
      rack("test", { slots: { 1: slot("./devices/d.ts"), 4: slot("./devices/x.ts") } }),
    );
    expect(summary(shrunk)).toEqual([
      ["y", "unplug", null],
      ["e", "unplug", null],
    ]);
  });

  test("README.md: a changed configuration replaces the device, and a changed patch rewires without a restart", async () => {
    const created = await app(files());
    const labelled = (label: string, target: string): RackSpec => ({
      slots: {
        1: slot("./devices/d.ts", { name: "d1" }),
        2: slot("./devices/d.ts", { name: "d2" }),
        3: slot("./devices/label.ts", { config: { label } }),
        4: slot("./devices/x.ts"),
      },
      patch: [["x.d", `${target}.d`]],
    });
    const { running } = await startRack(labelled("one", "d1"), { baseDir: created.dir });
    await running.call("x.poke", "inc", "d");
    await running.call("x.poke", "inc", "d");
    expect(summary(await running.reload(rack("test", labelled("two", "d2"))))).toEqual([
      ["label", "hot", null],
    ]);
    expect(await running.call("label.label", "label", undefined)).toBe("two");
    // x now reaches d2, which has not counted yet; x itself was not replaced.
    expect(await running.call("x.poke", "inc", "d")).toBe(1);
  });

  test("README.md: a manifest edit that needs a restart is refused, and the rack keeps running", async () => {
    const created = await app(files());
    const placed = { slots: { 1: slot("./devices/d.ts") } };
    const { running } = await startRack(placed, { baseDir: created.dir });
    const renamed = await errorOf(running.reload(rack("other", placed)));
    expect([renamed.code, renamed.message]).toEqual([
      "RACK_SWAP_REJECTED",
      "restart the rack to rename it",
    ]);
    const scanned = await errorOf(running.reload(rack("test", { devices: ["./devices"] })));
    expect(scanned.message).toBe("restart the rack to switch between slots and scanned devices");
    expect(running.status().map((s) => s.state)).toEqual(["online"]);
  });

  test("a manifest edit that leaves a need without a provider is reported, and the rack keeps running", async () => {
    const created = await app(files());
    const { running } = await startRack(
      { slots: { 1: slot("./devices/d.ts"), 3: slot("./devices/x.ts") } },
      { baseDir: created.dir },
    );
    const results = await running.reload(rack("test", { slots: { 3: slot("./devices/x.ts") } }));
    expect(summary(results)).toEqual([
      ["x", "hot", "RACK_MANIFEST"],
      ["d", "unplug", "RACK_SWAP_REJECTED"],
    ]);
    expect(await running.call("x.poke", "inc", "d")).toBe(1);
  });
});
