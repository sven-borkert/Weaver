import { describe, expect, it } from "vitest";
import { parseEncryptionKeyRing } from "@weaver/config/encryptionKeys";
import {
  decryptSecret,
  encryptSecret,
  EncryptionKeyUnavailableError,
  loadEncryptionKeyRing,
  missingKeyVersions,
  secretAad,
} from "./encryption";

const k1 = Buffer.alloc(32, 1).toString("base64");
const k2 = Buffer.alloc(32, 2).toString("base64");
const ringV1 = parseEncryptionKeyRing(`1:${k1}`)!;
const ringV2 = parseEncryptionKeyRing(`1:${k1},2:${k2}`)!;
const aad = secretAad("llm-connection", "11111111-1111-4111-8111-111111111111");

describe("secret encryption", () => {
  it("round-trips with the active key and a fresh nonce per call", () => {
    const a = encryptSecret(ringV2, "sk-secret", aad);
    const b = encryptSecret(ringV2, "sk-secret", aad);
    expect(a.keyVersion).toBe(2);
    expect(a.nonce.byteLength).toBe(12);
    expect(a.tag.byteLength).toBe(16);
    expect(Buffer.from(a.nonce).equals(Buffer.from(b.nonce))).toBe(false);
    expect(decryptSecret(ringV2, a, aad)).toBe("sk-secret");
  });
  it("decrypts old versions and refuses missing ones", () => {
    const old = encryptSecret(ringV1, "sk-old", aad);
    expect(decryptSecret(ringV2, old, aad)).toBe("sk-old");
    const newer = encryptSecret(ringV2, "sk-new", aad);
    expect(() => decryptSecret(ringV1, newer, aad)).toThrow(
      EncryptionKeyUnavailableError,
    );
  });
  it("binds ciphertext to its associated data", () => {
    const secret = encryptSecret(ringV2, "sk-secret", aad);
    expect(() =>
      decryptSecret(ringV2, secret, secretAad("llm-connection", "other")),
    ).toThrow();
  });
  it("rejects records with invalid nonce or authentication tag lengths", () => {
    const secret = encryptSecret(ringV2, "sk-secret", aad);
    expect(() =>
      decryptSecret(ringV2, { ...secret, nonce: new Uint8Array(11) }, aad),
    ).toThrow(/nonce must be 12 bytes/);
    expect(() =>
      decryptSecret(ringV2, { ...secret, tag: new Uint8Array(15) }, aad),
    ).toThrow(/tag must be 16 bytes/);
  });
  it("lists missing versions and treats a null ring as missing everything", () => {
    expect(missingKeyVersions(ringV1, [1, 2, 2])).toEqual([2]);
    expect(missingKeyVersions(null, [1])).toEqual([1]);
    expect(missingKeyVersions(null, [])).toEqual([]);
  });
  it("loads the ring from the environment", () => {
    expect(loadEncryptionKeyRing({})).toBeNull();
    expect(
      loadEncryptionKeyRing({ WEAVER_ENCRYPTION_KEYS: `3:${k2}` })
        ?.activeVersion,
    ).toBe(3);
  });
});
