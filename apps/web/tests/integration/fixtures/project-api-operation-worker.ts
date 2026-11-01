import type {
  ProjectMachineContext,
  MutationMeta,
} from "@weaver/core/projectApi/types";
import type { MachineCommand } from "@weaver/core/projectApi/schemas";
import { fileURLToPath } from "node:url";
import { assertTestEnvironment } from "@weaver/config/testEnvironment";
import { db } from "@weaver/db";
import { publishProjectMachineContent } from "@weaver/core/services/projectApi";
import { closeProjectApiOperationPool } from "@weaver/core/projectApi/operationLock";
assertTestEnvironment(
  process.env,
  "integration",
  fileURLToPath(new URL("../../../../../", import.meta.url)),
);
const input = JSON.parse(process.argv[2]!) as {
  context: ProjectMachineContext;
  command: MachineCommand;
  meta: MutationMeta;
};
try {
  const receipt = await publishProjectMachineContent(
    db,
    input.context,
    input.command,
    input.meta,
  );
  console.log(JSON.stringify(receipt));
  await closeProjectApiOperationPool();
  await db.$disconnect();
  process.exit(0);
} catch {
  await closeProjectApiOperationPool();
  await db.$disconnect();
  process.exit(1);
}
