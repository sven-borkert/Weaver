import type { CommitAuthor } from "@weaver/git-store";
import { authorForUser, type DocumentAuthor } from "../documents/frontmatter";
import type { EnrichedActor } from "./documents";

export type MachineContentAuthor = {
  kind: "projectApiKey";
  projectId: string;
  keyId: string;
  name: string;
  email: string;
};
export type ContentWriteActor = EnrichedActor | MachineContentAuthor;

/** True when the writer has no `User` row behind it. */
export function hasNoUser(
  actor: ContentWriteActor,
): actor is MachineContentAuthor {
  return "kind" in actor && actor.kind === "projectApiKey";
}

/** Project API keys write verbatim; other machine authors may still enrich labels. */
export function skipsLabelEnrichment(actor: ContentWriteActor): boolean {
  return "kind" in actor && actor.kind === "projectApiKey";
}

export function machineIdentity(
  actor: ContentWriteActor,
): { machineKind: MachineContentAuthor["kind"]; machineId: string } | null {
  return hasNoUser(actor)
    ? { machineKind: actor.kind, machineId: actor.keyId }
    : null;
}

export function gitAuthorForContent(actor: ContentWriteActor): CommitAuthor {
  return hasNoUser(actor)
    ? {
        kind: "projectApiKey",
        keyId: actor.keyId,
        name: actor.name,
        email: actor.email,
      }
    : { name: actor.name, email: actor.email, userId: actor.userId };
}

export function documentAuthorForContent(
  actor: ContentWriteActor,
): DocumentAuthor {
  return hasNoUser(actor)
    ? { id: null, name: actor.name }
    : authorForUser({ id: actor.userId, name: actor.name, email: actor.email });
}

export function contentUserId(actor: ContentWriteActor): string | null {
  return hasNoUser(actor) ? null : actor.userId;
}

export function contentProjectKeyId(actor: ContentWriteActor): string | null {
  return hasNoUser(actor) ? actor.keyId : null;
}
