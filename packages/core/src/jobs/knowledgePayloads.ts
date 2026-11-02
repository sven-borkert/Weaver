import { z } from "zod";
import type { KnowledgeJobName } from "./types";

const source = {
  projectId: z.uuid(),
  sourceCommitSha: z.string().regex(/^[a-f0-9]{40}$/),
  pathAtSha: z
    .string()
    .min(1)
    .max(4096)
    .refine(
      (path) =>
        !path.startsWith("/") &&
        !path.includes("\\") &&
        !path.split("/").some((part) => part === ".." || part === "." || !part),
    ),
};
const document = { ...source, documentId: z.uuid() };
const generation = {
  projectId: z.uuid(),
  generationId: z.uuid(),
  configFingerprint: z.string().trim().min(1).max(256),
};
const schemas: Partial<Record<KnowledgeJobName, z.ZodType>> = {
  "artifact.notebook.prepare": z.strictObject({
    projectId: z.uuid(),
    artifactId: z.uuid(),
    contentDigest: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  "document.search-sync": z.strictObject(document),
  "document.ai-enrich": z.strictObject({ ...document, ...generation }),
  "document.change-summary": z.strictObject({
    projectId: z.uuid(),
    documentId: z.uuid(),
    commitSha: source.sourceCommitSha,
    baseCommitSha: source.sourceCommitSha,
    pathAtSha: source.pathAtSha,
  }),
  "table.search-sync": z.strictObject({ ...source, tableId: z.uuid() }),
  "content.delete": z.strictObject({
    projectId: z.uuid(),
    sourceType: z.enum(["document", "table"]),
    sourceId: z.uuid(),
    sourceCommitSha: source.sourceCommitSha,
  }),
  "project.reconcile": z.strictObject({
    projectId: z.uuid(),
    repairDocumentIds: z.array(z.uuid()).min(1).max(100).optional(),
  }),
  "wiki.run": z.strictObject({ runId: z.uuid() }),
  "project.generation-build": z.strictObject({
    ...generation,
    cursor: z.uuid().optional(),
  }),
};

export function validKnowledgeJobPayload(
  name: KnowledgeJobName,
  data: unknown,
): boolean {
  return schemas[name]?.safeParse(data).success ?? true;
}
