import { z } from "zod";

const projectId = z.uuid();
const artifactId = z.uuid();

export const listArtifactsInput = z.object({
  projectId,
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(100).default(25),
  search: z.string().trim().max(200).optional(),
  sort: z.enum(["filename", "byteSize", "updatedAt"]).default("filename"),
  dir: z.enum(["asc", "desc"]).default("asc"),
});

export const renameArtifactInput = z.object({
  projectId,
  artifactId,
  filename: z.string().min(1).max(255),
});

export const artifactIdInput = z.object({ projectId, artifactId });
