import type { Prisma, PrismaClient } from "@weaver/db/client";
import type { WikiPageProperties } from "../wiki/properties";

type Db = PrismaClient | Prisma.TransactionClient;

export type PresentedWikiSource =
  | { kind: "url"; url: string }
  | {
      kind: "document" | "table" | "artifact";
      id: string;
      available: boolean;
      title?: string;
    };

export type PresentedWikiProperties = Omit<WikiPageProperties, "sources"> & {
  sources?: PresentedWikiSource[];
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Source ids resolve only inside the page's own project; anything else shows as
 * unavailable. The caller already holds Viewer access to the project.
 */
export async function presentWikiProperties(
  db: Db,
  projectId: string,
  properties: WikiPageProperties | undefined,
): Promise<PresentedWikiProperties | null> {
  if (!properties) return null;
  const { sources, ...rest } = properties;
  if (!sources) return rest;
  const ids = (kind: "document" | "table" | "artifact") => [
    ...new Set(
      sources
        .filter((s) => s.kind === kind && s.id !== undefined && UUID.test(s.id))
        .map((s) => s.id!),
    ),
  ];
  const lookup = async (
    kind: "document" | "table" | "artifact",
  ): Promise<Map<string, string>> => {
    const list = ids(kind);
    if (list.length === 0) return new Map();
    const where = { projectId, id: { in: list } };
    const rows =
      kind === "document"
        ? await db.document.findMany({
            where,
            select: { id: true, title: true },
          })
        : kind === "table"
          ? await db.dataTable.findMany({
              where,
              select: { id: true, title: true },
            })
          : (
              await db.artifact.findMany({
                where,
                select: { id: true, filename: true },
              })
            ).map((row) => ({ id: row.id, title: row.filename }));
    return new Map(rows.map((row) => [row.id, row.title]));
  };
  const [documents, tables, artifacts] = await Promise.all([
    lookup("document"),
    lookup("table"),
    lookup("artifact"),
  ]);
  const found = { document: documents, table: tables, artifact: artifacts };
  return {
    ...rest,
    sources: sources.map((source): PresentedWikiSource => {
      if (source.kind === "url") return { kind: "url", url: source.url ?? "" };
      const title = found[source.kind].get(source.id ?? "");
      return title === undefined
        ? { kind: source.kind, id: source.id ?? "", available: false }
        : { kind: source.kind, id: source.id ?? "", available: true, title };
    }),
  };
}
