import { describe, expect, it } from "vitest";
import { createWikiAgentSecurityContext } from "../security/context";
import {
  contentUserId,
  documentAuthorForContent,
  gitAuthorForContent,
  hasNoUser,
  machineEditorColumns,
  machineEditorFromRow,
  machineIdentity,
  skipsLabelEnrichment,
  wikiAgentContentAuthor,
  type ContentWriteActor,
} from "./contentAuthor";

const key: ContentWriteActor = {
  kind: "projectApiKey",
  projectId: "p",
  machineId: "k",
  name: "Key",
  email: "k@example.test",
};
const user = {
  userId: "u",
  name: "U",
  email: "u@example.test",
} as unknown as ContentWriteActor;

describe("content author predicates", () => {
  it("classifies a project API key and a user", () => {
    expect(hasNoUser(key)).toBe(true);
    expect(skipsLabelEnrichment(key)).toBe(true);
    expect(machineIdentity(key)).toEqual({
      machineKind: "projectApiKey",
      machineId: "k",
    });
    expect(hasNoUser(user)).toBe(false);
    expect(skipsLabelEnrichment(user)).toBe(false);
    expect(machineIdentity(user)).toBeNull();
  });

  it("gives the wiki agent no user but keeps label enrichment", () => {
    const agent = wikiAgentContentAuthor(
      createWikiAgentSecurityContext({
        agentId: "11111111-1111-4111-8111-111111111111",
        projectId: "p",
      }),
    );
    expect(agent).toEqual({
      kind: "wikiAgent",
      projectId: "p",
      machineId: "11111111-1111-4111-8111-111111111111",
      name: "Wiki agent",
      email: "wiki-agent+11111111-1111-4111-8111-111111111111@weaver.invalid",
    });
    expect(hasNoUser(agent)).toBe(true);
    expect(skipsLabelEnrichment(agent)).toBe(false);
    expect(contentUserId(agent)).toBeNull();
    expect(documentAuthorForContent(agent)).toEqual({
      id: null,
      name: "Wiki agent",
    });
    expect(gitAuthorForContent(agent)).toEqual({
      kind: "machine",
      machineKind: "wikiAgent",
      machineId: agent.machineId,
      name: "Wiki agent",
      email: agent.email,
    });
  });

  it("writes the pair and dual-writes only a project key", () => {
    expect(
      machineEditorColumns({ machineKind: "projectApiKey", machineId: "k" }),
    ).toEqual({
      lastEditedByMachineKind: "projectApiKey",
      lastEditedByMachineId: "k",
      lastEditedByProjectKeyId: "k",
    });
    expect(
      machineEditorColumns({ machineKind: "wikiAgent", machineId: "a" }),
    ).toEqual({
      lastEditedByMachineKind: "wikiAgent",
      lastEditedByMachineId: "a",
      lastEditedByProjectKeyId: null,
    });
    expect(machineEditorColumns(null)).toEqual({
      lastEditedByMachineKind: null,
      lastEditedByMachineId: null,
      lastEditedByProjectKeyId: null,
    });
  });

  it("drops an unknown editor kind when reading a row", () => {
    const row = { lastEditedByMachineId: "a", lastEditedByName: null };
    expect(
      machineEditorFromRow({ ...row, lastEditedByMachineKind: "robot" }),
    ).toBeNull();
    expect(
      machineEditorFromRow({ ...row, lastEditedByMachineKind: "wikiAgent" }),
    ).toEqual({ kind: "wikiAgent", id: "a", name: "Wiki agent" });
  });
});
