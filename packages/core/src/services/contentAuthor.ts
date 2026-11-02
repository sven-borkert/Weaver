import type { CommitAuthor, MachineAuthorKind } from "@weaver/git-store";
import { authorForUser, type DocumentAuthor } from "../documents/frontmatter";
import type { WikiAgentSecurityContext } from "../security/context";
import type { EnrichedActor } from "./documents";
import { WIKI_AGENT_NAME, wikiAgentEmail } from "./wikiAgents";

export type MachineContentAuthor = {
  kind: MachineAuthorKind;
  projectId: string;
  machineId: string;
  name: string;
  email: string;
};
export type ContentWriteActor = EnrichedActor | MachineContentAuthor;

/** The projection's machine editor and what history and explorer items expose. */
export type MachineEditor = {
  kind: MachineAuthorKind;
  id: string;
  name: string;
};
export type MachineEditorRef = {
  machineKind: MachineAuthorKind;
  machineId: string;
};

export function wikiAgentContentAuthor(
  context: WikiAgentSecurityContext,
): MachineContentAuthor {
  return {
    kind: "wikiAgent",
    projectId: context.projectId,
    machineId: context.agentId,
    name: WIKI_AGENT_NAME,
    email: wikiAgentEmail(context.agentId),
  };
}

/** True when the writer has no `User` row behind it. */
export function hasNoUser(
  actor: ContentWriteActor,
): actor is MachineContentAuthor {
  return actor.kind === "projectApiKey" || actor.kind === "wikiAgent";
}

/** Project API keys write verbatim; other machine authors still enrich labels. */
export function skipsLabelEnrichment(actor: ContentWriteActor): boolean {
  return actor.kind === "projectApiKey";
}

export function machineIdentity(
  actor: ContentWriteActor,
): MachineEditorRef | null {
  return hasNoUser(actor)
    ? { machineKind: actor.kind, machineId: actor.machineId }
    : null;
}

export function gitAuthorForContent(actor: ContentWriteActor): CommitAuthor {
  return hasNoUser(actor)
    ? {
        kind: "machine",
        machineKind: actor.kind,
        machineId: actor.machineId,
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

/** Writes the pair and dual-writes the old project key column this release. */
export function machineEditorColumns(machine: MachineEditorRef | null): {
  lastEditedByMachineKind: MachineAuthorKind | null;
  lastEditedByMachineId: string | null;
  lastEditedByProjectKeyId: string | null;
} {
  return {
    lastEditedByMachineKind: machine?.machineKind ?? null,
    lastEditedByMachineId: machine?.machineId ?? null,
    lastEditedByProjectKeyId:
      machine?.machineKind === "projectApiKey" ? machine.machineId : null,
  };
}

export function machineEditorFromRow(row: {
  lastEditedByMachineKind: string | null;
  lastEditedByMachineId: string | null;
  lastEditedByName: string | null;
}): MachineEditor | null {
  const { lastEditedByMachineKind: kind, lastEditedByMachineId: id } = row;
  if (!id || (kind !== "projectApiKey" && kind !== "wikiAgent")) return null;
  return {
    kind,
    id,
    name:
      row.lastEditedByName ??
      (kind === "wikiAgent" ? WIKI_AGENT_NAME : "Project API key"),
  };
}
