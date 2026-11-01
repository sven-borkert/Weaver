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

export function isMachineContentAuthor(
  actor: ContentWriteActor,
): actor is MachineContentAuthor {
  return "kind" in actor && actor.kind === "projectApiKey";
}

export function gitAuthorForContent(actor: ContentWriteActor): CommitAuthor {
  return isMachineContentAuthor(actor)
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
  return isMachineContentAuthor(actor)
    ? { id: null, name: actor.name }
    : authorForUser({ id: actor.userId, name: actor.name, email: actor.email });
}

export function contentUserId(actor: ContentWriteActor): string | null {
  return isMachineContentAuthor(actor) ? null : actor.userId;
}

export function contentProjectKeyId(actor: ContentWriteActor): string | null {
  return isMachineContentAuthor(actor) ? actor.keyId : null;
}
