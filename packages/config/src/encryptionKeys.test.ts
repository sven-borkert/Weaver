import { describe, expect, it } from "vitest";
import { parseEncryptionKeyRing } from "./encryptionKeys";

const k1 = Buffer.alloc(32, 1).toString("base64");
const k2 = Buffer.alloc(32, 2).toString("base64");

describe("parseEncryptionKeyRing", () => {
  it("returns null when unset or blank", () => {
    expect(parseEncryptionKeyRing(undefined)).toBeNull();
    expect(parseEncryptionKeyRing("   ")).toBeNull();
  });

  it("parses versions and picks the highest as active", () => {
    const ring = parseEncryptionKeyRing(`1:${k1}, 2:${k2}`);
    expect(ring?.activeVersion).toBe(2);
    expect([...ring!.keys.keys()].sort()).toEqual([1, 2]);
    expect(ring!.keys.get(1)?.byteLength).toBe(32);
  });

  it("rejects malformed entries, duplicates, and wrong key sizes", () => {
    expect(() => parseEncryptionKeyRing("abc")).toThrow(/<version>:<base64/);
    expect(() => parseEncryptionKeyRing(`1:${k1},1:${k2}`)).toThrow(
      /duplicate/,
    );
    expect(() => parseEncryptionKeyRing(`0:${k1}`)).toThrow(
      /invalid or duplicate/,
    );
    expect(() =>
      parseEncryptionKeyRing(`1:${Buffer.alloc(16, 1).toString("base64")}`),
    ).toThrow(/32 bytes/);
    expect(() => parseEncryptionKeyRing(`1:${k1}=`)).toThrow(
      /<version>:<base64/,
    );
  });
});
