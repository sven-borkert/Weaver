import { EventEmitter } from "node:events";
import { beforeEach, expect, it, vi } from "vitest";
import { createApiKey, API_KEY_NAME_MAX_LENGTH } from "./apiKeys";
import { createSessionSecurityContext } from "../security/context";

const mocks = vi.hoisted(() => ({ client: vi.fn() }));
vi.mock("pg", () => ({ Client: mocks.client }));
vi.mock("@weaver/config/server", () => ({
  parseServerEnv: () => ({
    DATABASE_URL: "postgresql://localhost/weaver_test",
  }),
}));

const actor = createSessionSecurityContext({
  userId: "user",
  sessionId: "session",
  globalRole: "User",
});
const input = {
  name: "Key",
  capabilities: [],
  projectIds: [],
  expiresInDays: null,
  rateLimitPerMinute: null,
};
function database() {
  return {
    $transaction: vi.fn(async () => {
      throw new Error("the sole application connection is occupied");
    }),
    session: {
      findFirst: vi.fn(async () => ({
        user: {
          role: "User",
          banned: false,
          banExpires: null,
          mustChangePassword: false,
        },
      })),
    },
    apiKey: {
      findUniqueOrThrow: vi.fn(async () => ({
        id: "issued",
        permissions: null,
        projects: [],
      })),
      deleteMany: vi.fn(async () => ({ count: 1 })),
    },
  };
}
let lock: EventEmitter & {
  connect: ReturnType<typeof vi.fn>;
  query: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
};
beforeEach(() => {
  lock = Object.assign(new EventEmitter(), {
    connect: vi.fn(async () => undefined),
    query: vi.fn(async () => ({ rows: [] })),
    end: vi.fn(async () => undefined),
  });
  mocks.client.mockImplementation(function () {
    return lock;
  });
});

it("reports the actual API key name length limit", async () => {
  await expect(
    createApiKey(
      database() as never,
      actor,
      { ...input, name: "x".repeat(API_KEY_NAME_MAX_LENGTH + 1) },
      {} as never,
    ),
  ).rejects.toMatchObject({
    code: "BAD_REQUEST",
    message: `Name must be at most ${API_KEY_NAME_MAX_LENGTH} characters`,
  });
  expect(lock.end).toHaveBeenCalledOnce();
});

it("issues without reserving an application pool connection for its lock", async () => {
  await expect(
    createApiKey(database() as never, actor, input, {
      issue: async () => ({ id: "issued", key: "secret" }),
    }),
  ).resolves.toMatchObject({ secret: "secret", key: { id: "issued" } });
  expect(lock.end).toHaveBeenCalledOnce();
});

it.each(["minting", "reading the result"])(
  "removes an issued key if the credential lock is lost while %s",
  async (phase) => {
    const db = database();
    if (phase === "reading the result")
      db.apiKey.findUniqueOrThrow.mockImplementationOnce(async () => {
        lock.emit("error", new Error("connection lost"));
        return { id: "issued", permissions: null, projects: [] };
      });
    await expect(
      createApiKey(db as never, actor, input, {
        issue: async () => {
          if (phase === "minting")
            lock.emit("error", new Error("connection lost"));
          return { id: "issued", key: "secret" };
        },
      }),
    ).rejects.toThrow();
    expect(db.apiKey.deleteMany).toHaveBeenCalledWith({
      where: { id: "issued" },
    });
    expect(lock.end).toHaveBeenCalledOnce();
  },
);

it("closes a failed lock connection without minting a key", async () => {
  lock.connect.mockRejectedValueOnce(new Error("connection refused"));
  const issue = vi.fn();
  await expect(
    createApiKey(database() as never, actor, input, { issue }),
  ).rejects.toThrow("connection refused");
  expect(issue).not.toHaveBeenCalled();
  expect(lock.end).toHaveBeenCalledOnce();
});
