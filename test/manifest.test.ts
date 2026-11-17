/**
 * Tests for rack manifests and slot descriptions.
 *
 * @decision .agents/decisions/261112_043034-device-api.md#rack-manifest
 * @decision .agents/decisions/261115_222025-p0-api-details.md#names
 */
import { describe, expect, test } from "bun:test";
import { RackError, rack, slot } from "rack42u";
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
  test("defaults to 42U and orders slots from the bottom up", () => {
    const manifest = rack("shop", { slots: { 5: slot("./b.ts"), 1: slot("./a.ts") } });
    expect(manifest.size).toBe(42);
    expect(manifest.slots.map((s) => s.u)).toEqual([1, 5]);
    expect(manifest.patch).toEqual([]);
    expect(isRackManifest(manifest)).toBe(true);
    expect(isRackManifest({ name: "shop" })).toBe(false);
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
    [
      "a panel port out of range",
      () => rack("r", { slots: {}, panel: { http: { port: 70000, routes: {} } } }),
    ],
    [
      "a route to a malformed address",
      () => rack("r", { slots: {}, panel: { http: { port: 0, routes: { "/": "web" } } } }),
    ],
  ])("rejects %s with RACK_MANIFEST", (_label, define) => {
    expect(rejectionCode(define)).toBe("RACK_MANIFEST");
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
