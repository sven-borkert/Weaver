import { randomUUID } from "node:crypto";

import { beforeEach, describe, expect, it } from "vitest";

import { createOAuthSecurityContext } from "@weaver/core/security/context";
import type { Prisma, PrismaClient } from "@weaver/db/client";
import {
  getGraphEntityDetail,
  getGraphNeighborhood,
  getGraphRelationDetail,
  graphFromDocument,
  searchGraphEntities,
} from "@weaver/core/services/graph";
import {
  addMembership,
  callerFor,
  getPrisma,
  makeProject,
  makeUser,
  resetDb,
  securityContextFor,
} from "./_harness";

beforeEach(async () => {
  await resetDb();
});

describe("bounded relational knowledge graph", () => {
  it("searches only active entities in selected accessible projects", async () => {
    const fixture = await setupGraphFixture("search");

    const result = await searchGraphEntities(
      fixture.db,
      {
        query: "Atlas",
        projectIds: [
          fixture.firstProject.id,
          fixture.secondProject.id,
          fixture.inaccessibleProject.id,
        ],
        entityTypes: ["Product"],
        limit: 20,
      },
      securityContextFor(fixture.viewer),
    );

    expect(result).toEqual({
      entities: [
        expect.objectContaining({
          entityId: fixture.focus.id,
          projectId: fixture.firstProject.id,
          canonicalName: "Atlas Core",
          aliases: ["Atlas"],
          entityType: "Product",
        }),
        expect.objectContaining({
          entityId: fixture.secondProjectEntity.id,
          projectId: fixture.secondProject.id,
          canonicalName: "Atlas Field Guide",
          aliases: [],
          entityType: "Product",
        }),
      ],
      truncated: false,
    });
    expect(JSON.stringify(result)).not.toContain("FORBIDDEN-GRAPH");
    expect(JSON.stringify(result)).not.toContain("BUILDING-GRAPH");
    expect(JSON.stringify(result)).not.toContain(fixture.focus.normalizedName);
    expect(
      result.entities.every(
        (entity) =>
          !("normalizedName" in entity) && !("generationId" in entity),
      ),
    ).toBe(true);
  });

  it("never returns aliases whose stored project differs from their entity", async () => {
    const fixture = await setupGraphFixture("alias-project");
    await fixture.db.graphEntityAlias.create({
      data: {
        projectId: fixture.inaccessibleProject.id,
        entityId: fixture.focus.id,
        alias: "FORBIDDEN-ALIAS",
        normalizedAlias: "forbidden-alias",
      },
    });

    const search = await searchGraphEntities(
      fixture.db,
      { query: "FORBIDDEN-ALIAS" },
      securityContextFor(fixture.viewer),
    );
    const fromDocument = await graphFromDocument(
      fixture.db,
      {
        projectId: fixture.firstProject.id,
        documentId: fixture.liveDocument.id,
      },
      securityContextFor(fixture.viewer),
    );
    const neighborhood = await getGraphNeighborhood(
      fixture.db,
      { entityId: fixture.focus.id },
      securityContextFor(fixture.viewer),
    );
    const entityDetail = await getGraphEntityDetail(
      fixture.db,
      { entityId: fixture.focus.id },
      securityContextFor(fixture.viewer),
    );
    const relationDetail = await getGraphRelationDetail(
      fixture.db,
      { relationId: fixture.highRelation.id },
      securityContextFor(fixture.viewer),
    );

    expect(search.entities).toEqual([]);
    expect(
      JSON.stringify({
        fromDocument,
        neighborhood,
        entityDetail,
        relationDetail,
      }),
    ).not.toContain("FORBIDDEN-ALIAS");
  });

  it("returns active document seeds and hides inaccessible documents", async () => {
    const fixture = await setupGraphFixture("document");

    await expect(
      graphFromDocument(
        fixture.db,
        {
          projectId: fixture.firstProject.id,
          documentId: fixture.liveDocument.id,
          limit: 20,
        },
        securityContextFor(fixture.viewer),
      ),
    ).resolves.toEqual({
      entities: [
        expect.objectContaining({ entityId: fixture.focus.id }),
        expect.objectContaining({ entityId: fixture.organization.id }),
      ],
      truncated: false,
    });

    await expect(
      graphFromDocument(
        fixture.db,
        {
          projectId: fixture.inaccessibleProject.id,
          documentId: fixture.inaccessibleDocument.id,
        },
        securityContextFor(fixture.viewer),
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    await expect(
      graphFromDocument(
        fixture.db,
        {
          projectId: fixture.firstProject.id,
          documentId: fixture.inaccessibleDocument.id,
        },
        securityContextFor(fixture.viewer),
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    await expect(
      graphFromDocument(
        fixture.db,
        {
          projectId: fixture.firstProject.id,
          documentId: fixture.liveDocument.id,
        },
        createOAuthSecurityContext({
          userId: fixture.viewer.id,
          globalRole: "User",
          tokenId: "mcp-only",
          scopes: ["mcp:use"],
        }),
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("loads a bounded one-hop neighborhood in evidence-confidence order", async () => {
    const fixture = await setupGraphFixture("neighborhood");

    const result = await getGraphNeighborhood(
      fixture.db,
      {
        entityId: fixture.focus.id,
        maxNodes: 100,
        maxEdges: 200,
      },
      securityContextFor(fixture.viewer),
    );

    expect(result.nodes.map((node) => node.entityId)).toEqual([
      fixture.focus.id,
      fixture.organization.id,
      fixture.place.id,
      fixture.concept.id,
    ]);
    expect(result.edges.map((edge) => edge.relationId)).toEqual([
      fixture.highRelation.id,
      fixture.tieFirstRelation.id,
      fixture.tieSecondRelation.id,
    ]);
    expect(result.edges.map((edge) => edge.maxConfidence)).toEqual([
      0.95, 0.8, 0.8,
    ]);
    expect(result.truncated).toBe(false);
    expect(JSON.stringify(result)).not.toContain("STALE-EVIDENCE");
    expect(JSON.stringify(result)).not.toContain("BUILDING-GRAPH");
  });

  it("applies entity and relation filters and reports node and edge truncation accurately", async () => {
    const fixture = await setupGraphFixture("caps");

    await expect(
      getGraphNeighborhood(
        fixture.db,
        {
          entityId: fixture.focus.id,
          entityTypes: ["Organization"],
          relationTypes: ["Uses Product"],
          maxNodes: 100,
          maxEdges: 200,
        },
        securityContextFor(fixture.viewer),
      ),
    ).resolves.toEqual({
      nodes: [
        expect.objectContaining({ entityId: fixture.focus.id }),
        expect.objectContaining({ entityId: fixture.organization.id }),
      ],
      edges: [expect.objectContaining({ relationId: fixture.highRelation.id })],
      truncated: false,
    });

    const nodeLimited = await getGraphNeighborhood(
      fixture.db,
      {
        entityId: fixture.focus.id,
        maxNodes: 2,
        maxEdges: 200,
      },
      securityContextFor(fixture.viewer),
    );
    expect(nodeLimited.nodes).toHaveLength(2);
    expect(nodeLimited.edges).toHaveLength(1);
    expect(nodeLimited.truncated).toBe(true);

    const edgeLimited = await getGraphNeighborhood(
      fixture.db,
      {
        entityId: fixture.focus.id,
        maxNodes: 100,
        maxEdges: 1,
      },
      securityContextFor(fixture.viewer),
    );
    expect(edgeLimited.nodes).toHaveLength(2);
    expect(edgeLimited.edges).toHaveLength(1);
    expect(edgeLimited.truncated).toBe(true);
  });

  it("keeps later ordered edges to nodes admitted before the node cap", async () => {
    const fixture = await setupGraphFixture("later-admitted-edge");
    const laterRelation = await createRelation(
      fixture.db,
      fixture.firstProject,
      {
        id: "00000000-0000-4000-8000-000000000204",
        sourceEntityId: fixture.focus.id,
        targetEntityId: fixture.organization.id,
        relationType: "Operates With",
        confidence: 0.7,
        documentId: fixture.liveDocument.id,
        sourceChunkId: fixture.liveChunk.id,
        sourceCommitSha: fixture.liveDocument.headCommitSha,
        evidenceText: "Atlas operates with Acme.",
      },
    );

    const result = await getGraphNeighborhood(
      fixture.db,
      {
        entityId: fixture.focus.id,
        maxNodes: 2,
        maxEdges: 2,
      },
      securityContextFor(fixture.viewer),
    );

    expect(result.nodes.map((node) => node.entityId)).toEqual([
      fixture.focus.id,
      fixture.organization.id,
    ]);
    expect(result.edges.map((edge) => edge.relationId)).toEqual([
      fixture.highRelation.id,
      laterRelation.id,
    ]);
    expect(result.truncated).toBe(true);
  });

  it("does not charge a self-relation against the opposite-node cap", async () => {
    const fixture = await setupGraphFixture("self-relation");
    const selfRelation = await createRelation(
      fixture.db,
      fixture.firstProject,
      {
        id: "00000000-0000-4000-8000-000000000200",
        sourceEntityId: fixture.focus.id,
        targetEntityId: fixture.focus.id,
        relationType: "References Self",
        confidence: 1,
        documentId: fixture.liveDocument.id,
        sourceChunkId: fixture.liveChunk.id,
        sourceCommitSha: fixture.liveDocument.headCommitSha,
        evidenceText: "Atlas references itself.",
      },
    );

    const result = await getGraphNeighborhood(
      fixture.db,
      {
        entityId: fixture.focus.id,
        relationTypes: ["References Self"],
        maxNodes: 1,
        maxEdges: 2,
      },
      securityContextFor(fixture.viewer),
    );

    expect(result.nodes.map((node) => node.entityId)).toEqual([
      fixture.focus.id,
    ]);
    expect(result.edges.map((edge) => edge.relationId)).toEqual([
      selfRelation.id,
    ]);
    expect(result.truncated).toBe(false);
  });

  it("hides a neighborhood when its focus disappears before node publication", async () => {
    const fixture = await setupGraphFixture("generation-race");
    const racing = archiveBeforeGraphEntityFindMany(
      fixture.db,
      fixture.activeGeneration.id,
    );

    await expect(
      getGraphNeighborhood(
        racing.db,
        {
          entityId: fixture.focus.id,
          maxNodes: 100,
          maxEdges: 200,
        },
        securityContextFor(fixture.viewer),
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(racing.wasIntercepted()).toBe(true);
  });

  it("hides a neighborhood when its generation is archived before edge selection", async () => {
    const fixture = await setupGraphFixture("edge-query-race");
    const racing = archiveBeforeNeighborhoodEdgeQuery(
      fixture.db,
      fixture.activeGeneration.id,
    );

    await expect(
      getGraphNeighborhood(
        racing.db,
        {
          entityId: fixture.focus.id,
          maxNodes: 100,
          maxEdges: 200,
        },
        securityContextFor(fixture.viewer),
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(racing.wasIntercepted()).toBe(true);
  });

  it("returns active entity mentions with live same-project citation targets", async () => {
    const fixture = await setupGraphFixture("entity-detail");

    const result = await getGraphEntityDetail(
      fixture.db,
      { entityId: fixture.focus.id },
      securityContextFor(fixture.viewer),
    );

    expect(result.entity).toEqual(
      expect.objectContaining({
        entityId: fixture.focus.id,
        canonicalName: "Atlas Core",
        aliases: ["Atlas"],
      }),
    );
    expect(result.mentions).toHaveLength(3);
    expect(result.mentions[0]).toMatchObject({
      excerpt: "Atlas is used by Acme.",
      headingPath: ["Operations", "Atlas"],
      navigation: {
        documentId: fixture.liveDocument.id,
        title: "Atlas Operations",
        slug: "atlas-operations",
        path: "atlas-operations.md",
        navigationAnchor: "section-deployment",
      },
    });
    expect(result.mentions[1]).toMatchObject({
      excerpt: "Atlas remains known after its source was deleted.",
      headingPath: [],
      navigation: null,
    });
    expect(result.mentions[2]).toMatchObject({
      excerpt: "Atlas evidence with a cross-project document identifier.",
      navigation: null,
    });
    expect(result.truncated).toBe(false);
    expect(JSON.stringify(result)).not.toContain("STALE-MENTION");
    expect(JSON.stringify(result)).not.toContain(fixture.focus.normalizedName);
  });

  it("returns relation detail only while active evidence exists", async () => {
    const fixture = await setupGraphFixture("relation-detail");

    const result = await getGraphRelationDetail(
      fixture.db,
      { relationId: fixture.highRelation.id },
      securityContextFor(fixture.viewer),
    );

    expect(result.relation).toMatchObject({
      relationId: fixture.highRelation.id,
      projectId: fixture.firstProject.id,
      projectName: fixture.firstProject.name,
      relationType: "Uses Product",
    });
    expect(result.relation.source.entityId).toBe(fixture.focus.id);
    expect(result.relation.target.entityId).toBe(fixture.organization.id);
    expect(result.evidence).toHaveLength(3);
    expect(result.evidence[0]).toMatchObject({
      excerpt: "Atlas Core uses Acme systems.",
      headingPath: ["Operations", "Atlas"],
      confidence: 0.95,
    });
    expect(result.evidence[0]!.navigation?.documentId).toBe(
      fixture.liveDocument.id,
    );
    expect(result.evidence[0]?.navigation).toMatchObject({
      documentId: fixture.liveDocument.id,
      navigationAnchor: "section-deployment",
    });
    expect(result.evidence[1]).toMatchObject({
      excerpt: "Deleted supporting document.",
      navigation: null,
    });
    expect(result.evidence[2]).toMatchObject({
      excerpt: "Cross-project supporting document.",
      navigation: null,
    });
    expect(result.truncated).toBe(false);
    expect(JSON.stringify(result)).not.toContain("STALE-EVIDENCE");

    await expect(
      getGraphRelationDetail(
        fixture.db,
        { relationId: fixture.staleRelation.id },
        securityContextFor(fixture.viewer),
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("hides direct inactive and inaccessible graph identifiers", async () => {
    const fixture = await setupGraphFixture("hidden-ids");

    for (const entityId of [
      fixture.inaccessibleEntity.id,
      fixture.buildingEntity.id,
    ]) {
      await expect(
        getGraphEntityDetail(
          fixture.db,
          { entityId },
          securityContextFor(fixture.viewer),
        ),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(
        getGraphNeighborhood(
          fixture.db,
          { entityId },
          securityContextFor(fixture.viewer),
        ),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    }

    for (const relationId of [
      fixture.inaccessibleRelation.id,
      fixture.buildingRelation.id,
    ]) {
      await expect(
        getGraphRelationDetail(
          fixture.db,
          { relationId },
          securityContextFor(fixture.viewer),
        ),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
  });

  it("registers bounded authenticated graph procedures", async () => {
    const fixture = await setupGraphFixture("router");
    const caller = callerFor(fixture.viewer);

    const search = await caller.graph.searchEntities({ query: " Atlas " });
    expect(
      search.entities.some((entity) => entity.entityId === fixture.focus.id),
    ).toBe(true);
    const fromDocument = await caller.graph.fromDocument({
      projectId: fixture.firstProject.id,
      documentId: fixture.liveDocument.id,
    });
    expect(fromDocument.entities.length).toBeGreaterThan(0);
    const neighborhood = await caller.graph.neighborhood({
      entityId: fixture.focus.id,
    });
    expect(neighborhood.nodes.length).toBeGreaterThan(0);
    await expect(
      caller.graph.entityDetail({ entityId: fixture.focus.id }),
    ).resolves.toMatchObject({ entity: { entityId: fixture.focus.id } });
    await expect(
      caller.graph.relationDetail({ relationId: fixture.highRelation.id }),
    ).resolves.toMatchObject({
      relation: { relationId: fixture.highRelation.id },
    });

    await expect(
      caller.graph.searchEntities({ query: "x" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      caller.graph.searchEntities({ query: "x".repeat(201) }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      caller.graph.searchEntities({
        query: "valid",
        projectIds: Array.from({ length: 51 }, () => randomUUID()),
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      caller.graph.searchEntities({
        query: "valid",
        entityTypes: Array.from({ length: 21 }, (_, index) => `T${index}`),
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      caller.graph.neighborhood({
        entityId: fixture.focus.id,
        relationTypes: ["x".repeat(201)],
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      caller.graph.neighborhood({
        entityId: fixture.focus.id,
        maxNodes: 101,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      caller.graph.neighborhood({
        entityId: fixture.focus.id,
        maxEdges: 201,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      caller.graph.fromDocument({
        projectId: fixture.firstProject.id,
        documentId: fixture.liveDocument.id,
        limit: 21,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("caps detail records at fifty and reports additional active records", async () => {
    const fixture = await setupGraphFixture("detail-cap");
    await fixture.db.entityMention.createMany({
      data: Array.from({ length: 49 }, (_, index) => ({
        projectId: fixture.firstProject.id,
        generationId: fixture.activeGeneration.id,
        entityId: fixture.focus.id,
        documentId: randomUUID(),
        sourceChunkId: `extra-mention-${index}`,
        sourceCommitSha: "9".repeat(40),
        mentionText: `Extra mention ${index}`,
        confidence: 0.5,
      })),
    });
    await fixture.db.relationEvidence.createMany({
      data: Array.from({ length: 49 }, (_, index) => ({
        projectId: fixture.firstProject.id,
        generationId: fixture.activeGeneration.id,
        relationId: fixture.highRelation.id,
        documentId: randomUUID(),
        sourceChunkId: `extra-evidence-${index}`,
        sourceCommitSha: "8".repeat(40),
        evidenceText: `Extra evidence ${index}`,
        confidence: 0.5,
      })),
    });

    const entity = await getGraphEntityDetail(
      fixture.db,
      { entityId: fixture.focus.id },
      securityContextFor(fixture.viewer),
    );
    expect(entity.mentions).toHaveLength(50);
    expect(entity.truncated).toBe(true);

    const relation = await getGraphRelationDetail(
      fixture.db,
      { relationId: fixture.highRelation.id },
      securityContextFor(fixture.viewer),
    );
    expect(relation.evidence).toHaveLength(50);
    expect(relation.truncated).toBe(true);
  });

  it("does not let a non-member Admin inspect graph data", async () => {
    const fixture = await setupGraphFixture("admin");
    const admin = await makeUser("Admin", "graph-admin");

    await expect(
      getGraphEntityDetail(
        fixture.db,
        { entityId: fixture.inaccessibleEntity.id },
        securityContextFor(admin),
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

async function setupGraphFixture(suffix: string) {
  const db = getPrisma();
  const viewer = await makeUser("User", `graph-${suffix}`);
  const firstProject = await createProjectWithGeneration(
    db,
    `Graph Alpha ${suffix}`,
  );
  const secondProject = await createProjectWithGeneration(
    db,
    `Graph Beta ${suffix}`,
  );
  const inaccessibleProject = await createProjectWithGeneration(
    db,
    `Graph Forbidden ${suffix}`,
  );
  await addMembership(firstProject.id, viewer.id, "Viewer");
  await addMembership(secondProject.id, viewer.id, "Viewer");

  const activeGeneration = firstProject.activeGeneration;
  const focus = await createEntity(db, firstProject, {
    id: "00000000-0000-4000-8000-000000000101",
    canonicalName: "Atlas Core",
    normalizedName: `atlas core::${suffix}`,
    entityType: "Product",
    description: "Operations platform",
    aliases: ["Atlas"],
  });
  const organization = await createEntity(db, firstProject, {
    id: "00000000-0000-4000-8000-000000000102",
    canonicalName: "Acme GmbH",
    entityType: "Organization",
    description: "A manufacturing company",
  });
  const place = await createEntity(db, firstProject, {
    id: "00000000-0000-4000-8000-000000000103",
    canonicalName: "Berlin",
    entityType: "Place",
    description: "A city",
  });
  const concept = await createEntity(db, firstProject, {
    id: "00000000-0000-4000-8000-000000000104",
    canonicalName: "Resilience",
    entityType: "Concept",
    description: "Operational resilience",
  });
  const secondProjectEntity = await createEntity(db, secondProject, {
    canonicalName: "Atlas Field Guide",
    entityType: "Product",
    description: "A field guide",
  });
  const inaccessibleEntity = await createEntity(db, inaccessibleProject, {
    canonicalName: "FORBIDDEN-GRAPH Atlas",
    entityType: "Product",
    description: "FORBIDDEN-GRAPH hidden description",
    aliases: ["Atlas"],
  });

  const buildingGeneration = await db.knowledgeGeneration.create({
    data: generationData(firstProject.id, "building", `building-${suffix}`),
  });
  const buildingProject = {
    ...firstProject,
    activeGeneration: buildingGeneration,
  };
  const buildingEntity = await createEntity(db, buildingProject, {
    canonicalName: "BUILDING-GRAPH Atlas",
    entityType: "Product",
    description: "BUILDING-GRAPH shadow data",
    aliases: ["Atlas"],
  });
  const buildingTarget = await createEntity(db, buildingProject, {
    canonicalName: "BUILDING-GRAPH Target",
    entityType: "Concept",
    description: "BUILDING-GRAPH shadow target",
  });

  const liveDocument = await createDocument(db, firstProject.id, {
    title: "Atlas Operations",
    slug: "atlas-operations",
  });
  const secondProjectDocument = await createDocument(db, secondProject.id, {
    title: "Other Atlas",
    slug: "other-atlas",
  });
  const inaccessibleDocument = await createDocument(
    db,
    inaccessibleProject.id,
    { title: "Forbidden Graph", slug: "forbidden-graph" },
  );
  const liveChunk = await db.documentSearchChunk.create({
    data: {
      id: `${randomUUID().replaceAll("-", "")}${randomUUID().replaceAll("-", "")}`,
      projectId: firstProject.id,
      documentId: liveDocument.id,
      ordinal: 0,
      sourceCommitSha: liveDocument.headCommitSha,
      contentHash: "a".repeat(64),
      headingPath: ["Operations", "Atlas"],
      navigationAnchor: "section-deployment",
      content: "Atlas is used by Acme.",
    },
  });

  const deletedDocument = await createDocument(db, firstProject.id, {
    title: "Deleted Source",
    slug: "deleted-source",
  });
  await db.document.delete({ where: { id: deletedDocument.id } });

  await db.entityMention.createMany({
    data: [
      {
        projectId: firstProject.id,
        generationId: activeGeneration.id,
        entityId: focus.id,
        documentId: liveDocument.id,
        sourceChunkId: liveChunk.id,
        sourceCommitSha: liveDocument.headCommitSha,
        mentionText: "Atlas is used by Acme.",
        confidence: 0.98,
      },
      {
        projectId: firstProject.id,
        generationId: activeGeneration.id,
        entityId: organization.id,
        documentId: liveDocument.id,
        sourceChunkId: liveChunk.id,
        sourceCommitSha: liveDocument.headCommitSha,
        mentionText: "Acme operates Atlas.",
        confidence: 0.9,
      },
      {
        projectId: firstProject.id,
        generationId: activeGeneration.id,
        entityId: focus.id,
        documentId: deletedDocument.id,
        sourceChunkId: "deleted-source-chunk",
        sourceCommitSha: deletedDocument.headCommitSha,
        mentionText: "Atlas remains known after its source was deleted.",
        confidence: 0.8,
      },
      {
        projectId: firstProject.id,
        generationId: activeGeneration.id,
        entityId: focus.id,
        documentId: secondProjectDocument.id,
        sourceChunkId: "cross-project-chunk",
        sourceCommitSha: secondProjectDocument.headCommitSha,
        mentionText: "Atlas evidence with a cross-project document identifier.",
        confidence: 0.7,
      },
      {
        projectId: firstProject.id,
        generationId: activeGeneration.id,
        entityId: focus.id,
        documentId: liveDocument.id,
        sourceChunkId: liveChunk.id,
        sourceCommitSha: liveDocument.headCommitSha,
        mentionText: "STALE-MENTION",
        confidence: 1,
        invalidatedAt: new Date(),
      },
      {
        projectId: firstProject.id,
        generationId: buildingGeneration.id,
        entityId: buildingEntity.id,
        documentId: liveDocument.id,
        sourceChunkId: liveChunk.id,
        sourceCommitSha: liveDocument.headCommitSha,
        mentionText: "BUILDING-GRAPH mention",
        confidence: 1,
      },
      {
        projectId: secondProject.id,
        generationId: secondProject.activeGeneration.id,
        entityId: secondProjectEntity.id,
        documentId: secondProjectDocument.id,
        sourceChunkId: "second-project-chunk",
        sourceCommitSha: secondProjectDocument.headCommitSha,
        mentionText: "Atlas Field Guide",
        confidence: 0.9,
      },
      {
        projectId: inaccessibleProject.id,
        generationId: inaccessibleProject.activeGeneration.id,
        entityId: inaccessibleEntity.id,
        documentId: inaccessibleDocument.id,
        sourceChunkId: "inaccessible-chunk",
        sourceCommitSha: inaccessibleDocument.headCommitSha,
        mentionText: "FORBIDDEN-GRAPH mention",
        confidence: 1,
      },
    ],
  });

  const highRelation = await createRelation(db, firstProject, {
    id: "00000000-0000-4000-8000-000000000201",
    sourceEntityId: focus.id,
    targetEntityId: organization.id,
    relationType: "Uses Product",
    confidence: 0.95,
    documentId: liveDocument.id,
    sourceChunkId: liveChunk.id,
    sourceCommitSha: liveDocument.headCommitSha,
    evidenceText: "Atlas Core uses Acme systems.",
  });
  await db.relationEvidence.createMany({
    data: [
      {
        projectId: firstProject.id,
        generationId: activeGeneration.id,
        relationId: highRelation.id,
        documentId: deletedDocument.id,
        sourceChunkId: "deleted-evidence-chunk",
        sourceCommitSha: deletedDocument.headCommitSha,
        evidenceText: "Deleted supporting document.",
        confidence: 0.7,
      },
      {
        projectId: firstProject.id,
        generationId: activeGeneration.id,
        relationId: highRelation.id,
        documentId: secondProjectDocument.id,
        sourceChunkId: "cross-project-evidence-chunk",
        sourceCommitSha: secondProjectDocument.headCommitSha,
        evidenceText: "Cross-project supporting document.",
        confidence: 0.6,
      },
      {
        projectId: firstProject.id,
        generationId: activeGeneration.id,
        relationId: highRelation.id,
        documentId: liveDocument.id,
        sourceChunkId: liveChunk.id,
        sourceCommitSha: liveDocument.headCommitSha,
        evidenceText: "STALE-EVIDENCE",
        confidence: 1,
        invalidatedAt: new Date(),
      },
    ],
  });
  const tieFirstRelation = await createRelation(db, firstProject, {
    id: "00000000-0000-4000-8000-000000000202",
    sourceEntityId: focus.id,
    targetEntityId: place.id,
    relationType: "Located In",
    confidence: 0.8,
    documentId: liveDocument.id,
    sourceChunkId: liveChunk.id,
    sourceCommitSha: liveDocument.headCommitSha,
    evidenceText: "Atlas is located in Berlin.",
  });
  const tieSecondRelation = await createRelation(db, firstProject, {
    id: "00000000-0000-4000-8000-000000000203",
    sourceEntityId: concept.id,
    targetEntityId: focus.id,
    relationType: "Supports",
    confidence: 0.8,
    documentId: liveDocument.id,
    sourceChunkId: liveChunk.id,
    sourceCommitSha: liveDocument.headCommitSha,
    evidenceText: "Resilience supports Atlas.",
  });
  const staleRelation = await createRelation(db, firstProject, {
    sourceEntityId: focus.id,
    targetEntityId: place.id,
    relationType: "Formerly Located In",
    confidence: 1,
    documentId: liveDocument.id,
    sourceChunkId: liveChunk.id,
    sourceCommitSha: liveDocument.headCommitSha,
    evidenceText: "STALE-EVIDENCE only",
    invalidatedAt: new Date(),
  });
  const buildingRelation = await createRelation(db, buildingProject, {
    sourceEntityId: buildingEntity.id,
    targetEntityId: buildingTarget.id,
    relationType: "BUILDING-GRAPH Relation",
    confidence: 1,
    documentId: liveDocument.id,
    sourceChunkId: liveChunk.id,
    sourceCommitSha: liveDocument.headCommitSha,
    evidenceText: "BUILDING-GRAPH evidence",
  });
  const inaccessibleTarget = await createEntity(db, inaccessibleProject, {
    canonicalName: "FORBIDDEN-GRAPH Target",
    entityType: "Concept",
    description: "FORBIDDEN-GRAPH target",
  });
  const inaccessibleRelation = await createRelation(db, inaccessibleProject, {
    sourceEntityId: inaccessibleEntity.id,
    targetEntityId: inaccessibleTarget.id,
    relationType: "FORBIDDEN-GRAPH Relation",
    confidence: 1,
    documentId: inaccessibleDocument.id,
    sourceChunkId: "inaccessible-chunk",
    sourceCommitSha: inaccessibleDocument.headCommitSha,
    evidenceText: "FORBIDDEN-GRAPH evidence",
  });

  return {
    db,
    viewer,
    firstProject,
    secondProject,
    inaccessibleProject,
    activeGeneration,
    focus,
    organization,
    place,
    concept,
    secondProjectEntity,
    inaccessibleEntity,
    buildingEntity,
    liveDocument,
    liveChunk,
    inaccessibleDocument,
    highRelation,
    tieFirstRelation,
    tieSecondRelation,
    staleRelation,
    buildingRelation,
    inaccessibleRelation,
  };
}

async function createProjectWithGeneration(db: PrismaClient, name: string) {
  const project = await makeProject(name);
  const activeGeneration = await db.knowledgeGeneration.create({
    data: generationData(project.id, "active", `active-${name}`),
  });
  return { id: project.id, name, activeGeneration };
}

function generationData(
  projectId: string,
  status: "active" | "building",
  suffix: string,
) {
  const active = status === "active";
  return {
    projectId,
    configFingerprint: `fingerprint-${suffix}`,
    embeddingModel: "graph-test-embedding",
    embeddingDimensions: 1536,
    extractionSchemaVersion: 1,
    promptVersion: "graph-test-prompt",
    status,
    completedAt: active ? new Date() : null,
    activatedAt: active ? new Date() : null,
  } as const;
}

async function createEntity(
  db: PrismaClient,
  project: {
    id: string;
    activeGeneration: { id: string };
  },
  input: {
    id?: string;
    canonicalName: string;
    normalizedName?: string;
    entityType: string;
    description: string;
    aliases?: string[];
  },
) {
  return db.graphEntity.create({
    data: {
      id: input.id,
      projectId: project.id,
      generationId: project.activeGeneration.id,
      entityType: input.entityType,
      canonicalName: input.canonicalName,
      normalizedName:
        input.normalizedName ??
        input.canonicalName.toLowerCase().replaceAll(" ", "-"),
      description: input.description,
      aliases: {
        create: (input.aliases ?? []).map((alias) => ({
          projectId: project.id,
          alias,
          normalizedAlias: alias.toLowerCase(),
        })),
      },
    },
    include: { aliases: true },
  });
}

async function createDocument(
  db: PrismaClient,
  projectId: string,
  input: { title: string; slug: string },
) {
  const now = new Date();
  return db.document.create({
    data: {
      id: randomUUID(),
      projectId,
      path: `${input.slug}.md`,
      slug: input.slug,
      title: input.title,
      excerpt: input.title,
      headCommitSha: randomUUID().replaceAll("-", "").padEnd(40, "0"),
      lastEditedAt: now,
      createdAt: now,
      updatedAt: now,
    },
  });
}

async function createRelation(
  db: PrismaClient,
  project: {
    id: string;
    activeGeneration: { id: string };
  },
  input: {
    id?: string;
    sourceEntityId: string;
    targetEntityId: string;
    relationType: string;
    confidence: number;
    documentId: string;
    sourceChunkId: string;
    sourceCommitSha: string;
    evidenceText: string;
    invalidatedAt?: Date;
  },
) {
  return db.graphRelation.create({
    data: {
      id: input.id,
      projectId: project.id,
      generationId: project.activeGeneration.id,
      sourceEntityId: input.sourceEntityId,
      targetEntityId: input.targetEntityId,
      relationType: input.relationType,
      normalizedType: input.relationType.toLowerCase().replaceAll(" ", "_"),
      evidence: {
        create: {
          projectId: project.id,
          generationId: project.activeGeneration.id,
          documentId: input.documentId,
          sourceChunkId: input.sourceChunkId,
          sourceCommitSha: input.sourceCommitSha,
          evidenceText: input.evidenceText,
          confidence: input.confidence,
          invalidatedAt: input.invalidatedAt,
        },
      },
    },
  });
}

type UnknownFindMany = (args: unknown) => Promise<unknown>;
type RawQueryRunner = <T>(query: Prisma.Sql) => Promise<T>;

function archiveBeforeGraphEntityFindMany(
  db: PrismaClient,
  generationId: string,
): { db: PrismaClient; wasIntercepted: () => boolean } {
  let intercepted = false;
  const delegate = db.graphEntity;
  const runFindMany = delegate.findMany.bind(
    delegate,
  ) as unknown as UnknownFindMany;
  const interceptedDelegate = new Proxy(delegate, {
    get(target, property, receiver) {
      if (property === "findMany") {
        return async (args: unknown) => {
          intercepted = true;
          await db.knowledgeGeneration.update({
            where: { id: generationId },
            data: { status: "superseded", supersededAt: new Date() },
          });
          return runFindMany(args);
        };
      }
      const value: unknown = Reflect.get(target, property, receiver);
      return value;
    },
  });
  const interceptedDb = new Proxy(db, {
    get(target, property, receiver) {
      if (property === "graphEntity") return interceptedDelegate;
      const value: unknown = Reflect.get(target, property, receiver);
      return value;
    },
  });
  return { db: interceptedDb, wasIntercepted: () => intercepted };
}

function archiveBeforeNeighborhoodEdgeQuery(
  db: PrismaClient,
  generationId: string,
): { db: PrismaClient; wasIntercepted: () => boolean } {
  let intercepted = false;
  const runQuery = db.$queryRaw.bind(db) as unknown as RawQueryRunner;
  const interceptedDb = new Proxy(db, {
    get(target, property, receiver) {
      if (property === "$queryRaw") {
        return async (query: Prisma.Sql) => {
          if (
            !intercepted &&
            query.sql.includes('relation."relationType" AS "relationType"')
          ) {
            intercepted = true;
            await db.knowledgeGeneration.update({
              where: { id: generationId },
              data: { status: "superseded", supersededAt: new Date() },
            });
          }
          return runQuery(query);
        };
      }
      const value: unknown = Reflect.get(target, property, receiver);
      return value;
    },
  });
  return { db: interceptedDb, wasIntercepted: () => intercepted };
}
