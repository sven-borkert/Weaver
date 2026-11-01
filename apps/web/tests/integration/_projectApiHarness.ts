import { randomUUID } from "node:crypto";
import type { ProjectApiKey } from "@weaver/db/client";
import { generateProjectMachineToken } from "@weaver/core/projectApi/credentials";
import type {
  StoredGrant,
  ProjectMachineContext,
} from "@weaver/core/projectApi/types";
import {
  createDocument,
  type EnrichedActor,
} from "@weaver/core/services/documents";
import { createTable } from "@weaver/core/services/tables";
import { createFolder } from "@weaver/core/services/folders";
import {
  addMembership,
  getPrisma,
  makeProject,
  makeUser,
  securityContextFor,
} from "./_harness";

export async function makeMachineFixture() {
  const db = getPrisma();
  const owner = await makeUser("User", `machine-${randomUUID()}`);
  const project = await makeProject("Audit automation");
  await addMembership(project.id, owner.id, "Owner");
  const actor: EnrichedActor = {
    ...securityContextFor(owner),
    name: "Audit owner",
    email: owner.email,
  };
  const documentFolder = (
    await createFolder(
      db,
      { projectId: project.id, parentPath: [], name: "Audit" },
      actor,
    )
  ).path;
  const tableFolder = (
    await createFolder(
      db,
      { projectId: project.id, parentPath: [], name: "Audit" },
      actor,
      "tables",
    )
  ).path;
  const document = await createDocument(
    db,
    {
      projectId: project.id,
      folderPath: documentFolder,
      title: "Latest audit",
      content: {
        kind: "markdown",
        contentJson: {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "Original audit result" }],
            },
          ],
        },
      },
    },
    actor,
  );
  const columnId = randomUUID();
  const table = await createTable(
    db,
    {
      projectId: project.id,
      folderPath: tableFolder,
      title: "Audit results",
      columns: [{ id: columnId, name: "Account", type: "text" }],
      rows: [
        { id: randomUUID(), cells: { [columnId]: "original-private-account" } },
      ],
    },
    actor,
  );
  return {
    db,
    owner,
    actor,
    project,
    documentFolder,
    tableFolder,
    document,
    table,
  };
}

export type MachineFixture = Awaited<ReturnType<typeof makeMachineFixture>>;

export async function seedProjectMachineKey(
  f: MachineFixture,
  grants: StoredGrant[],
  overrides: Partial<
    Pick<
      ProjectApiKey,
      "name" | "expiresAt" | "revokedAt" | "rateLimitPerMinute"
    >
  > = {},
) {
  const keyId = randomUUID();
  const token = generateProjectMachineToken(keyId);
  const key = await f.db.projectApiKey.create({
    data: {
      id: keyId,
      projectId: f.project.id,
      createdById: f.owner.id,
      name: "Audit publisher",
      digest: token.digest,
      fingerprint: token.fingerprint,
      expiresAt: null,
      createdAt: new Date(),
      ...overrides,
      grants: {
        create: grants.map((grant) => ({
          targetKind: grant.kind,
          targetId: grant.targetId,
          isScopeRoot: grant.root,
          canRead: grant.actions.includes("read"),
          canCreate: grant.actions.includes("create"),
          canUpdate: grant.actions.includes("update"),
          canDelete: grant.actions.includes("delete"),
        })),
      },
    },
  });
  const context: ProjectMachineContext = {
    kind: "projectMachine",
    projectId: key.projectId,
    keyId,
    name: key.name,
    policyVersion: key.policyVersion,
  };
  return { secret: token.secret, context, keyId };
}
