import { beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { defineSharedReadTool } from "@weaver/assistant-tools/contract";
import {
  listDocumentsTool,
  readDocumentTool,
} from "@weaver/assistant-tools/tools/documents";
import { listContentFoldersTool } from "@weaver/assistant-tools/tools/folders";
import {
  entityDetailTool,
  searchEntitiesTool,
} from "@weaver/assistant-tools/tools/graph";
import { navigateDocumentTool } from "@weaver/assistant-tools/tools/navigate";
import { searchKnowledgeTool } from "@weaver/assistant-tools/tools/search";
import {
  effectiveScope,
  resolveScopeSnapshot,
} from "@weaver/core/assistant/scope";
import {
  createApiKeySecurityContext,
  createSessionSecurityContext,
  createWikiAgentSecurityContext,
} from "@weaver/core/security/context";
import { listAvailableExternalTools } from "@weaver/core/services/externalMcp/access";
import { assertConnectionManager } from "@weaver/core/services/externalMcp/connections";
import {
  assertProjectRole,
  resolveProjectAccess,
} from "@weaver/core/services/projectAccess";
import {
  assertTrainer,
  trainerProjectIds,
} from "@weaver/core/services/projectTraining";
import { listProjectsForUser } from "@weaver/core/services/projects";
import { getProjectForActor } from "@weaver/core/services/projects";
import {
  createWikiAgent,
  getLiveWikiAgent,
  revokeWikiAgent,
} from "@weaver/core/services/wikiAgents";
import {
  addMembership,
  callerFor,
  callerWithSecurity,
  getPrisma,
  makeProject,
  makeUser,
  resetDb,
} from "./_harness";

describe("credential-scoped security contexts", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("hides projects outside a key's restriction as NOT_FOUND and filters lists", async () => {
    const user = await makeUser("User", "sc1");
    const inside = await makeProject("Inside");
    const outside = await makeProject("Outside");
    await addMembership(inside.id, user.id, "Owner");
    await addMembership(outside.id, user.id, "Owner");
    const restricted = callerWithSecurity(
      user,
      createApiKeySecurityContext({
        userId: user.id,
        globalRole: "User",
        keyId: "key-1",
        permissions: null,
        projectIds: [inside.id],
      }),
    );

    await expect(
      restricted.project.get({ projectId: inside.id }),
    ).resolves.toMatchObject({ id: inside.id });
    await expect(
      restricted.project.get({ projectId: outside.id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await restricted.project.list()).map((p) => p.id)).toEqual([
      inside.id,
    ]);
    expect((await callerFor(user).project.list()).length).toBe(2);
  });

  it("rejects writes without content:write as FORBIDDEN while reads stay allowed", async () => {
    const user = await makeUser("User", "sc2");
    const project = await makeProject("P");
    await addMembership(project.id, user.id, "Maintainer");
    const readOnly = callerWithSecurity(
      user,
      createApiKeySecurityContext({
        userId: user.id,
        globalRole: "User",
        keyId: "key-2",
        permissions: null,
        projectIds: [],
      }),
    );

    await expect(
      readOnly.project.update({ projectId: project.id, name: "x" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      readOnly.knowledge.rebuild({ projectId: project.id }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    // Carry-over: Maintainer-gated *read* must work for a read-only credential.
    await expect(
      readOnly.knowledge.status({ projectId: project.id }),
    ).resolves.toBeDefined();
    await expect(
      readOnly.knowledge.readiness({ projectId: project.id }),
    ).resolves.toBeDefined();
  });

  it("still requires Maintainer for knowledge.status regardless of capability", async () => {
    const editor = await makeUser("User", "sc3");
    const project = await makeProject("P");
    await addMembership(project.id, editor.id, "Editor");
    await expect(
      callerFor(editor).knowledge.status({ projectId: project.id }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("forbids project creation for restricted or read-only credentials", async () => {
    const user = await makeUser("User", "sc4");
    const project = await makeProject("P");
    await addMembership(project.id, user.id, "Owner");

    const restrictedWriter = callerWithSecurity(user, {
      ...createSessionSecurityContext({
        userId: user.id,
        globalRole: "User",
        sessionId: "s",
      }),
      allowedProjectIds: new Set([project.id]),
    });
    await expect(
      restrictedWriter.project.create({ name: "Nope" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const readOnly = callerWithSecurity(
      user,
      createApiKeySecurityContext({
        userId: user.id,
        globalRole: "User",
        keyId: "key-4",
        permissions: null,
        projectIds: [],
      }),
    );
    await expect(
      readOnly.project.create({ name: "Nope" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("wiki agent principal", () => {
  beforeEach(async () => {
    await resetDb();
  });

  async function setup() {
    const db = getPrisma();
    const home = await makeProject("Home");
    const other = await makeProject("Other");
    const agent = await createWikiAgent(db, home.id);
    const context = createWikiAgentSecurityContext({
      agentId: agent.id,
      projectId: home.id,
    });
    return { db, home, other, agent, context };
  }

  it("is a synthetic Editor of its own project with no membership and NOT_FOUND elsewhere", async () => {
    const { db, home, other, context } = await setup();
    await expect(
      resolveProjectAccess(db, home.id, context),
    ).resolves.toMatchObject({
      project: { id: home.id },
      membership: null,
      effectiveRole: "Editor",
    });
    await expect(
      assertProjectRole(db, home.id, context, "Editor"),
    ).resolves.toMatchObject({ effectiveRole: "Editor" });
    await expect(
      assertProjectRole(db, home.id, context, "Maintainer"),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      resolveProjectAccess(db, other.id, context),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("cannot borrow another project's agent id", async () => {
    const { db, other, agent } = await setup();
    await expect(
      resolveProjectAccess(
        db,
        other.id,
        createWikiAgentSecurityContext({
          agentId: agent.id,
          projectId: other.id,
        }),
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("loses access when revoked or when the project is deleted, and keeps the revoked row", async () => {
    const { db, home, agent, context } = await setup();
    await revokeWikiAgent(db, { projectId: home.id });
    await expect(
      resolveProjectAccess(db, home.id, context),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(listProjectsForUser(db, context)).resolves.toEqual([]);
    await expect(getLiveWikiAgent(db, home.id)).resolves.toBeNull();
    await expect(
      db.wikiAgent.findUnique({ where: { id: agent.id } }),
    ).resolves.toMatchObject({ projectId: home.id });

    const fresh = await createWikiAgent(db, home.id);
    expect(fresh.id).not.toBe(agent.id);
    const again = createWikiAgentSecurityContext({
      agentId: fresh.id,
      projectId: home.id,
    });
    await expect(
      resolveProjectAccess(db, home.id, again),
    ).resolves.toMatchObject({ effectiveRole: "Editor" });
    await db.project.update({
      where: { id: home.id },
      data: { deletedAt: new Date() },
    });
    await expect(
      resolveProjectAccess(db, home.id, again),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("has one live agent per project and reuses it", async () => {
    const { db, home, agent } = await setup();
    await expect(createWikiAgent(db, home.id)).resolves.toMatchObject({
      id: agent.id,
    });
    await expect(
      db.wikiAgent.create({
        data: { id: randomUUID(), projectId: home.id },
      }),
    ).rejects.toThrow();
  });

  it("lists only its own project and scopes to it", async () => {
    const { db, home, other, context } = await setup();
    const listed = await listProjectsForUser(db, context);
    expect(listed.map((p) => p.id)).toEqual([home.id]);
    expect(listed[0]).toMatchObject({ myRole: "Editor" });

    const all = await resolveScopeSnapshot(db, context, { kind: "all" });
    expect(all.projectIds).toEqual([home.id]);
    await expect(
      resolveScopeSnapshot(db, context, {
        kind: "projects",
        projectIds: [other.id],
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      resolveScopeSnapshot(db, context, {
        kind: "project",
        projectId: other.id,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const widened = await effectiveScope(db, context, {
      ...all,
      kind: "projects",
      projectIds: [home.id, other.id],
    });
    expect(widened.projectIds).toEqual([home.id]);
  });

  it("is refused by all four task deny-lists", async () => {
    const { db, home, context } = await setup();
    await expect(assertTrainer(db, home.id, context)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(trainerProjectIds(db, context, [home.id])).resolves.toEqual(
      [],
    );
    expect(() => assertConnectionManager(context)).toThrowError(
      expect.objectContaining({ code: "FORBIDDEN" }),
    );
    await expect(
      listAvailableExternalTools(
        { db, now: () => new Date() } as Parameters<
          typeof listAvailableExternalTools
        >[0],
        context,
        {
          scope: {
            kind: "project",
            projectIds: [home.id],
            documentId: null,
            tableId: null,
            resolvedAt: new Date().toISOString(),
            truncated: false,
          },
        },
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("does not compile against a user-only service", async () => {
    const { db, home, context } = await setup();
    // @ts-expect-error user-only services reject a wiki agent principal.
    const refused = () => getProjectForActor(db, home.id, context);
    expect(typeof refused).toBe("function");
    const leaky = defineSharedReadTool<void, string>({
      name: "x",
      description: "x",
      kind: "read",
      capability: "content:read",
      inputSchema: {} as never,
      // @ts-expect-error a shared read tool must not read a user id.
      execute: async (_input, ctx) => ({ output: ctx.actor.userId }),
    });
    expect(leaky.name).toBe("x");
  });

  it("reaches the seven shared read tools in its project and is refused in a second one", async () => {
    const { db, home, other, context } = await setup();
    const ctx = {
      db,
      actor: context,
      scope: await resolveScopeSnapshot(db, context, {
        kind: "project",
        projectId: home.id,
      }),
      profile: { name: "Wiki agent", email: "x@weaver.invalid" },
      run: null,
    };
    const owner = await makeUser("User", "sc-agent");
    await addMembership(other.id, owner.id, "Owner");
    const created = await callerFor(owner).document.create({
      projectId: other.id,
      folderPath: [],
      title: "Elsewhere",
      contentJson: {
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "secret" }] },
        ],
      },
    });
    await expect(
      listDocumentsTool.execute(
        { projectId: home.id, page: 1, pageSize: 5 } as never,
        ctx,
      ),
    ).resolves.toMatchObject({ output: { documents: [] } });
    // A forged scope still stops at the service's access check.
    const forged = {
      ...ctx,
      scope: { ...ctx.scope, projectIds: [home.id, other.id] },
    };
    const refusals: Array<[string, () => Promise<unknown>]> = [
      [
        "list_documents",
        () =>
          listDocumentsTool.execute(
            { projectId: other.id, page: 1, pageSize: 5 } as never,
            forged,
          ),
      ],
      [
        "read_document",
        () =>
          readDocumentTool.execute(
            { projectId: other.id, documentId: created.id, offset: 0 } as never,
            forged,
          ),
      ],
      [
        "navigate_document",
        () =>
          navigateDocumentTool.execute(
            {
              projectId: other.id,
              documentId: created.id,
              mode: "outline",
            } as never,
            forged,
          ),
      ],
      [
        "list_content_folders",
        () => listContentFoldersTool.execute({ projectId: other.id }, forged),
      ],
    ];
    for (const [name, call] of refusals)
      await expect(call(), name).rejects.toMatchObject({ code: "NOT_FOUND" });
    // Project-spanning reads filter to the accessible set instead of refusing.
    await expect(
      searchEntitiesTool.execute(
        { query: "secret", projectIds: [other.id] } as never,
        forged,
      ),
    ).resolves.toMatchObject({ output: { entities: [] } });
    await expect(
      searchKnowledgeTool.execute(
        { query: "secret", projectIds: [other.id] } as never,
        forged,
      ),
    ).resolves.toMatchObject({ output: { documents: [], entities: [] } });
    await expect(
      listDocumentsTool.execute(
        { projectId: other.id, page: 1, pageSize: 5 } as never,
        ctx,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      entityDetailTool.execute({ entityId: randomUUID() }, ctx),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
