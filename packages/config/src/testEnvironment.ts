import { realpathSync } from "node:fs";
import path from "node:path";

export function assertTestEnvironment(
  input: Record<string, string | undefined>,
  suite: "integration" | "e2e",
  workspaceRoot: string,
): string {
  const database = suite === "integration" ? "weaver_test" : "weaver_e2e";
  const directory = suite === "integration" ? "data-test" : "data-e2e";
  let actualDatabase: string;
  try {
    const url = new URL(input.DATABASE_URL ?? "");
    if (
      !["postgres:", "postgresql:"].includes(url.protocol) ||
      url.searchParams.has("host") ||
      url.searchParams.has("hostaddr")
    ) {
      throw new Error("Test reset refused: noncanonical database URL");
    }
    if (
      !["localhost", "127.0.0.1", "[::1]", "postgres"].includes(url.hostname)
    ) {
      throw new Error("Test reset refused: database host must be local");
    }
    actualDatabase = decodeURIComponent(
      new URL(input.DATABASE_URL ?? "").pathname.slice(1),
    );
  } catch {
    throw new Error("Test reset refused: invalid DATABASE_URL");
  }
  const expected = path.resolve(workspaceRoot, directory);
  const actual = input.WEAVER_DATA_DIR
    ? path.resolve(workspaceRoot, input.WEAVER_DATA_DIR)
    : "";
  if (actualDatabase !== database || actual !== expected) {
    throw new Error(
      `Test reset refused: expected ${database} and ${directory}`,
    );
  }
  try {
    if (realpathSync(actual) !== actual)
      throw new Error("Test reset refused: symlinked data directory");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
      throw error;
  }
  return actual;
}
