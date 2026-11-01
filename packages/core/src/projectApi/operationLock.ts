import { parseServerEnv } from "@weaver/config/server";
import {
  createAdvisoryLockPool,
  createProjectTurnQueue,
  withProjectAdvisoryLock,
  RepoLockTimeoutError,
} from "@weaver/git-store/advisory-lock";
import type { Pool } from "pg";
import { CoreError } from "../errors";
let pool: Pool | undefined;
const queue = createProjectTurnQueue();
export async function withProjectApiOperationLock<T>(
  id: string,
  fn: () => Promise<T>,
): Promise<T> {
  const env = parseServerEnv(process.env);
  pool ??= createAdvisoryLockPool({
    connectionString: env.DATABASE_URL,
    max: env.WEAVER_PROJECT_API_OPERATION_LOCK_POOL_MAX,
    applicationName: "weaver-project-api-operations",
    onError: () =>
      console.error("Project API operation lock connection failed"),
  });
  const deadline = Date.now() + env.WEAVER_GIT_LOCK_TIMEOUT_MS;
  try {
    return await queue.withTurn(id, deadline, () =>
      withProjectAdvisoryLock(
        pool!,
        id,
        { timeoutMs: Math.max(1, deadline - Date.now()) },
        fn,
      ),
    );
  } catch (error) {
    if (error instanceof RepoLockTimeoutError)
      throw new CoreError("CONFLICT", "Operation busy");
    throw error;
  }
}
export async function closeProjectApiOperationPool() {
  const previous = pool;
  pool = undefined;
  await previous?.end();
}
