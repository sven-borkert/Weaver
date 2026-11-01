import type { PrismaClient } from "@weaver/db/client";
import { CoreError } from "../../errors";
import {
  decryptSecret,
  encryptSecret,
  type EncryptionKeyRing,
} from "../../security/encryption";

export const EMPTY_CREDENTIAL = {
  credentialCiphertext: null,
  credentialKeyVersion: null,
  credentialIv: null,
  credentialTag: null,
};
export const CREDENTIAL_SELECT = {
  credentialCiphertext: true,
  credentialKeyVersion: true,
  credentialIv: true,
  credentialTag: true,
} as const;
export const APPROVAL_SECRET_SELECT = {
  pendingArgumentsCiphertext: true,
  pendingArgumentsKeyVersion: true,
  pendingArgumentsIv: true,
  pendingArgumentsTag: true,
} as const;
type StoredSecret = {
  ciphertext: string | null;
  keyVersion: number | null;
  iv: string | null;
  tag: string | null;
};
function unavailable(): never {
  throw new CoreError(
    "PRECONDITION_FAILED",
    "External MCP encryption keys are unavailable or stored secrets cannot be decrypted",
  );
}
export function encryptExternalSecret(
  ring: EncryptionKeyRing,
  plaintext: string,
  kind: "connection" | "approval",
  id: string,
) {
  try {
    const value = encryptSecret(ring, plaintext, `external-mcp-${kind}:${id}`);
    return {
      ciphertext: Buffer.from(value.ciphertext).toString("base64"),
      keyVersion: value.keyVersion,
      iv: Buffer.from(value.nonce).toString("base64"),
      tag: Buffer.from(value.tag).toString("base64"),
    };
  } catch {
    return unavailable();
  }
}
export function decryptExternalSecret(
  ring: EncryptionKeyRing | null,
  value: StoredSecret,
  kind: "connection" | "approval",
  id: string,
): string {
  try {
    if (
      !ring ||
      value.ciphertext === null ||
      value.keyVersion === null ||
      value.iv === null ||
      value.tag === null
    )
      return unavailable();
    return decryptSecret(
      ring,
      {
        ciphertext: Buffer.from(value.ciphertext, "base64"),
        keyVersion: value.keyVersion,
        nonce: Buffer.from(value.iv, "base64"),
        tag: Buffer.from(value.tag, "base64"),
      },
      `external-mcp-${kind}:${id}`,
    );
  } catch {
    return unavailable();
  }
}
export function encryptExternalCredential(
  ring: EncryptionKeyRing,
  token: string,
  id: string,
) {
  const v = encryptExternalSecret(ring, token, "connection", id);
  return {
    credentialCiphertext: v.ciphertext,
    credentialKeyVersion: v.keyVersion,
    credentialIv: v.iv,
    credentialTag: v.tag,
  };
}
export async function decryptExternalConnectionCredential(
  db: PrismaClient,
  ring: EncryptionKeyRing,
  id: string,
  expectedEndpoint: string,
  expectedRevision?: number,
): Promise<string | null> {
  const row = await db.externalMcpConnection.findUnique({
    where: { id },
    select: {
      ...CREDENTIAL_SELECT,
      authMode: true,
      endpoint: true,
      enabled: true,
      revision: true,
    },
  });
  if (
    row?.endpoint !== expectedEndpoint ||
    (expectedRevision !== undefined &&
      (!row.enabled || row.revision !== expectedRevision))
  )
    throw new CoreError(
      "CONFLICT",
      "External connection configuration changed",
    );
  if (row.authMode === "none") return null;
  return decryptExternalSecret(
    ring,
    {
      ciphertext: row.credentialCiphertext,
      keyVersion: row.credentialKeyVersion,
      iv: row.credentialIv,
      tag: row.credentialTag,
    },
    "connection",
    id,
  );
}
async function secretRows(db: PrismaClient) {
  const connections = await db.externalMcpConnection.findMany({
    where: { credentialCiphertext: { not: null } },
    select: { id: true, revision: true, ...CREDENTIAL_SELECT },
  });
  const approvals = await db.externalMcpToolApproval.findMany({
    where: { pendingArgumentsCiphertext: { not: null } },
    select: { id: true, ...APPROVAL_SECRET_SELECT },
  });
  return { connections, approvals };
}
export async function assertExternalMcpSecretsDecryptable(
  db: PrismaClient,
  ring: EncryptionKeyRing | null,
): Promise<void> {
  const { connections, approvals } = await secretRows(db);
  for (const r of connections)
    decryptExternalSecret(
      ring,
      {
        ciphertext: r.credentialCiphertext,
        keyVersion: r.credentialKeyVersion,
        iv: r.credentialIv,
        tag: r.credentialTag,
      },
      "connection",
      r.id,
    );
  for (const r of approvals)
    decryptExternalSecret(
      ring,
      {
        ciphertext: r.pendingArgumentsCiphertext,
        keyVersion: r.pendingArgumentsKeyVersion,
        iv: r.pendingArgumentsIv,
        tag: r.pendingArgumentsTag,
      },
      "approval",
      r.id,
    );
}
export async function rotateExternalMcpSecrets(
  db: PrismaClient,
  ring: EncryptionKeyRing,
) {
  const { connections, approvals } = await secretRows(db);
  let rotated = 0;
  let skipped = 0;
  for (const r of connections) {
    const plaintext = decryptExternalSecret(
      ring,
      {
        ciphertext: r.credentialCiphertext,
        keyVersion: r.credentialKeyVersion,
        iv: r.credentialIv,
        tag: r.credentialTag,
      },
      "connection",
      r.id,
    );
    if (r.credentialKeyVersion === ring.activeVersion) {
      skipped++;
      continue;
    }
    const result = await db.externalMcpConnection.updateMany({
      where: r,
      data: encryptExternalCredential(ring, plaintext, r.id),
    });
    rotated += result.count;
    skipped += 1 - result.count;
  }
  for (const r of approvals) {
    const plaintext = decryptExternalSecret(
      ring,
      {
        ciphertext: r.pendingArgumentsCiphertext,
        keyVersion: r.pendingArgumentsKeyVersion,
        iv: r.pendingArgumentsIv,
        tag: r.pendingArgumentsTag,
      },
      "approval",
      r.id,
    );
    if (r.pendingArgumentsKeyVersion === ring.activeVersion) {
      skipped++;
      continue;
    }
    const v = encryptExternalSecret(ring, plaintext, "approval", r.id);
    const result = await db.externalMcpToolApproval.updateMany({
      where: r,
      data: {
        pendingArgumentsCiphertext: v.ciphertext,
        pendingArgumentsKeyVersion: v.keyVersion,
        pendingArgumentsIv: v.iv,
        pendingArgumentsTag: v.tag,
      },
    });
    rotated += result.count;
    skipped += 1 - result.count;
  }
  return { rotated, skipped };
}
