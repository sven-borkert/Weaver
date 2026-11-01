import { z } from "zod";

// Shared with the graph URL state and API filters so every extracted type can
// be selected as a filter; counted in UTF-16 units, as zod does.
export const MAX_KNOWLEDGE_TYPE_CHARACTERS = 200;

const localKeySchema = z.string().min(1).max(200);
const textSchema = z.string().min(1).max(200);
const typeSchema = z.string().min(1).max(MAX_KNOWLEDGE_TYPE_CHARACTERS);
const timestampSchema = z.iso.datetime({ offset: true }).nullable();

const entitySchema = z.strictObject({
  key: localKeySchema,
  name: textSchema,
  type: typeSchema,
  aliases: z.array(textSchema).max(20),
  description: z.string().max(4_000).nullable(),
  mentionText: z.string().min(1).max(4_000),
  confidence: z.number().min(0).max(1),
});

const relationSchema = z.strictObject({
  sourceKey: localKeySchema,
  targetKey: localKeySchema,
  type: typeSchema,
  description: z.string().max(4_000).nullable(),
  confidence: z.number().min(0).max(1),
  validFrom: timestampSchema,
  validTo: timestampSchema,
});

export const extractionResponseSchema = z
  .strictObject({
    entities: z.array(entitySchema).max(50),
    relations: z.array(relationSchema).max(100),
  })
  .superRefine((response, context) => {
    const entityKeys = new Set<string>();

    for (const [index, entity] of response.entities.entries()) {
      if (entityKeys.has(entity.key)) {
        context.addIssue({
          code: "custom",
          path: ["entities", index, "key"],
          message: "Entity keys must be unique",
        });
      }
      entityKeys.add(entity.key);
    }

    for (const [index, relation] of response.relations.entries()) {
      if (!entityKeys.has(relation.sourceKey)) {
        context.addIssue({
          code: "custom",
          path: ["relations", index, "sourceKey"],
          message: "Relation sourceKey must reference an entity key",
        });
      }
      if (!entityKeys.has(relation.targetKey)) {
        context.addIssue({
          code: "custom",
          path: ["relations", index, "targetKey"],
          message: "Relation targetKey must reference an entity key",
        });
      }
    }
  });

export type ExtractionResponse = z.infer<typeof extractionResponseSchema>;

export const MAX_EXTRACTION_ISSUE_SUMMARIES = 20;

/** "path: code message" per issue; zod messages describe expectations, never the rejected value. */
export function describeExtractionIssues(
  issues: readonly z.core.$ZodIssue[],
): string[] {
  return issues.slice(0, MAX_EXTRACTION_ISSUE_SUMMARIES).map((issue) => {
    const path = issue.path.length ? issue.path.join(".") : "$";
    const message = issue.message.replace(/\s+/g, " ").trim().slice(0, 160);
    return `${path}: ${issue.code}${message ? ` ${message}` : ""}`;
  });
}

/** Same "path: code message" form, for relations whose validTo precedes validFrom. */
export function describeTemporalIssues(
  extraction: ExtractionResponse,
): string[] {
  const issues: string[] = [];
  for (const [index, relation] of extraction.relations.entries()) {
    if (
      relation.validFrom &&
      relation.validTo &&
      new Date(relation.validTo).getTime() <
        new Date(relation.validFrom).getTime()
    ) {
      issues.push(
        `relations.${index}.validTo: custom validTo precedes validFrom`,
      );
    }
  }
  return issues;
}

export function normalizeKnowledgeName(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

export function normalizeRelationType(value: string): string {
  return normalizeKnowledgeName(value).replace(/\s+/g, "_");
}
