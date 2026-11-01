import { describe, expect, it, vi } from "vitest";
import {
  RepoLockTimeoutError,
  createAdvisoryLockPool,
  createProjectTurnQueue,
  projectRepoLockKey,
  withProjectAdvisoryLock,
  type AdvisoryLockClient,
} from "@weaver/git-store/advisory-lock";

const PROJECT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PROJECT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SET_TIMEOUT_SQL = "SELECT set_config('lock_timeout', $1, false)";
const LOCK_SQL = "SELECT pg_advisory_lock($1::bigint)";
const SHARED_LOCK_SQL = "SELECT pg_advisory_lock_shared($1::bigint)";
const UNLOCK_SQL = "SELECT pg_advisory_unlock($1::bigint) AS released";
const SHARED_UNLOCK_SQL =
  "SELECT pg_advisory_unlock_shared($1::bigint) AS released";

function lockTimeoutError() {
  const error = new Error(
    "canceling statement due to lock timeout",
  ) as Error & { code?: string };
  error.code = "55P03";
  return error;
}

function fakeClient(
  options: { lockError?: Error; released?: boolean; unlockError?: Error } = {},
) {
  const query = vi.fn(async (sql: string) => {
    if (sql === SET_TIMEOUT_SQL) return { rows: [] };
    if (sql === LOCK_SQL || sql === SHARED_LOCK_SQL) {
      if (options.lockError) throw options.lockError;
      return { rows: [] };
    }
    if (
      (sql === UNLOCK_SQL || sql === SHARED_UNLOCK_SQL) &&
      options.unlockError
    ) {
      throw options.unlockError;
    }
    return { rows: [{ released: options.released ?? true }] };
  });
  const release = vi.fn();
  const client = { query, release } satisfies AdvisoryLockClient;
  return { client, query, release };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("project advisory locks", () => {
  it("derives stable project-scoped signed bigint keys", () => {
    const key = projectRepoLockKey(PROJECT_A);

    expect(key).toBe("8814899046527954216");
    expect(projectRepoLockKey(PROJECT_A)).toBe(key);
    expect(projectRepoLockKey(PROJECT_B)).not.toBe(key);
    expect(BigInt(key)).toBeGreaterThanOrEqual(-(1n << 63n));
    expect(BigInt(key)).toBeLessThan(1n << 63n);
  });

  it("uses one advisory key for upper- and lower-case UUID spellings", () => {
    expect(projectRepoLockKey(PROJECT_A.toUpperCase())).toBe(
      projectRepoLockKey(PROJECT_A),
    );
  });

  it("preserves intentionally non-UUID project identifiers", () => {
    const invalidUuidLikeId = "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA";

    expect(projectRepoLockKey(invalidUuidLikeId)).not.toBe(
      projectRepoLockKey(invalidUuidLikeId.toLowerCase()),
    );
  });

  it("acquires with one blocking server-side wait and unlocks", async () => {
    const { client, query, release } = fakeClient();
    const pool = { connect: vi.fn().mockResolvedValue(client) };
    const callback = vi.fn(async () => "done");

    await expect(
      withProjectAdvisoryLock(pool, PROJECT_A, { timeoutMs: 100 }, callback),
    ).resolves.toBe("done");

    expect(pool.connect).toHaveBeenCalledOnce();
    expect(callback).toHaveBeenCalledOnce();
    expect(query).toHaveBeenNthCalledWith(1, SET_TIMEOUT_SQL, [
      expect.stringMatching(/^\d+ms$/),
    ]);
    expect(query).toHaveBeenNthCalledWith(2, LOCK_SQL, [
      projectRepoLockKey(PROJECT_A),
    ]);
    expect(query).toHaveBeenNthCalledWith(3, UNLOCK_SQL, [
      projectRepoLockKey(PROJECT_A),
    ]);
    expect(release).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledWith();
  });

  it("uses shared lock and unlock statements in shared mode", async () => {
    const { client, query } = fakeClient();
    const pool = { connect: vi.fn().mockResolvedValue(client) };

    await expect(
      withProjectAdvisoryLock(
        pool,
        PROJECT_A,
        { timeoutMs: 100, mode: "shared" },
        async () => "read",
      ),
    ).resolves.toBe("read");

    expect(query).toHaveBeenNthCalledWith(2, SHARED_LOCK_SQL, [
      projectRepoLockKey(PROJECT_A),
    ]);
    expect(query).toHaveBeenNthCalledWith(3, SHARED_UNLOCK_SQL, [
      projectRepoLockKey(PROJECT_A),
    ]);
  });

  it("reports acquisition before running the callback", async () => {
    const { client } = fakeClient();
    const pool = { connect: vi.fn().mockResolvedValue(client) };
    const order: string[] = [];

    await withProjectAdvisoryLock(
      pool,
      PROJECT_A,
      { timeoutMs: 100, onAcquired: () => order.push("acquired") },
      async () => {
        order.push("callback");
      },
    );

    expect(order).toEqual(["acquired", "callback"]);
  });

  it("does not report acquisition when the lock wait times out", async () => {
    const { client } = fakeClient({ lockError: lockTimeoutError() });
    const pool = { connect: vi.fn().mockResolvedValue(client) };
    const onAcquired = vi.fn();

    await expect(
      withProjectAdvisoryLock(
        pool,
        PROJECT_A,
        { timeoutMs: 100, onAcquired },
        async () => "never",
      ),
    ).rejects.toBeInstanceOf(RepoLockTimeoutError);

    expect(onAcquired).not.toHaveBeenCalled();
  });
  it("maps a server lock timeout to RepoLockTimeoutError and keeps the connection", async () => {
    const { client, query, release } = fakeClient({
      lockError: lockTimeoutError(),
    });
    const pool = { connect: vi.fn().mockResolvedValue(client) };
    const callback = vi.fn(async () => undefined);

    await expect(
      withProjectAdvisoryLock(pool, PROJECT_B, { timeoutMs: 50 }, callback),
    ).rejects.toBeInstanceOf(RepoLockTimeoutError);

    expect(callback).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalledWith(UNLOCK_SQL, [
      projectRepoLockKey(PROJECT_B),
    ]);
    expect(release).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledWith();
  });

  it("discards the connection when the blocking wait fails", async () => {
    const failure = new Error("connection reset");
    const { client, release } = fakeClient({ lockError: failure });
    const pool = { connect: vi.fn().mockResolvedValue(client) };

    await expect(
      withProjectAdvisoryLock(
        pool,
        PROJECT_A,
        { timeoutMs: 100 },
        async () => undefined,
      ),
    ).rejects.toBe(failure);

    expect(release).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledWith(failure);
  });

  it("includes delayed checkout in the timeout and releases a late client once", async () => {
    vi.useFakeTimers();
    try {
      const checkout = deferred<AdvisoryLockClient>();
      const { client, query, release } = fakeClient();
      const callback = vi.fn(async () => undefined);
      const result = withProjectAdvisoryLock(
        { connect: vi.fn(() => checkout.promise) },
        PROJECT_A,
        { timeoutMs: 50 },
        callback,
      );
      const rejection =
        expect(result).rejects.toBeInstanceOf(RepoLockTimeoutError);

      await vi.advanceTimersByTimeAsync(50);
      await rejection;
      checkout.resolve(client);
      await vi.advanceTimersByTimeAsync(0);

      expect(query).not.toHaveBeenCalled();
      expect(callback).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalledOnce();
      expect(release).toHaveBeenCalledWith();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not lock when the deadline expired during checkout", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      const { client, query, release } = fakeClient();
      const pool = {
        connect: vi.fn(async () => {
          vi.setSystemTime(60);
          return client;
        }),
      };
      const callback = vi.fn(async () => undefined);

      await expect(
        withProjectAdvisoryLock(pool, PROJECT_A, { timeoutMs: 50 }, callback),
      ).rejects.toBeInstanceOf(RepoLockTimeoutError);

      expect(query).not.toHaveBeenCalled();
      expect(callback).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalledOnce();
      expect(release).toHaveBeenCalledWith();
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns the callback result when unlock fails and reports the error", async () => {
    const unlockError = new Error("unlock");
    const { client, release } = fakeClient({ unlockError });
    const pool = { connect: vi.fn().mockResolvedValue(client) };
    const onUnlockError = vi.fn();

    await expect(
      withProjectAdvisoryLock(
        pool,
        PROJECT_A,
        { timeoutMs: 100, onUnlockError },
        async () => "done",
      ),
    ).resolves.toBe("done");

    expect(onUnlockError).toHaveBeenCalledOnce();
    expect(onUnlockError).toHaveBeenCalledWith(unlockError);
    expect(release).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledWith(unlockError);
  });

  it("returns the callback result and discards the connection when no lock was released", async () => {
    const { client, release } = fakeClient({ released: false });
    const pool = { connect: vi.fn().mockResolvedValue(client) };
    const onUnlockError = vi.fn();

    await expect(
      withProjectAdvisoryLock(
        pool,
        PROJECT_A,
        { timeoutMs: 100, onUnlockError },
        async () => "done",
      ),
    ).resolves.toBe("done");

    expect(onUnlockError).toHaveBeenCalledOnce();
    expect(onUnlockError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: `failed to release project advisory lock: ${PROJECT_A}`,
      }),
    );
    expect(release).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledWith(expect.any(Error));
  });

  it("preserves a callback error when unlock also fails", async () => {
    const primaryError = new Error("primary");
    const unlockError = new Error("unlock");
    const observerError = new Error("observer");
    const { client, release } = fakeClient({ unlockError });
    const pool = { connect: vi.fn().mockResolvedValue(client) };
    const onUnlockError = vi.fn(() => {
      throw observerError;
    });

    await expect(
      withProjectAdvisoryLock(
        pool,
        PROJECT_A,
        { timeoutMs: 100, onUnlockError },
        async () => {
          throw primaryError;
        },
      ),
    ).rejects.toBe(primaryError);

    expect(onUnlockError).toHaveBeenCalledOnce();
    expect(onUnlockError).toHaveBeenCalledWith(unlockError);
    expect(release).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledWith(unlockError);
  });
});

describe("advisory lock pool factory", () => {
  it("attaches an error listener so idle client failures cannot crash", async () => {
    const onError = vi.fn();
    const pool = createAdvisoryLockPool({
      connectionString: "postgresql://weaver:secret@127.0.0.1:5432/weaver",
      max: 4,
      applicationName: "weaver-git-lock",
      onError,
    });
    try {
      expect(pool.listenerCount("error")).toBe(1);
      const boom = new Error("idle client lost");
      pool.emit("error", boom);
      expect(onError).toHaveBeenCalledWith(boom);
    } finally {
      await pool.end();
    }
  });
});

describe("project turn queue", () => {
  it("serializes callers for the same project", async () => {
    const queue = createProjectTurnQueue();
    const firstGate = deferred<void>();
    const order: string[] = [];

    const first = queue.withTurn(PROJECT_A, Date.now() + 1_000, async () => {
      order.push("first:start");
      await firstGate.promise;
      order.push("first:end");
    });
    const second = queue.withTurn(PROJECT_A, Date.now() + 1_000, async () => {
      order.push("second:start");
    });

    await vi.waitFor(() => expect(order).toEqual(["first:start"]));
    firstGate.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:end", "second:start"]);
    expect(queue.size).toBe(0);
  });

  it("lets different projects overlap", async () => {
    const queue = createProjectTurnQueue();
    const firstGate = deferred<void>();
    const order: string[] = [];

    const first = queue.withTurn(PROJECT_A, Date.now() + 1_000, async () => {
      order.push("a:start");
      await firstGate.promise;
    });
    const second = queue.withTurn(PROJECT_B, Date.now() + 1_000, async () => {
      order.push("b:start");
    });

    await second;
    expect(order).toEqual(["a:start", "b:start"]);
    firstGate.resolve();
    await first;
  });

  it("times out queued callers without running them", async () => {
    const queue = createProjectTurnQueue();
    const holdGate = deferred<void>();
    const skipped = vi.fn(async () => undefined);

    const holder = queue.withTurn(PROJECT_A, Date.now() + 1_000, async () => {
      await holdGate.promise;
    });
    const waiter = queue.withTurn(PROJECT_A, Date.now() + 10, skipped);

    await expect(waiter).rejects.toBeInstanceOf(RepoLockTimeoutError);
    expect(skipped).not.toHaveBeenCalled();

    holdGate.resolve();
    await holder;
    await queue.withTurn(PROJECT_A, Date.now() + 1_000, async () => undefined);
    expect(queue.size).toBe(0);
  });

  it("keeps late callers queued after a tail waiter times out mid-hold", async () => {
    const queue = createProjectTurnQueue();
    const holdGate = deferred<void>();
    const order: string[] = [];

    const holder = queue.withTurn(PROJECT_A, Date.now() + 1_000, async () => {
      order.push("holder:start");
      await holdGate.promise;
      order.push("holder:end");
    });
    const waiter = queue.withTurn(PROJECT_A, Date.now() + 10, async () => {
      order.push("waiter");
    });
    await expect(waiter).rejects.toBeInstanceOf(RepoLockTimeoutError);

    const late = queue.withTurn(PROJECT_A, Date.now() + 1_000, async () => {
      order.push("late:start");
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(order).toEqual(["holder:start"]);
    expect(queue.size).toBe(1);

    holdGate.resolve();
    await Promise.all([holder, late]);
    expect(order).toEqual(["holder:start", "holder:end", "late:start"]);
    expect(queue.size).toBe(0);
  });
});

describe("shared reader admission", () => {
  it("admits the next reader once the previous one has acquired", async () => {
    const queue = createProjectTurnQueue();
    const acquireGate = deferred<void>();
    const finishGate = deferred<void>();
    const order: string[] = [];

    const first = queue.withSharedTurn(
      PROJECT_A,
      Date.now() + 1_000,
      async (onAcquired) => {
        order.push("first:wait");
        await acquireGate.promise;
        onAcquired();
        order.push("first:acquired");
        await finishGate.promise;
        order.push("first:end");
      },
    );
    const second = queue.withSharedTurn(
      PROJECT_A,
      Date.now() + 1_000,
      async (onAcquired) => {
        order.push("second:wait");
        onAcquired();
        order.push("second:acquired");
      },
    );

    await vi.waitFor(() => expect(order).toEqual(["first:wait"]));
    acquireGate.resolve();
    await second;
    expect(order).toEqual([
      "first:wait",
      "first:acquired",
      "second:wait",
      "second:acquired",
    ]);

    finishGate.resolve();
    await first;
    expect(queue.size).toBe(0);
  });

  it("admits the next reader when the previous one fails before acquiring", async () => {
    const queue = createProjectTurnQueue();
    const failure = new Error("checkout failed");

    const first = queue.withSharedTurn(PROJECT_A, Date.now() + 1_000, () =>
      Promise.reject(failure),
    );
    const second = queue.withSharedTurn(
      PROJECT_A,
      Date.now() + 1_000,
      async (onAcquired) => {
        onAcquired();
        return "read";
      },
    );

    await expect(first).rejects.toBe(failure);
    await expect(second).resolves.toBe("read");
    expect(queue.size).toBe(0);
  });

  it("times out readers that are never admitted", async () => {
    const queue = createProjectTurnQueue();
    const holdGate = deferred<void>();
    const skipped = vi.fn(async () => undefined);

    const stuck = queue.withSharedTurn(
      PROJECT_A,
      Date.now() + 1_000,
      () => holdGate.promise,
    );
    const waiter = queue.withSharedTurn(PROJECT_A, Date.now() + 10, skipped);

    await expect(waiter).rejects.toBeInstanceOf(RepoLockTimeoutError);
    expect(skipped).not.toHaveBeenCalled();

    holdGate.resolve();
    await stuck;
    expect(queue.size).toBe(0);
  });
});

it("fences a checked-out connection loss and aborts its running operation", async () => {
  const { EventEmitter } = await import("node:events");
  const { currentProjectLock } = await import("./advisoryLock");
  const fake = fakeClient();
  const client = Object.assign(new EventEmitter(), fake.client);
  await expect(
    withProjectAdvisoryLock(
      { connect: async () => client },
      PROJECT_A,
      { timeoutMs: 1000 },
      async () => {
        client.emit("error", new Error("connection terminated"));
        await currentProjectLock()!.assertHeld();
      },
    ),
  ).rejects.toThrow("connection terminated");
  expect(fake.release).toHaveBeenCalledWith(expect.any(Error));
});
