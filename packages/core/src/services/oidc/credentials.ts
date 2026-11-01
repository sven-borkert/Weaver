import type { PrismaClient } from "@weaver/db/client";
import {
  decryptSecret,
  encryptSecret,
  type EncryptionKeyRing,
} from "../../security/encryption";
import {
  OIDC_SETTING_KEY,
  oidcSecretSchema,
  readStoredOidc,
  type StoredOidcSettings,
} from "./schemas";

export function encryptOidcSecret(
  ring: EncryptionKeyRing,
  plaintext: string,
): NonNullable<StoredOidcSettings["secret"]> {
  const encrypted = encryptSecret(ring, plaintext, "oidc:system");
  return {
    ciphertext: Buffer.from(encrypted.ciphertext).toString("base64"),
    nonce: Buffer.from(encrypted.nonce).toString("base64"),
    tag: Buffer.from(encrypted.tag).toString("base64"),
    keyVersion: encrypted.keyVersion,
  };
}
export function decryptOidcSecret(
  ring: EncryptionKeyRing | null,
  secret: StoredOidcSettings["secret"],
): string | null {
  if (!secret) return null;
  if (!ring)
    throw new Error(
      "Restore WEAVER_ENCRYPTION_KEYS to decrypt the saved OIDC credential",
    );
  return decryptSecret(
    ring,
    {
      ciphertext: Buffer.from(secret.ciphertext, "base64"),
      nonce: Buffer.from(secret.nonce, "base64"),
      tag: Buffer.from(secret.tag, "base64"),
      keyVersion: secret.keyVersion,
    },
    "oidc:system",
  );
}
export async function assertOidcSecretsDecryptable(
  db: PrismaClient,
  ring: EncryptionKeyRing | null,
): Promise<void> {
  const row = await db.systemSetting.findUnique({
    where: { key: OIDC_SETTING_KEY },
    select: { value: true },
  });
  const value = row?.value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const secret = oidcSecretSchema.parse(value.secret ?? null);
  if (secret) decryptOidcSecret(ring, secret);
}
export async function rotateOidcSecrets(
  db: PrismaClient,
  ring: EncryptionKeyRing,
): Promise<{ rotated: number; skipped: number }> {
  const row = await readStoredOidc(db);
  if (!row?.secret) return { rotated: 0, skipped: 0 };
  if (row.secret.keyVersion === ring.activeVersion)
    return { rotated: 0, skipped: 1 };
  const plaintext = decryptOidcSecret(ring, row.secret)!;
  const result = await db.systemSetting.updateMany({
    where: {
      key: OIDC_SETTING_KEY,
      value: { equals: row },
    },
    data: { value: { ...row, secret: encryptOidcSecret(ring, plaintext) } },
  });
  return { rotated: result.count, skipped: 1 - result.count };
}
