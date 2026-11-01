import { Prisma } from "@weaver/db/client";

import { isSupportedKnowledgeDimensions } from "./dimensions";
import { embeddingVectorKind } from "./generationEmbedding";

/** The only place a size enters SQL text; the integer check keeps the raw fragment safe. */
export function embeddingVectorType(dimensions: number): Prisma.Sql {
  if (!isSupportedKnowledgeDimensions(dimensions)) {
    throw new Error("Unsupported knowledge embedding dimensions");
  }
  return Prisma.raw(`${embeddingVectorKind(dimensions)}(${dimensions})`);
}
