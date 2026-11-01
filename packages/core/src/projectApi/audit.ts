import { z } from "zod";
import type { PrismaClient } from "@weaver/db/client";
import { machineUuid } from "./schemas";

// Metadata only: the strict schema has no room for headers, bodies or secrets.
const projectApiAuditSchema = z.strictObject({
  requestId: z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/),
  projectId: machineUuid,
  keyId: machineUuid,
  method: z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]),
  operation: z.string().regex(/^[a-z.]{1,40}$/),
  resourceId: machineUuid.nullable(),
  outcome: z.enum(["succeeded", "rejected", "failed"]),
  status: z.number().int().min(100).max(599),
  durationMs: z.number().int().min(0).max(2_147_483_647),
  commitSha: z
    .string()
    .regex(/^[a-f0-9]{40}$/)
    .nullable(),
});
export type ProjectApiAuditInput = z.input<typeof projectApiAuditSchema>;

export async function recordProjectApiAudit(
  db: PrismaClient,
  input: ProjectApiAuditInput,
): Promise<void> {
  const event = projectApiAuditSchema.parse(input);
  await db.projectApiAuditEvent.create({
    data: { ...event, createdAt: new Date() },
  });
}
