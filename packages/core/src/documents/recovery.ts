import { hasAssetsSegment } from "./images";
import { documentKindFromPath } from "./kinds";
import { TABLES_ROOT, isTableDirName } from "../tables/paths";

export type DeletedResourceKind = "document" | "table";

export type DeletedPathClassification = {
  kind: DeletedResourceKind;
  /** The path that identifies the resource: the document file, or the .table directory. */
  resourcePath: string;
};

/** Which committed deletions represent a recoverable resource. */
export function classifyDeletedPath(
  path: string,
): DeletedPathClassification | null {
  const segments = path.split("/");
  if (segments.some((segment) => segment.length === 0)) return null;
  if (segments[0] === ".git" || segments[0] === ".weaver-icons") return null;
  if (segments[0] === TABLES_ROOT) {
    // A deleted table drops schema.json and data.jsonl; only the schema
    // classifies, so one table yields exactly one candidate.
    if (segments[segments.length - 1] !== "schema.json") return null;
    const dir = segments[segments.length - 2];
    if (!dir || !isTableDirName(dir)) return null;
    return { kind: "table", resourcePath: segments.slice(0, -1).join("/") };
  }
  if (documentKindFromPath(path) === null) return null;
  if (hasAssetsSegment(path)) return null;
  return { kind: "document", resourcePath: path };
}
