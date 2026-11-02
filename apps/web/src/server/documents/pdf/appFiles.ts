import { readFile } from "node:fs/promises";
import path from "node:path";

// Server runtimes start in the app directory, the integration suite in the repository root.
const APP_DIRECTORIES = [".", "apps/web"];

/** Reads a traced file by path: the bundler compiles a module lookup into a module id. */
export async function readAppFile(relativePath: string): Promise<Buffer> {
  let failure: unknown;
  for (const directory of APP_DIRECTORIES) {
    try {
      // next.config's tracing includes list these files; a dynamic path would trace the project.
      return await readFile(
        /*turbopackIgnore: true*/ path.resolve(directory, relativePath),
      );
    } catch (error) {
      failure = error;
    }
  }
  throw failure;
}
