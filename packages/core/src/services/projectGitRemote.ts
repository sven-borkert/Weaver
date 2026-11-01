import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient, ProjectGitRemote } from "@weaver/db/client";
import {
  GitRemoteError,
  inspectSshPrivateKey,
  pinnedHostFingerprints,
  validateGitRemoteTarget,
} from "@weaver/git-store/remote";
import { CoreError } from "../errors";
import { requestKnowledgeJob } from "../jobs/queue";
import type { SecurityContext } from "../security/context";
import {
  decryptSecret,
  encryptSecret,
  secretAad,
  type EncryptionKeyRing,
} from "../security/encryption";
import { assertProjectRole } from "./projectAccess";
import {
  dispatchProjectGitRemote,
  PROJECT_GIT_QUEUE_TTL_MS,
} from "./projectGitRemoteJobs";

type Db = PrismaClient | Prisma.TransactionClient;
type Deps = { db: PrismaClient; ring: EncryptionKeyRing | null };
export type ProjectGitRemoteView = {
  projectId: string;
  remoteUrl: string;
  branch: string;
  enabled: boolean;
  revision: number;
  key: { name: string; fingerprint: string; uploadedAt: Date } | null;
  hostKeyFingerprints: string[];
  lastPushedSha: string | null;
  lastPushedAt: Date | null;
  lastAttemptAt: Date | null;
  lastErrorCode: string | null;
  failureCount: number;
  nextAttemptAt: Date;
  queued: boolean;
  pushing: boolean;
  pullQueued: boolean;
  pulling: boolean;
  lastPullSha: string | null;
  lastPullAt: Date | null;
  lastPullErrorCode: string | null;
};

function view(row: ProjectGitRemote): ProjectGitRemoteView {
  return {
    projectId: row.projectId,
    remoteUrl: row.remoteUrl,
    branch: row.branch,
    enabled: row.enabled,
    revision: row.revision,
    key:
      row.keyName && row.keyFingerprint && row.keyUploadedAt
        ? {
            name: row.keyName,
            fingerprint: row.keyFingerprint,
            uploadedAt: row.keyUploadedAt,
          }
        : null,
    hostKeyFingerprints: pinnedHostFingerprints(row.knownHosts),
    lastPushedSha: row.lastPushedSha,
    lastPushedAt: row.lastPushedAt,
    lastAttemptAt: row.lastAttemptAt,
    lastErrorCode: row.lastErrorCode,
    failureCount: row.failureCount,
    nextAttemptAt: row.nextAttemptAt,
    queued: !!row.queueToken && !row.leaseToken,
    pushing:
      !!row.leaseToken &&
      !!row.leaseExpiresAt &&
      row.leaseExpiresAt > new Date(),
    pullQueued: pullQueueLive(row, new Date()),
    pulling:
      !!row.leaseToken &&
      !!row.leaseExpiresAt &&
      row.leaseExpiresAt > new Date() &&
      !row.queueToken &&
      row.pullRequestedAt !== null &&
      (row.lastPullAt === null || row.pullRequestedAt > row.lastPullAt),
    lastPullSha: row.lastPullSha,
    lastPullAt: row.lastPullAt,
    lastPullErrorCode: row.lastPullErrorCode,
  };
}

/** A queued pull whose job never admitted (push held the lease, the key was
 * deleted, the worker shut down) must not block the next request forever;
 * the token is live only for the shared queue TTL, as a push token is. */
function pullQueueLive(
  row: Pick<ProjectGitRemote, "pullQueueToken" | "pullRequestedAt">,
  now: Date,
): boolean {
  return (
    !!row.pullQueueToken &&
    row.pullRequestedAt !== null &&
    row.pullRequestedAt.getTime() > now.getTime() - PROJECT_GIT_QUEUE_TTL_MS
  );
}

async function owner(
  db: Db,
  actor: SecurityContext,
  projectId: string,
  write = true,
) {
  if (actor.authenticationMethod !== "session")
    throw new CoreError("FORBIDDEN");
  await assertProjectRole(db, projectId, actor, "Owner", {
    capability: write ? "content:write" : "content:read",
  });
}

async function locked<T>(
  db: PrismaClient,
  actor: SecurityContext,
  projectId: string,
  fn: (
    tx: Prisma.TransactionClient,
    row: ProjectGitRemote | null,
  ) => Promise<T>,
): Promise<T> {
  await owner(db, actor, projectId);
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${projectId}, 0))::text`;
    await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id" = ${projectId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "ProjectGitRemote" WHERE "projectId" = ${projectId}::uuid FOR UPDATE`;
    await owner(tx, actor, projectId);
    return fn(
      tx,
      await tx.projectGitRemote.findUnique({ where: { projectId } }),
    );
  });
}

function existing(
  row: ProjectGitRemote | null,
  expectedRevision: number,
): ProjectGitRemote {
  if (!row) throw new CoreError("NOT_FOUND");
  if (row.revision !== expectedRevision)
    throw new CoreError(
      "CONFLICT",
      "Git remote settings changed. Reload before saving.",
    );
  return row;
}

function resetSchedule() {
  return {
    queueToken: null,
    queuedAt: null,
    nextAttemptAt: new Date(),
    failureCount: 0,
    lastErrorCode: null,
  };
}

function invalid(error: unknown, field: string): never {
  if (error instanceof GitRemoteError)
    throw new CoreError("BAD_REQUEST", error.message, { field });
  throw error;
}

export async function getProjectGitRemote(
  db: PrismaClient,
  actor: SecurityContext,
  projectId: string,
): Promise<ProjectGitRemoteView | null> {
  await owner(db, actor, projectId, false);
  const row = await db.projectGitRemote.findUnique({ where: { projectId } });
  return row ? view(row) : null;
}

export async function saveProjectGitRemote(
  db: PrismaClient,
  actor: SecurityContext,
  input: {
    projectId: string;
    expectedRevision?: number;
    remoteUrl: string;
    branch: string;
    enabled: boolean;
  },
): Promise<ProjectGitRemoteView> {
  await owner(db, actor, input.projectId);
  let target: { url: string; branch: string };
  try {
    target = validateGitRemoteTarget(input.remoteUrl, input.branch);
  } catch (error) {
    return invalid(
      error,
      error instanceof GitRemoteError && error.code === "INVALID_BRANCH"
        ? "branch"
        : "remoteUrl",
    );
  }
  const result = await locked(db, actor, input.projectId, async (tx, row) => {
    if (row && input.expectedRevision !== row.revision)
      throw new CoreError(
        "CONFLICT",
        "Git remote settings changed. Reload before saving.",
      );
    if (!row && input.expectedRevision !== undefined)
      throw new CoreError("NOT_FOUND");
    if (input.enabled && !row?.credentialCiphertext)
      throw new CoreError(
        "PRECONDITION_FAILED",
        "Upload a private key before enabling automatic pushes.",
      );
    if (!row)
      return view(
        await tx.projectGitRemote.create({
          data: {
            projectId: input.projectId,
            remoteUrl: target.url,
            branch: target.branch,
            enabled: false,
            createdAt: new Date(),
            nextAttemptAt: new Date(),
          },
        }),
      );
    const targetChanged =
      row.remoteUrl !== target.url || row.branch !== target.branch;
    return view(
      await tx.projectGitRemote.update({
        where: { id: row.id },
        data: {
          remoteUrl: target.url,
          branch: target.branch,
          enabled: input.enabled,
          revision: { increment: 1 },
          ...resetSchedule(),
          ...(targetChanged
            ? {
                lastPushedSha: null,
                lastPushedAt: null,
                // A pull queued against the old target must not run now.
                pullQueueToken: null,
                pullRequestedAt: null,
              }
            : {}),
          ...(row.remoteUrl !== target.url ? { knownHosts: null } : {}),
        },
      }),
    );
  });
  if (result.enabled && result.key) {
    await dispatchProjectGitRemote({ db, projectId: input.projectId }).catch(
      () => false,
    );
  }
  return result;
}

export async function uploadProjectGitRemoteKey(
  deps: Deps,
  actor: SecurityContext,
  input: {
    projectId: string;
    expectedRevision: number;
    keyName: string;
    privateKey: string;
  },
): Promise<ProjectGitRemoteView> {
  await owner(deps.db, actor, input.projectId);
  if (!deps.ring)
    throw new CoreError(
      "PRECONDITION_FAILED",
      "Configure Weaver's encryption keys before uploading a private key.",
    );
  const keyName = input.keyName.trim();
  if (!keyName || keyName.length > 120 || /[\r\n\0]/.test(keyName))
    throw new CoreError(
      "BAD_REQUEST",
      "Enter a key name of up to 120 characters.",
      { field: "keyName" },
    );
  if (Buffer.byteLength(input.privateKey, "utf8") > 65536)
    throw new CoreError("BAD_REQUEST", "Private keys must be at most 64 KiB.", {
      field: "privateKey",
    });
  let fingerprint: string;
  try {
    ({ fingerprint } = await inspectSshPrivateKey(input.privateKey));
  } catch (error) {
    return invalid(error, "privateKey");
  }
  const result = await locked(
    deps.db,
    actor,
    input.projectId,
    async (tx, current) => {
      const row = existing(current, input.expectedRevision);
      const encrypted = encryptSecret(
        deps.ring!,
        input.privateKey,
        secretAad("project-git-remote", row.id),
      );
      return view(
        await tx.projectGitRemote.update({
          where: { id: row.id },
          data: {
            keyName,
            keyFingerprint: fingerprint,
            keyUploadedAt: new Date(),
            credentialCiphertext: Buffer.from(encrypted.ciphertext),
            credentialNonce: Buffer.from(encrypted.nonce),
            credentialTag: Buffer.from(encrypted.tag),
            credentialKeyVersion: encrypted.keyVersion,
            revision: { increment: 1 },
            lastPushedSha: null,
            lastPushedAt: null,
            ...resetSchedule(),
          },
        }),
      );
    },
  );
  if (result.enabled) {
    await dispatchProjectGitRemote({
      db: deps.db,
      projectId: input.projectId,
    }).catch(() => false);
  }
  return result;
}

export async function deleteProjectGitRemoteKey(
  db: PrismaClient,
  actor: SecurityContext,
  input: { projectId: string; expectedRevision: number },
): Promise<ProjectGitRemoteView> {
  return locked(db, actor, input.projectId, async (tx, current) => {
    const row = existing(current, input.expectedRevision);
    return view(
      await tx.projectGitRemote.update({
        where: { id: row.id },
        data: {
          enabled: false,
          keyName: null,
          keyFingerprint: null,
          keyUploadedAt: null,
          credentialCiphertext: null,
          credentialNonce: null,
          credentialTag: null,
          credentialKeyVersion: null,
          revision: { increment: 1 },
          pullQueueToken: null,
          pullRequestedAt: null,
          ...resetSchedule(),
        },
      }),
    );
  });
}

export async function removeProjectGitRemote(
  db: PrismaClient,
  actor: SecurityContext,
  input: { projectId: string; expectedRevision: number },
): Promise<void> {
  await locked(db, actor, input.projectId, async (tx, current) => {
    const row = existing(current, input.expectedRevision);
    if (row.leaseExpiresAt && row.leaseExpiresAt > new Date())
      throw new CoreError(
        "CONFLICT",
        "A push is in progress. Wait for it to finish before removing the remote.",
      );
    await tx.projectGitRemote.delete({ where: { id: row.id } });
  });
}

export async function requestProjectGitRemotePush(
  db: PrismaClient,
  actor: SecurityContext,
  projectId: string,
): Promise<ProjectGitRemoteView> {
  const result = await locked(db, actor, projectId, async (tx, row) => {
    if (!row) throw new CoreError("NOT_FOUND");
    if (!row.enabled || !row.credentialCiphertext)
      throw new CoreError(
        "PRECONDITION_FAILED",
        "Upload a key and enable automatic pushes first.",
      );
    if (row.leaseExpiresAt && row.leaseExpiresAt > new Date())
      throw new CoreError("CONFLICT", "A push is already in progress.");
    return view(
      await tx.projectGitRemote.update({
        where: { id: row.id },
        data: { ...resetSchedule(), lastPushedSha: null },
      }),
    );
  });
  await dispatchProjectGitRemote({ db, projectId }).catch(() => false);
  return result;
}

export async function requestProjectGitRemotePull(
  db: PrismaClient,
  actor: SecurityContext,
  projectId: string,
): Promise<ProjectGitRemoteView> {
  let pullToken = "";
  const result = await locked(db, actor, projectId, async (tx, row) => {
    if (!row) throw new CoreError("NOT_FOUND");
    if (!row.credentialCiphertext)
      throw new CoreError(
        "PRECONDITION_FAILED",
        "Upload a private key before pulling remote content.",
      );
    if (pullQueueLive(row, new Date()))
      throw new CoreError("CONFLICT", "A pull is already queued.");
    if (row.leaseExpiresAt && row.leaseExpiresAt > new Date())
      throw new CoreError("CONFLICT", "A push or pull is already in progress.");
    pullToken = randomUUID();
    return view(
      await tx.projectGitRemote.update({
        where: { id: row.id },
        data: {
          pullQueueToken: pullToken,
          pullRequestedAt: new Date(),
          pullRequestedById: actor.userId,
          lastPullErrorCode: null,
        },
      }),
    );
  });
  const jobId = await requestKnowledgeJob("project.git-pull", {
    projectId,
    pullToken,
  }).catch(() => null);
  if (!jobId) {
    await db.projectGitRemote.updateMany({
      where: { projectId, pullQueueToken: pullToken },
      data: { pullQueueToken: null },
    });
    throw new CoreError(
      "PRECONDITION_FAILED",
      "Background jobs are unavailable; try again later.",
    );
  }
  return result;
}

export function decryptProjectGitRemoteKey(
  row: ProjectGitRemote,
  ring: EncryptionKeyRing | null,
): string {
  if (
    !ring ||
    !row.credentialCiphertext ||
    !row.credentialNonce ||
    !row.credentialTag ||
    row.credentialKeyVersion === null
  )
    throw new CoreError(
      "PRECONDITION_FAILED",
      "The Git remote private key is unavailable.",
    );
  try {
    return decryptSecret(
      ring,
      {
        ciphertext: row.credentialCiphertext,
        nonce: row.credentialNonce,
        tag: row.credentialTag,
        keyVersion: row.credentialKeyVersion,
      },
      secretAad("project-git-remote", row.id),
    );
  } catch {
    throw new CoreError(
      "PRECONDITION_FAILED",
      "The Git remote private key cannot be decrypted.",
    );
  }
}

export async function assertProjectGitRemoteSecretsDecryptable(
  db: PrismaClient,
  ring: EncryptionKeyRing | null,
): Promise<void> {
  const rows = await db.projectGitRemote.findMany({
    where: { credentialCiphertext: { not: null } },
  });
  for (const row of rows) {
    try {
      decryptProjectGitRemoteKey(row, ring);
    } catch {
      throw new Error(
        "Project Git remote keys cannot be decrypted. Restore the required WEAVER_ENCRYPTION_KEYS versions before starting Weaver.",
      );
    }
  }
}

export async function rotateProjectGitRemoteSecrets(
  db: PrismaClient,
  ring: EncryptionKeyRing,
): Promise<{ rotated: number; skipped: number }> {
  const rows = await db.projectGitRemote.findMany({
    where: { credentialCiphertext: { not: null } },
  });
  let rotated = 0;
  for (const row of rows) {
    if (row.credentialKeyVersion === ring.activeVersion) continue;
    const encrypted = encryptSecret(
      ring,
      decryptProjectGitRemoteKey(row, ring),
      secretAad("project-git-remote", row.id),
    );
    const result = await db.projectGitRemote.updateMany({
      where: {
        id: row.id,
        revision: row.revision,
        credentialKeyVersion: row.credentialKeyVersion,
      },
      data: {
        credentialCiphertext: Buffer.from(encrypted.ciphertext),
        credentialNonce: Buffer.from(encrypted.nonce),
        credentialTag: Buffer.from(encrypted.tag),
        credentialKeyVersion: encrypted.keyVersion,
      },
    });
    rotated += result.count;
  }
  return { rotated, skipped: rows.length - rotated };
}
