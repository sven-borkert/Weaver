import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { assignInboundToolNames } from "./inboundTools";

const hash = (id: string, name: string) =>
  createHash("sha256").update(`${id}:${name}`).digest("hex").slice(0, 6);

describe("inbound tool names", () => {
  it("prefixes, normalizes the connection, and keeps remote case", () => {
    expect(
      assignInboundToolNames([
        {
          connectionId: "c1",
          connectionName: "Design Docs",
          remoteName: "nodes__list",
        },
        {
          connectionId: "c1",
          connectionName: "Design Docs",
          remoteName: "Get.Item",
        },
      ]),
    ).toEqual(["ext_design_docs__nodes__list", "ext_design_docs__Get_Item"]);
  });
  it("hashes names that are too long, stably and within 64 characters", () => {
    const remoteName = "x".repeat(80);
    const [name] = assignInboundToolNames([
      { connectionId: "c1", connectionName: "Conn", remoteName },
    ]);
    expect(name).toHaveLength(64);
    expect(name!.endsWith(`_${hash("c1", remoteName)}`)).toBe(true);
    expect(name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
  });
  it("disambiguates collisions with the hash suffix", () => {
    const names = assignInboundToolNames([
      { connectionId: "c1", connectionName: "A B", remoteName: "t" },
      { connectionId: "c2", connectionName: "a-b", remoteName: "t" },
    ]);
    expect(names[0]).toBe(`ext_a_b__t_${hash("c1", "t")}`);
    expect(names[1]).toBe(`ext_a_b__t_${hash("c2", "t")}`);
  });
});
