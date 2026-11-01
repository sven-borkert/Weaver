import { readFile, writeFile, mkdir } from "node:fs/promises";
import { buildProjectApiOpenApi } from "../src/projectApi/contracts";
const target = new URL(
  "../../../docs/api/project-machine-api.openapi.json",
  import.meta.url,
);
const text = JSON.stringify(buildProjectApiOpenApi(), null, 2) + "\n";
if (process.argv.includes("--check")) {
  if ((await readFile(target, "utf8")) !== text)
    throw new Error("Project API OpenAPI reference is stale");
} else {
  await mkdir(new URL("./", target), { recursive: true });
  await writeFile(target, text);
}
