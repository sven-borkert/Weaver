import { CoreError } from "../errors";
import type { PrismaClient, Prisma } from "@weaver/db/client";
import {
  parseProjectMachineBearer,
  verifyProjectMachineDigest,
} from "../projectApi/credentials";
import type { ProjectMachineContext } from "../projectApi/types";

export async function requireLiveProjectMachineKey(
  db: PrismaClient | Prisma.TransactionClient,
  keyId: string,
  projectId: string,
  now = new Date(),
) {
  const key = await db.projectApiKey.findUnique({
    where: { id: keyId },
    include: { project: { select: { deletedAt: true } } },
  });
  if (
    !key ||
    key.revokedAt ||
    (key.expiresAt !== null && key.expiresAt.getTime() <= now.getTime())
  )
    throw new CoreError("UNAUTHORIZED", "Invalid project API credential");
  if (key.projectId !== projectId || key.project.deletedAt !== null)
    throw new CoreError("NOT_FOUND");
  return key;
}

export async function resolveProjectMachineContext(
  db: PrismaClient,
  authorization: string | null,
  projectId: string,
  now = new Date(),
): Promise<ProjectMachineContext> {
  const parsed = parseProjectMachineBearer(authorization);
  if (!parsed)
    throw new CoreError("UNAUTHORIZED", "A project API key is required");
  const key = await db.projectApiKey.findUnique({
    where: { id: parsed.keyId },
    select: { digest: true },
  });
  if (!key || !verifyProjectMachineDigest(parsed.token, key.digest))
    throw new CoreError("UNAUTHORIZED", "Invalid project API credential");
  const live = await requireLiveProjectMachineKey(
    db,
    parsed.keyId,
    projectId,
    now,
  );
  return Object.freeze({
    kind: "projectMachine",
    projectId: live.projectId,
    keyId: live.id,
    name: live.name,
    policyVersion: live.policyVersion,
  });
}
