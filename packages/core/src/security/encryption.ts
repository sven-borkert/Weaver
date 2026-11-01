import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import {
  parseEncryptionKeyRing,
  type EncryptionKeyRing,
} from "@weaver/config/encryptionKeys";

export type { EncryptionKeyRing };

export type EncryptedSecret = {
  ciphertext: Uint8Array;
  nonce: Uint8Array;
  tag: Uint8Array;
  keyVersion: number;
};

export class EncryptionKeyUnavailableError extends Error {
  constructor(readonly keyVersion: number) {
    super(
      `Encryption key version ${keyVersion} is not present in WEAVER_ENCRYPTION_KEYS`,
    );
    this.name = "EncryptionKeyUnavailableError";
  }
}

export function secretAad(kind: string, id: string): string {
  return `${kind}:${id}`;
}

export function encryptSecret(
  ring: EncryptionKeyRing,
  plaintext: string,
  aad: string,
): EncryptedSecret {
  const key = ring.keys.get(ring.activeVersion);
  if (!key) throw new EncryptionKeyUnavailableError(ring.activeVersion);
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  return {
    ciphertext: new Uint8Array(ciphertext),
    nonce: new Uint8Array(nonce),
    tag: new Uint8Array(cipher.getAuthTag()),
    keyVersion: ring.activeVersion,
  };
}

export function decryptSecret(
  ring: EncryptionKeyRing,
  secret: EncryptedSecret,
  aad: string,
): string {
  if (secret.nonce.byteLength !== 12) {
    throw new Error("Encrypted secret nonce must be 12 bytes");
  }
  if (secret.tag.byteLength !== 16) {
    throw new Error("Encrypted secret tag must be 16 bytes");
  }
  const key = ring.keys.get(secret.keyVersion);
  if (!key) throw new EncryptionKeyUnavailableError(secret.keyVersion);
  const decipher = createDecipheriv("aes-256-gcm", key, secret.nonce);
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(secret.tag);
  return Buffer.concat([
    decipher.update(secret.ciphertext),
    decipher.final(),
  ]).toString("utf8");
}

export function missingKeyVersions(
  ring: EncryptionKeyRing | null,
  versions: Iterable<number>,
): number[] {
  const missing = new Set<number>();
  for (const version of versions) {
    if (!ring?.keys.has(version)) missing.add(version);
  }
  return [...missing].sort((a, b) => a - b);
}

let cachedRaw: string | undefined;
let cachedRing: EncryptionKeyRing | null = null;

export function loadEncryptionKeyRing(
  env: Record<string, string | undefined> = process.env,
): EncryptionKeyRing | null {
  const raw = env.WEAVER_ENCRYPTION_KEYS;
  if (raw !== cachedRaw) {
    cachedRing = parseEncryptionKeyRing(raw);
    cachedRaw = raw;
  }
  return cachedRing;
}
