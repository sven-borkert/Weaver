import { randomUUID } from "node:crypto";
import { getPrisma, type makeUser } from "./_harness";
type UserFixture = Awaited<ReturnType<typeof makeUser>>;

export async function removeMembership(projectId: string, userId: string) {
  const project = await getPrisma().project.findUniqueOrThrow({
    where: { id: projectId },
    select: { organizationId: true },
  });
  await getPrisma().member.deleteMany({
    where: { organizationId: project.organizationId, userId },
  });
}

export async function createTaskRun(input: {
  owner: UserFixture;
  projectId: string;
  name: string;
  status?: "queued" | "running" | "succeeded" | "failed" | "skipped";
  at?: Date;
}) {
  const at = input.at ?? new Date();
  const task = await getPrisma().scheduledTask.create({
    data: {
      ownerId: input.owner.id,
      name: input.name,
      instruction: "fixture",
      scopeRequest: { kind: "project", projectId: input.projectId },
      scopeSnapshot: {
        kind: "project",
        projectIds: [input.projectId],
        documentId: null,
        tableId: null,
        resolvedAt: at.toISOString(),
        truncated: false,
      },
      outputProjectId: input.projectId,
      outputFolderPath: [],
      schedule: { kind: "daily", hour: 7, minute: 0 },
      timezone: "UTC",
      cron: "0 7 * * *",
    },
  });
  const status = input.status ?? "succeeded";
  return getPrisma().scheduledTaskRun.create({
    data: {
      taskId: task.id,
      trigger: "manual",
      status,
      queuedAt: at,
      startedAt: status === "queued" ? null : at,
      finishedAt: ["succeeded", "failed", "skipped"].includes(status)
        ? at
        : null,
    },
  });
}

export async function createImport(input: {
  owner: UserFixture;
  projectId: string;
  name: string;
  status?:
    | "pending"
    | "parsing"
    | "extracting"
    | "linking"
    | "ready"
    | "accepting"
    | "accepted"
    | "rejected"
    | "failed"
    | "blocked_configuration";
  at?: Date;
  attemptCount?: number;
  origin?: "upload" | "external";
}) {
  const at = input.at ?? new Date();
  const batch = await getPrisma().ingestionBatch.create({
    data: {
      projectId: input.projectId,
      createdById: input.owner.id,
      origin: input.origin ?? "upload",
      createdAt: at,
    },
  });
  const status = input.status ?? "ready";
  return getPrisma().ingestionFile.create({
    data: {
      batchId: batch.id,
      projectId: input.projectId,
      fileName: input.name,
      mimeType: "text/markdown",
      byteSize: 10,
      contentDigest: randomUUID().replaceAll("-", "").padEnd(64, "0"),
      status,
      attemptCount: input.attemptCount ?? 1,
      createdAt: at,
      parseStartedAt: status === "pending" ? null : at,
      parseEndedAt: [
        "ready",
        "accepting",
        "accepted",
        "rejected",
        "failed",
        "blocked_configuration",
      ].includes(status)
        ? at
        : null,
    },
  });
}

export async function createAssistantRun(input: {
  owner: UserFixture;
  projectIds: string[];
  status?:
    "queued" | "running" | "cancelling" | "completed" | "failed" | "cancelled";
  at?: Date;
  scopeSnapshot?: unknown;
}) {
  const at = input.at ?? new Date();
  const conversation = await getPrisma().assistantConversation.create({
    data: { ownerId: input.owner.id, title: "Private title", createdAt: at },
  });
  const message = await getPrisma().assistantMessage.create({
    data: {
      conversationId: conversation.id,
      position: 0,
      role: "user",
      status: "complete",
      content: { text: "secret prompt" },
      createdAt: at,
    },
  });
  const status = input.status ?? "completed";
  const scopeSnapshot = input.scopeSnapshot ?? {
    kind: input.projectIds.length === 1 ? "project" : "projects",
    projectIds: input.projectIds,
    documentId: null,
    tableId: null,
    resolvedAt: at.toISOString(),
    truncated: false,
  };
  return getPrisma().assistantRun.create({
    data: {
      conversationId: conversation.id,
      userMessageId: message.id,
      status,
      scopeSnapshot: scopeSnapshot as object,
      actorSnapshot: { userId: input.owner.id },
      queuedAt: at,
      startedAt: status === "queued" ? null : at,
      finishedAt: ["completed", "failed", "cancelled"].includes(status)
        ? at
        : null,
    },
  });
}

export async function createKnowledge(input: {
  projectId: string;
  status: "building" | "active" | "failed" | "superseded";
  documentStates?: Array<
    | "pending"
    | "processing"
    | "ready"
    | "failed"
    | "blocked_configuration"
    | "missing"
  >;
  at?: Date;
}) {
  const at = input.at ?? new Date();
  const generation = await getPrisma().knowledgeGeneration.create({
    data: {
      projectId: input.projectId,
      configFingerprint: randomUUID(),
      embeddingModel: "fixture",
      embeddingDimensions: 3,
      extractionSchemaVersion: 1,
      promptVersion: "fixture",
      status: input.status,
      createdAt: at,
      completedAt: input.status === "building" ? null : at,
      activatedAt: input.status === "active" ? at : null,
      supersededAt: input.status === "superseded" ? at : null,
    },
  });
  const states = input.documentStates ?? [];
  if (states.length > 0) {
    await getPrisma().knowledgeGenerationDocument.createMany({
      data: states.map((status) => ({
        generationId: generation.id,
        documentId: randomUUID(),
        projectId: input.projectId,
        targetSha: randomUUID(),
        configFingerprint: generation.configFingerprint,
        status,
      })),
    });
  }
  return generation;
}
