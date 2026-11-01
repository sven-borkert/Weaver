import { archiveProblem } from "@weaver/artifact-readers/archive";
import type { ParseFailure } from "../parser";

/** Reject oversized, encrypted and ZIP64 containers before a parser inflates them. */
export function archiveIssue(bytes: Buffer): ParseFailure | null {
  const problem = archiveProblem(bytes);
  if (problem === null) return null;
  if (problem === "not_archive")
    return { failureKind: "parser", message: "the archive could not be read" };
  return {
    failureKind: "validation",
    message: "archive exceeds parser limits or has invalid metadata",
  };
}
