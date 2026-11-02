import { Prisma } from "@weaver/db/client";

/** Source pages are keyword-indexed only; the AI pipeline treats them as finished. */
export function isAiExempt(document: {
  wikiSourceItemId: string | null;
}): boolean {
  return document.wikiSourceItemId !== null;
}

/** The SQL form of isAiExempt; the two are tested together. */
export function aiExemptSql(documentAlias: string): Prisma.Sql {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(documentAlias))
    throw new Error("invalid SQL alias");
  return Prisma.sql`(${Prisma.raw(`"${documentAlias}"."wikiSourceItemId"`)} IS NOT NULL)`;
}
