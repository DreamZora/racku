/**
 * Tests for rack manifests and slot descriptions.
 *
 * @decision .agents/decisions/261112_043034-device-api.md#rack-manifest
 * @decision .agents/decisions/261115_222025-p0-api-details.md#names
 */
import { describe, expect, test } from "bun:test";
import { RackError, rack, slot } from "racku";
import { isRackManifest, parseAddress } from "../src/manifest.ts";

function rejectionCode(define: () => unknown): string | undefined {
  try {
    define();
  } catch (error) {
    if (error instanceof RackError) return error.code;
    throw error;
  }
  return undefined;
}

describe("slot", () => {
  test("accepts a path or a file: URL", () => {
    expect(slot("./devices/a.ts").source).toBe("./devices/a.ts");
    const url = new URL("file:///srv/app/devices/a.ts");
    expect(slot(url, { name: "a", config: { x: 1 } })).toMatchObject({
      source: url,
      name: "a",
      config: { x: 1 },
    });
  });

  test.each([
    ["an empty path", () => slot("")],
    ["a URL that is not file:", () => slot(new URL("https://example.com/a.ts"))],
    ["a name with a dot", () => slot("./a.ts", { name: "a.b" })],
    ["a name starting with a dash", () => slot("./a.ts", { name: "-a" })],
  ])("rejects %s with RACK_MANIFEST", (_label, define) => {
    expect(rejectionCode(define)).toBe("RACK_MANIFEST");
  });
});

describe("rack", () => {
  // @doc docs/concepts.md#the-rack
  test("defaults to 42U and orders slots from the bottom up", () => {
    const manifest = rack("shop", { slots: { 5: slot("./b.ts"), 1: slot("./a.ts") } });
    expect(manifest.size).toBe(42);
    expect(manifest.slots.map((s) => s.u)).toEqual([1, 5]);
    expect(manifest.patch).toEqual([]);
    expect(isRackManifest(manifest)).toBe(true);
    expect(isRackManifest({ name: "shop" })).toBe(false);
  });

  // @doc docs/guides/running.md#a-layout-that-follows-data
  test("size gives a rack more slots than 42", () => {
    expect(rack("greeters", { size: 100, slots: { 99: slot("./a.ts") } }).size).toBe(100);
    expect(rejectionCode(() => rack("greeters", { slots: { 43: slot("./a.ts") } }))).toBe(
      "RACK_MANIFEST",
    );
  });

  test.each([
    ["an empty name", () => rack("", { slots: {} })],
    ["a non-integer size", () => rack("r", { size: 1.5, slots: {} })],
    ["slot 0", () => rack("r", { slots: { 0: slot("./a.ts") } })],
    ["a slot above the size", () => rack("r", { size: 4, slots: { 5: slot("./a.ts") } })],
    [
      "a slot that is not a slot()",
      () => rack("r", { slots: { 1: { source: "./a.ts" } as never } }),
    ],
    ["a malformed patch", () => rack("r", { slots: {}, patch: [["a", "b.c"]] })],
  ])("rejects %s with RACK_MANIFEST", (_label, define) => {
    expect(rejectionCode(define)).toBe("RACK_MANIFEST");
  });

  // @decision .agents/decisions/261118_071513-http-panel-device.md#manifests
  test("rejects a panel section with RACK_MANIFEST, pointing to httpPanel()", () => {
    // Manifests written for 0.3 still have it; the types no longer do.
    const old = { slots: {}, panel: { http: { port: 3000, routes: {} } } } as never;
    expect(() => rack("r", old)).toThrow(
      new RackError(
        "RACK_MANIFEST",
        "rack r: the panel section is gone; mount httpPanel() from racku/std in a slot, or list it in a scanned rack's devices and roots",
      ),
    );
    expect(rejectionCode(() => rack("r", old))).toBe("RACK_MANIFEST");
  });
});

describe("scanned manifests", () => {
  // @decision .agents/decisions/261116_233919-automatic-assembly.md#scanned-manifests
  test("keeps devices, roots, use, and config, and has no slots or patches", () => {
    const manifest = rack("app", {
      devices: ["./devices", slot("./vendor/kv.ts", { name: "cache" })],
      roots: ["web"],
      use: { "kv/v1": "cache", "web.store": "cache" },
      config: { web: { port: 1 } },
    });
    expect(manifest.slots).toEqual([]);
    expect(manifest.patch).toEqual([]);
    expect(manifest.scan?.roots).toEqual(["web"]);
    expect(manifest.scan?.use).toEqual({ "kv/v1": "cache", "web.store": "cache" });
  });

  test.each([
    ["slots and devices together", () => rack("r", { slots: {}, devices: ["./d"] } as never)],
    ["a rack name that cannot name a plan file", () => rack("my rack", { devices: ["./d"] })],
    ["no devices", () => rack("r", { devices: [] })],
    [
      "a device entry that is neither a path nor a slot()",
      () => rack("r", { devices: [42 as never] }),
    ],
    ["a root that is not a model name", () => rack("r", { devices: ["./d"], roots: ["a.b"] })],
    [
      "a use key that is neither a connector id nor <model>.<need>",
      () => rack("r", { devices: ["./d"], use: { kv: "x" } }),
    ],
    [
      "a use value that is not a model name",
      () => rack("r", { devices: ["./d"], use: { "kv/v1": "a b" } }),
    ],
  ])("rejects %s with RACK_MANIFEST", (_label, define) => {
    expect(rejectionCode(define)).toBe("RACK_MANIFEST");
  });
});

describe("parseAddress", () => {
  test("splits <device>.<port>", () => {
    expect(parseAddress("orders.http")).toEqual({ device: "orders", port: "http" });
  });

  test.each(["orders", ".http", "orders.", "a.b.c", "or ders.http"])("rejects %s", (address) => {
    expect(rejectionCode(() => parseAddress(address))).toBe("RACK_MANIFEST");
  });
});
