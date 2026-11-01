export type EncryptionKeyRing = {
  readonly activeVersion: number;
  readonly keys: ReadonlyMap<number, Uint8Array>;
};

const ENTRY = /^(\d{1,9}):([A-Za-z0-9+/]+=*)$/;

export function parseEncryptionKeyRing(
  raw: string | undefined,
): EncryptionKeyRing | null {
  if (raw === undefined || raw.trim() === "") return null;
  const keys = new Map<number, Uint8Array>();
  for (const entry of raw.split(",")) {
    const match = ENTRY.exec(entry.trim());
    if (!match) {
      throw new Error(
        "WEAVER_ENCRYPTION_KEYS entries must be <version>:<base64 32-byte key>",
      );
    }
    const version = Number(match[1]);
    if (version < 1 || keys.has(version)) {
      throw new Error(
        `WEAVER_ENCRYPTION_KEYS has an invalid or duplicate version ${match[1]}`,
      );
    }
    const key = Buffer.from(match[2]!, "base64");
    if (key.toString("base64") !== match[2]) {
      throw new Error(
        "WEAVER_ENCRYPTION_KEYS entries must be <version>:<base64 32-byte key>",
      );
    }
    if (key.byteLength !== 32) {
      throw new Error(
        `WEAVER_ENCRYPTION_KEYS version ${version} must decode to 32 bytes`,
      );
    }
    keys.set(version, new Uint8Array(key));
  }
  return { activeVersion: Math.max(...keys.keys()), keys };
}
