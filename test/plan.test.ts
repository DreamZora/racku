/**
 * Tests for the planner of scanned racks and for the plan file, without Workers.
 *
 * @decision .agents/decisions/261116_233919-automatic-assembly.md#the-plan
 * @decision .agents/decisions/261116_233919-automatic-assembly.md#cycles
 * @decision .agents/decisions/261116_233919-automatic-assembly.md#placement
 * @decision .agents/decisions/261116_233919-automatic-assembly.md#plan-file
 */
import { describe, expect, test } from "bun:test";
import type { ConnectorInfo } from "../src/connector.ts";
import { fitPlan, formatPlan, makePlan, type Plan, type PlanType, parsePlan } from "../src/plan.ts";
import type { NeedInfo } from "../src/protocol.ts";

function port(id: string): ConnectorInfo {
  return { id, members: { get: "rpc" } };
}

function shared(id: string): NeedInfo {
  return { ...port(id), own: false };
}

function owned(id: string): NeedInfo {
  return { ...port(id), own: true };
}

interface TypeSpec {
  needs?: Record<string, NeedInfo>;
  provides?: Record<string, ConnectorInfo>;
  priority?: number;
  height?: number;
}

function types(specs: Record<string, TypeSpec>): Map<string, PlanType> {
  return new Map(
    Object.entries(specs).map(([name, spec]) => [
      name,
      {
        name,
        height: spec.height ?? 1,
        priority: spec.priority ?? 0,
        needs: spec.needs ?? {},
        provides: spec.provides ?? {},
      },
    ]),
  );
}

/** The user's example: A needs its own D and F, B needs the shared E, C needs E and its own F. */
function example(priorities: Record<string, number> = {}): Map<string, PlanType> {
  return types({
    a: { needs: { d: owned("d/v1"), f: owned("f/v1") }, priority: priorities.a },
    b: { needs: { e: shared("e/v1") }, priority: priorities.b },
    c: { needs: { e: shared("e/v1"), f: owned("f/v1") }, priority: priorities.c },
    d: { provides: { d: port("d/v1") } },
    e: { provides: { e: port("e/v1") } },
    f: { provides: { f: port("f/v1") } },
  });
}

const ROOTS = ["a", "b", "c"];

function layout(plan: Plan): string[] {
  return plan.instances.map((instance) => `U${instance.u} ${instance.name}`);
}

function failure(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return `${(error as { code?: string }).code}: ${(error as Error).message}`;
  }
  throw new Error("expected the plan to fail");
}

describe("the plan", () => {
  test("the user's example gives shared and own instances, wired and placed by layer and name", () => {
    const plan = makePlan({ types: example(), roots: ROOTS, use: {}, size: 42 });
    expect(layout(plan)).toEqual(["U1 a-d", "U2 a-f", "U3 c-f", "U4 e", "U5 a", "U6 b", "U7 c"]);
    const byName = new Map(plan.instances.map((instance) => [instance.name, instance]));
    expect(byName.get("a")?.wiring).toEqual({
      d: { provider: "a-d", port: "d" },
      f: { provider: "a-f", port: "f" },
    });
    expect(byName.get("b")?.wiring).toEqual({ e: { provider: "e", port: "e" } });
    expect(byName.get("c")?.wiring).toEqual({
      e: { provider: "e", port: "e" },
      f: { provider: "c-f", port: "f" },
    });
    expect(
      plan.instances.map((instance) => [instance.name, instance.model, instance.owner]),
    ).toEqual([
      ["a-d", "d", "a"],
      ["a-f", "f", "a"],
      ["c-f", "f", "c"],
      ["e", "e", undefined],
      ["a", "a", undefined],
      ["b", "b", undefined],
      ["c", "c", undefined],
    ]);
    expect(plan.unused).toEqual([]);
  });

  // @doc docs/guides/racks.md#shared-instances-and-own-copies
  // The example with a panel among the roots.
  // @decision .agents/decisions/261118_071513-http-panel-device.md#needs-from-configuration
  // @doc docs/guides/http.md#routes
  test("a panel's route pulls in the model it names, and the plan places the panel above it", () => {
    const all = example();
    all.set("a", { ...(all.get("a") as PlanType), provides: { http: port("http/v2") } });
    all.set("http-panel", {
      name: "http-panel",
      height: 1,
      priority: 0,
      needs: { a_http: { ...shared("http/v2"), patched: "a.http" } },
      provides: {},
    });
    const plan = makePlan({ types: all, roots: ["http-panel", "b", "c"], use: {}, size: 42 });
    expect(layout(plan)).toEqual([
      "U1 a-d",
      "U2 a-f",
      "U3 c-f",
      "U4 e",
      "U5 a",
      "U6 b",
      "U7 c",
      "U8 http-panel",
    ]);
    expect(plan.instances.at(-1)?.wiring).toEqual({ a_http: { provider: "a", port: "http" } });
  });

  // @decision .agents/decisions/261118_071513-http-panel-device.md#needs-from-configuration
  // @doc docs/guides/devices.md#needs-from-configuration
  // @doc docs/guides/racks.md#shared-instances-and-own-copies
  test("a use entry keyed <model>.<need> wins over patched(), and one keyed by a connector id doesn't", () => {
    const all = types({
      one: { provides: { p: port("p/v1") } },
      two: { provides: { p: port("p/v1") } },
      top: { needs: { n: { ...shared("p/v1"), patched: "one.p" } } },
    });
    const wiring = (use: Record<string, string>) =>
      makePlan({ types: all, roots: ["top"], use, size: 42 }).instances.at(-1)?.wiring;
    expect(wiring({})).toEqual({ n: { provider: "one", port: "p" } });
    expect(wiring({ "p/v1": "two" })).toEqual({ n: { provider: "one", port: "p" } });
    expect(wiring({ "top.n": "two" })).toEqual({ n: { provider: "two", port: "p" } });
    const to = (patched: string) =>
      failure(() =>
        makePlan({
          types: types({
            ...Object.fromEntries(all),
            top: { needs: { n: { ...shared("p/v1"), patched } } },
          }),
          roots: ["top"],
          use: {},
          size: 42,
        }),
      );
    expect(to("ghost.p")).toBe(
      "RACK_MANIFEST: top.n (p/v1): patched to ghost.p, but ghost is not a scanned device model",
    );
    expect(to("one.q")).toBe(
      "RACK_MANIFEST: top.n (p/v1): patched to one.q, which is not a p/v1 port",
    );
  });

  test("a priority pulls a branch forward and never overrides the dependency graph", () => {
    const plan = makePlan({ types: example({ c: 10 }), roots: ROOTS, use: {}, size: 42 });
    expect(layout(plan)).toEqual(["U1 c-f", "U2 e", "U3 c", "U4 a-d", "U5 a-f", "U6 a", "U7 b"]);

    const chain = (priority: number) =>
      types({
        secrets: { provides: { secrets: port("secrets/v1") } },
        config: {
          needs: { secrets: shared("secrets/v1") },
          provides: { config: port("config/v1") },
        },
        db: { provides: { db: port("sql/v1") } },
        migrate: { needs: { db: shared("sql/v1"), config: shared("config/v1") }, priority },
        app: { needs: { db: shared("sql/v1") } },
      });
    const order = (priority: number) =>
      makePlan({
        types: chain(priority),
        roots: ["app", "migrate"],
        use: {},
        size: 42,
      }).instances.map((instance) => instance.name);
    expect(order(0)).toEqual(["db", "secrets", "app", "config", "migrate"]);
    expect(order(10)).toEqual(["db", "secrets", "config", "migrate", "app"]);
  });

  test("the same models give the same plan whatever order they were scanned in", () => {
    const reversed = new Map([...example().entries()].reverse());
    const first = makePlan({ types: example(), roots: ROOTS, use: {}, size: 42 });
    const second = makePlan({ types: reversed, roots: [...ROOTS].reverse(), use: {}, size: 42 });
    expect(second).toEqual(first);
  });

  test("a model that nothing needs and that is not a root is listed as unused", () => {
    const all = example();
    all.set("g", { name: "g", height: 1, priority: 0, needs: {}, provides: {} });
    expect(makePlan({ types: all, roots: ROOTS, use: {}, size: 42 }).unused).toEqual(["g"]);
  });

  test("a model that is needed shared and is a root gets one instance", () => {
    const plan = makePlan({ types: example(), roots: [...ROOTS, "e"], use: {}, size: 42 });
    expect(plan.instances.filter((instance) => instance.model === "e")).toHaveLength(1);
  });
});

describe("cycles", () => {
  test("a cycle through an own need fails with its path", () => {
    const all = example();
    all.set("d", {
      name: "d",
      height: 1,
      priority: 0,
      needs: { back: shared("a/v1") },
      provides: { d: port("d/v1") },
    });
    const a = all.get("a") as PlanType;
    all.set("a", { ...a, provides: { a: port("a/v1") } });
    expect(failure(() => makePlan({ types: all, roots: ROOTS, use: {}, size: 42 }))).toBe(
      "RACK_MANIFEST: cycle: a.d → a-d.back → a",
    );
  });

  test("a cycle through shared needs fails with its path", () => {
    const all = types({
      x: { needs: { y: shared("y/v1") }, provides: { x: port("x/v1") } },
      y: { needs: { x: shared("x/v1") }, provides: { y: port("y/v1") } },
    });
    expect(failure(() => makePlan({ types: all, roots: ["x"], use: {}, size: 42 }))).toBe(
      "RACK_MANIFEST: cycle: x.y → y.x → x",
    );
  });

  test("a device that needs its own model is a cycle, so own copies cannot recurse forever", () => {
    const all = types({ x: { needs: { next: owned("x/v1") }, provides: { x: port("x/v1") } } });
    expect(failure(() => makePlan({ types: all, roots: ["x"], use: {}, size: 42 }))).toBe(
      "RACK_MANIFEST: cycle: x.next → x",
    );
  });
});

describe("providers", () => {
  const two = () =>
    types({
      app: { needs: { cache: shared("kv/v1"), store: shared("kv/v1") } },
      memkv: { provides: { kv: port("kv/v1") } },
      redis: { provides: { kv: port("kv/v1") } },
    });

  test("a need with several providers fails until use picks one", () => {
    expect(failure(() => makePlan({ types: two(), roots: ["app"], use: {}, size: 42 }))).toBe(
      "RACK_MANIFEST: app.cache (kv/v1) is ambiguous: memkv, redis; add a use entry for kv/v1 or app.cache",
    );
    const plan = makePlan({
      types: two(),
      roots: ["app"],
      use: { "kv/v1": "memkv", "app.store": "redis" },
      size: 42,
    });
    const app = plan.instances.find((instance) => instance.name === "app");
    expect(app?.wiring).toEqual({
      cache: { provider: "memkv", port: "kv" },
      store: { provider: "redis", port: "kv" },
    });
  });

  test("a need without a provider, an unknown use, and an unknown root fail", () => {
    const lonely = types({ app: { needs: { db: shared("sql/v1") } } });
    expect(failure(() => makePlan({ types: lonely, roots: ["app"], use: {}, size: 42 }))).toBe(
      "RACK_MANIFEST: app.db (sql/v1): no scanned device provides it",
    );
    expect(
      failure(() => makePlan({ types: two(), roots: ["app"], use: { "kv/v1": "nope" }, size: 42 })),
    ).toBe("RACK_MANIFEST: app.cache (kv/v1): use names nope, which is not a scanned device model");
    expect(failure(() => makePlan({ types: two(), roots: ["ghost"], use: {}, size: 42 }))).toBe(
      "RACK_MANIFEST: root ghost is not a scanned device model",
    );
  });

  test("an own copy whose name collides with a model fails", () => {
    const all = example();
    all.set("a-d", { name: "a-d", height: 1, priority: 0, needs: {}, provides: {} });
    expect(
      failure(() => makePlan({ types: all, roots: [...ROOTS, "a-d"], use: {}, size: 42 })),
    ).toBe("RACK_MANIFEST: the shared a-d and the copy of d for a would both be named a-d");
  });

  test("a plan that does not fit the rack fails", () => {
    expect(failure(() => makePlan({ types: example(), roots: ROOTS, use: {}, size: 6 }))).toBe(
      "RACK_MANIFEST: the plan needs more than the 6U of the rack: c would end at U7",
    );
  });
});

describe("the plan file", () => {
  const computed = () => makePlan({ types: example(), roots: ROOTS, use: {}, size: 42 });

  test("a plan survives formatting and parsing", () => {
    const text = formatPlan("demo", computed());
    expect(text.split("\n").slice(2, 4)).toEqual(["U1 a-d d a", "U2 a-f f a"]);
    expect(text).toContain("U7 c c - e=e.e f=c-f.f\n");
    expect(parsePlan(text, "demo.plan")).toEqual([...computed().instances]);
  });

  test("a file with another valid order fits, keeps its order, and reports the difference", () => {
    const moved = formatPlan("demo", computed())
      .replace("U3 c-f", "U9 c-f")
      .replace("U7 c c", "U10 c c");
    const fit = fitPlan(parsePlan(moved, "demo.plan"), computed(), 42);
    expect(fit.fits).toBe(true);
    if (!fit.fits) return;
    expect(fit.sameOrder).toBe(false);
    expect(fit.plan.instances.map((instance) => `U${instance.u} ${instance.name}`)).toContain(
      "U10 c",
    );
  });

  test("a file whose instances or wiring changed, or whose order breaks the graph, does not fit", () => {
    const changed = makePlan({ types: example({}), roots: ["a", "b"], use: {}, size: 42 });
    const fit = fitPlan(parsePlan(formatPlan("demo", computed()), "demo.plan"), changed, 42);
    expect(fit).toEqual({ fits: false, differences: ["c-f is gone", "c is gone"] });

    const upsideDown = formatPlan("demo", computed()).replace("U1 a-d", "U20 a-d");
    const broken = fitPlan(parsePlan(upsideDown, "demo.plan"), computed(), 42);
    expect(broken).toEqual({ fits: false, differences: ["a at U5 is not above a-d"] });
  });

  test("a malformed line fails with its line number", () => {
    expect(failure(() => parsePlan("# header\nU1 a-d\n", "demo.plan"))).toBe(
      "RACK_MANIFEST: demo.plan line 2 is malformed: U1 a-d",
    );
  });
});
