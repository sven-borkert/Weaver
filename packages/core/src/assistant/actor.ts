import { z } from "zod";
import { CAPABILITIES, type SecurityContext } from "../security/context";

export const actorSnapshotSchema = z.object({
  userId: z.string(),
  globalRole: z.enum(["Admin", "User"]),
  authenticationMethod: z.enum(["session", "oauth", "apiKey", "task"]),
  credentialId: z.string(),
  capabilities: z.array(z.enum(CAPABILITIES)),
  allowedProjectIds: z.union([
    z.literal("all-accessible"),
    z.array(z.string()),
  ]),
});
export type ActorSnapshot = z.infer<typeof actorSnapshotSchema>;

export function serializeSecurityContext(ctx: SecurityContext): ActorSnapshot {
  return {
    userId: ctx.userId,
    globalRole: ctx.globalRole,
    authenticationMethod: ctx.authenticationMethod,
    credentialId: ctx.credentialId,
    capabilities: [...ctx.capabilities],
    allowedProjectIds:
      ctx.allowedProjectIds === "all-accessible"
        ? "all-accessible"
        : [...ctx.allowedProjectIds],
  };
}

export function deserializeSecurityContext(raw: unknown): SecurityContext {
  const snapshot = actorSnapshotSchema.parse(raw);
  return Object.freeze({
    userId: snapshot.userId,
    globalRole: snapshot.globalRole,
    authenticationMethod: snapshot.authenticationMethod,
    credentialId: snapshot.credentialId,
    capabilities: new Set(snapshot.capabilities),
    allowedProjectIds:
      snapshot.allowedProjectIds === "all-accessible"
        ? "all-accessible"
        : new Set(snapshot.allowedProjectIds),
  });
}
