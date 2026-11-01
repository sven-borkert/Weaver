import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { Pool } from "pg";

type ProjectLock = {
  signal: AbortSignal;
  acquiredAt: number;
  assertHeld: () => Promise<void>;
};
const projectLockContext = new AsyncLocalStorage<ProjectLock>();
export function currentProjectLock(): ProjectLock | undefined {
  return projectLockContext.getStore();
}

export type AdvisoryLockClient = {
  on?(event: "error" | "end", listener: (error?: Error) => void): unknown;
  removeListener?(
    event: "error" | "end",
    listener: (error?: Error) => void,
  ): unknown;
  query(
    sql: string,
    values: unknown[],
  ): Promise<{ rows: Array<Record<string, unknown>> }>;
  release(error?: Error | boolean): void;
};

export type AdvisoryLockPool = {
  connect(): Promise<AdvisoryLockClient>;
};

export class RepoLockTimeoutError extends Error {
  constructor(readonly projectId: string) {
    super(`project repository is busy: ${projectId}`);
    this.name = "RepoLockTimeoutError";
  }
}

const UUID_RE =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000)$/i;

export function canonicalProjectRepoId(projectId: string): string {
  return UUID_RE.test(projectId) ? projectId.toLowerCase() : projectId;
}

export function projectRepoLockKey(projectId: string): string {
  const bytes = createHash("sha256")
    .update("weaver:project-repo:")
    .update(canonicalProjectRepoId(projectId))
    .digest();
  return bytes.readBigInt64BE(0).toString();
}

function clientDiscardReason(error: unknown): Error | true {
  return error instanceof Error ? error : true;
}

export function createAdvisoryLockPool(options: {
  connectionString: string;
  max: number;
  applicationName: string;
  onError: (error: Error) => void;
}): Pool {
  const pool = new Pool({
    connectionString: options.connectionString,
    max: options.max,
    application_name: options.applicationName,
  });
  // pg-pool re-emits idle-client errors on the pool; an unhandled one kills the process.
  pool.on("error", options.onError);
  return pool;
}

export function createProjectTurnQueue() {
  const writerChains = new Map<string, Promise<void>>();
  const readerChains = new Map<string, Promise<void>>();

  async function chain<T>(
    chains: Map<string, Promise<void>>,
    projectId: string,
    deadline: number,
    fn: (releaseTurn: () => void) => Promise<T>,
  ): Promise<T> {
    const key = canonicalProjectRepoId(projectId);
    const previous = chains.get(key) ?? Promise.resolve();
    let releaseTurn!: () => void;
    const turnDone = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    const tracked = previous.then(() => turnDone);
    chains.set(key, tracked);
    let previousSettled = false;
    void previous.then(() => {
      previousSettled = true;
    });
    const forgetIfTail = () => {
      if (chains.get(key) === tracked) chains.delete(key);
    };
    try {
      const turnAcquired = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(
          () => resolve(false),
          Math.max(0, deadline - Date.now()),
        );
        void previous.then(() => {
          clearTimeout(timer);
          resolve(true);
        });
      });
      if (!turnAcquired) throw new RepoLockTimeoutError(projectId);
      return await fn(releaseTurn);
    } finally {
      releaseTurn();
      if (previousSettled) {
        forgetIfTail();
      } else if (chains.get(key) === tracked) {
        // A tail that timed out mid-hold hands the chain back to the running holder.
        chains.set(key, previous);
        void previous.then(() => {
          if (chains.get(key) === previous) chains.delete(key);
        });
      }
    }
  }

  return {
    withTurn<T>(
      projectId: string,
      deadline: number,
      fn: () => Promise<T>,
    ): Promise<T> {
      return chain(writerChains, projectId, deadline, () => fn());
    },
    // Readers overlap once admitted; only one per project waits on the database at a time.
    withSharedTurn<T>(
      projectId: string,
      deadline: number,
      fn: (onAcquired: () => void) => Promise<T>,
    ): Promise<T> {
      return chain(readerChains, projectId, deadline, fn);
    },
    get size() {
      return writerChains.size + readerChains.size;
    },
  };
}

export type AdvisoryLockMode = "exclusive" | "shared";

const LOCK_SQL: Record<AdvisoryLockMode, string> = {
  exclusive: "SELECT pg_advisory_lock($1::bigint)",
  shared: "SELECT pg_advisory_lock_shared($1::bigint)",
};
const UNLOCK_SQL: Record<AdvisoryLockMode, string> = {
  exclusive: "SELECT pg_advisory_unlock($1::bigint) AS released",
  shared: "SELECT pg_advisory_unlock_shared($1::bigint) AS released",
};
const LOCK_NOT_AVAILABLE = "55P03";

function checkoutBeforeDeadline(
  pool: AdvisoryLockPool,
  projectId: string,
  deadline: number,
): Promise<AdvisoryLockClient> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      finish();
    };
    const timer = setTimeout(
      () => settle(() => reject(new RepoLockTimeoutError(projectId))),
      Math.max(0, deadline - Date.now()),
    );
    Promise.resolve()
      .then(() => pool.connect())
      .then(
        (client) => {
          if (settled) {
            client.release();
            return;
          }
          settle(() => resolve(client));
        },
        (error) =>
          settle(() =>
            reject(
              error instanceof Error
                ? error
                : new Error("project repository lock checkout failed", {
                    cause: error,
                  }),
            ),
          ),
      );
  });
}

export async function withProjectAdvisoryLock<T>(
  pool: AdvisoryLockPool,
  projectId: string,
  options: {
    timeoutMs: number;
    mode?: AdvisoryLockMode;
    onAcquired?: () => void;
    onUnlockError?: (error: unknown) => void;
  },
  fn: () => Promise<T>,
): Promise<T> {
  const mode = options.mode ?? "exclusive";
  const deadline = Date.now() + options.timeoutMs;
  const client = await checkoutBeforeDeadline(pool, projectId, deadline);
  const key = projectRepoLockKey(projectId);
  let acquired = false;
  let discardReason: Error | true | undefined;
  const controller = new AbortController();
  const lost = (error?: Error) => {
    const reason =
      error ?? new Error("project repository lock connection ended");
    discardReason = reason;
    controller.abort(reason);
  };
  client.on?.("error", lost);
  client.on?.("end", lost);
  const assertHeld = async () => {
    controller.signal.throwIfAborted();
    try {
      await client.query("SELECT 1", []);
    } catch (error) {
      lost(
        error instanceof Error
          ? error
          : new Error("project repository lock lost"),
      );
    }
    controller.signal.throwIfAborted();
  };

  try {
    const remainingMs = Math.ceil(deadline - Date.now());
    if (remainingMs <= 0) throw new RepoLockTimeoutError(projectId);
    try {
      // The server enforces the deadline and wakes the waiter on release.
      await client.query("SELECT set_config('lock_timeout', $1, false)", [
        `${remainingMs}ms`,
      ]);
      await client.query(LOCK_SQL[mode], [key]);
    } catch (error) {
      if ((error as { code?: string }).code === LOCK_NOT_AVAILABLE) {
        throw new RepoLockTimeoutError(projectId);
      }
      discardReason = clientDiscardReason(error);
      throw error;
    }
    acquired = true;
    options.onAcquired?.();

    return await projectLockContext.run(
      { signal: controller.signal, acquiredAt: Date.now(), assertHeld },
      async () => {
        const result = await fn();
        controller.signal.throwIfAborted();
        return result;
      },
    );
  } finally {
    try {
      if (acquired) {
        const result = await client.query(UNLOCK_SQL[mode], [key]);
        if (result.rows[0]?.released !== true) {
          throw new Error(
            `failed to release project advisory lock: ${projectId}`,
          );
        }
      }
    } catch (unlockError) {
      // Postgres frees the lock when the discarded session closes; never mask the result.
      discardReason = clientDiscardReason(unlockError);
      const report =
        options.onUnlockError ??
        ((error: unknown) =>
          console.error(`project advisory unlock failed: ${projectId}`, error));
      try {
        report(unlockError);
      } catch {
        // An observer must not replace the operation result.
      }
    } finally {
      client.removeListener?.("error", lost);
      client.removeListener?.("end", lost);
      if (discardReason === undefined) {
        client.release();
      } else {
        client.release(discardReason);
      }
    }
  }
}
