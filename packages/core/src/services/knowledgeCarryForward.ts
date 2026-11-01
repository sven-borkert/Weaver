import { Prisma } from "@weaver/db/client";

import { UTC_NOW } from "./sql";

export type CarryForwardInput = {
  projectId: string;
  sourceGenerationId: string;
  targetGenerationId: string;
  configFingerprint: string;
};

/** Entity resolution never reads vectors, so a new vector space can reuse the extracted graph unchanged. */
export async function carryForwardGraph(
  tx: Prisma.TransactionClient,
  input: CarryForwardInput,
): Promise<{ entities: number; relations: number; documents: number }> {
  const project = input.projectId;
  const source = input.sourceGenerationId;
  const target = input.targetGenerationId;

  await tx.$executeRaw`CREATE TEMP TABLE weaver_carry_entity (old_id uuid PRIMARY KEY, new_id uuid NOT NULL) ON COMMIT DROP`;
  await tx.$executeRaw`CREATE TEMP TABLE weaver_carry_relation (old_id uuid PRIMARY KEY, new_id uuid NOT NULL) ON COMMIT DROP`;

  const entities = await tx.$executeRaw`
    INSERT INTO weaver_carry_entity (old_id, new_id)
    SELECT "id", gen_random_uuid() FROM "GraphEntity"
    WHERE "projectId" = ${project}::uuid AND "generationId" = ${source}::uuid
  `;
  await tx.$executeRaw(Prisma.sql`
    INSERT INTO "GraphEntity"
      ("id", "projectId", "generationId", "entityType", "canonicalName",
       "normalizedName", "description", "createdAt", "updatedAt")
    SELECT map.new_id, entity."projectId", ${target}::uuid, entity."entityType",
           entity."canonicalName",
           CASE WHEN entity."normalizedName" LIKE ('%::' || entity."id"::text)
                THEN left(entity."normalizedName", length(entity."normalizedName") - 36)
                     || map.new_id::text
                ELSE entity."normalizedName" END,
           entity."description", entity."createdAt", ${UTC_NOW}
    FROM "GraphEntity" entity
    JOIN weaver_carry_entity map ON map.old_id = entity."id"
  `);
  await tx.$executeRaw`
    INSERT INTO "GraphEntityAlias"
      ("id", "projectId", "entityId", "alias", "normalizedAlias", "createdAt")
    SELECT gen_random_uuid(), alias."projectId", map.new_id, alias."alias",
           alias."normalizedAlias", alias."createdAt"
    FROM "GraphEntityAlias" alias
    JOIN weaver_carry_entity map ON map.old_id = alias."entityId"
  `;

  const relations = await tx.$executeRaw`
    INSERT INTO weaver_carry_relation (old_id, new_id)
    SELECT "id", gen_random_uuid() FROM "GraphRelation"
    WHERE "projectId" = ${project}::uuid AND "generationId" = ${source}::uuid
  `;
  await tx.$executeRaw(Prisma.sql`
    INSERT INTO "GraphRelation"
      ("id", "projectId", "generationId", "sourceEntityId", "targetEntityId",
       "relationType", "normalizedType", "createdAt", "updatedAt")
    SELECT map.new_id, relation."projectId", ${target}::uuid,
           source_map.new_id, target_map.new_id, relation."relationType",
           relation."normalizedType", relation."createdAt", ${UTC_NOW}
    FROM "GraphRelation" relation
    JOIN weaver_carry_relation map ON map.old_id = relation."id"
    JOIN weaver_carry_entity source_map ON source_map.old_id = relation."sourceEntityId"
    JOIN weaver_carry_entity target_map ON target_map.old_id = relation."targetEntityId"
  `);

  await tx.$executeRaw`
    INSERT INTO "EntityMention"
      ("id", "projectId", "generationId", "entityId", "documentId", "sourceChunkId",
       "sourceCommitSha", "mentionText", "sourceDescription", "confidence",
       "validFrom", "validTo", "recordedAt", "invalidatedAt")
    SELECT gen_random_uuid(), mention."projectId", ${target}::uuid, map.new_id,
           mention."documentId", mention."sourceChunkId", mention."sourceCommitSha",
           mention."mentionText", mention."sourceDescription", mention."confidence",
           mention."validFrom", mention."validTo", mention."recordedAt",
           mention."invalidatedAt"
    FROM "EntityMention" mention
    JOIN weaver_carry_entity map ON map.old_id = mention."entityId"
    WHERE mention."generationId" = ${source}::uuid
  `;
  await tx.$executeRaw`
    INSERT INTO "RelationEvidence"
      ("id", "projectId", "generationId", "relationId", "documentId", "sourceChunkId",
       "sourceCommitSha", "evidenceText", "confidence", "validFrom", "validTo",
       "recordedAt", "invalidatedAt")
    SELECT gen_random_uuid(), evidence."projectId", ${target}::uuid, map.new_id,
           evidence."documentId", evidence."sourceChunkId", evidence."sourceCommitSha",
           evidence."evidenceText", evidence."confidence", evidence."validFrom",
           evidence."validTo", evidence."recordedAt", evidence."invalidatedAt"
    FROM "RelationEvidence" evidence
    JOIN weaver_carry_relation map ON map.old_id = evidence."relationId"
    WHERE evidence."generationId" = ${source}::uuid
  `;

  const documents = await tx.$executeRaw(Prisma.sql`
    INSERT INTO "KnowledgeGenerationDocument"
      ("generationId", "documentId", "projectId", "targetSha", "semanticIndexedSha",
       "graphIndexedSha", "configFingerprint", "extractionFingerprint",
       "extractionModel", "status", "attempts", "createdAt", "updatedAt")
    SELECT ${target}::uuid, state."documentId", state."projectId", state."graphIndexedSha",
           NULL, state."graphIndexedSha", ${input.configFingerprint},
           state."extractionFingerprint", state."extractionModel",
           'pending'::"KnowledgeDocumentStatus", 0, ${UTC_NOW}, ${UTC_NOW}
    FROM "KnowledgeGenerationDocument" state
    JOIN "Document" document
      ON document."id" = state."documentId"
     AND document."projectId" = state."projectId"
     AND document."headCommitSha" = state."graphIndexedSha"
    WHERE state."generationId" = ${source}::uuid
      AND state."projectId" = ${project}::uuid
      AND state."status" = 'ready'
  `);

  return { entities, relations, documents };
}
