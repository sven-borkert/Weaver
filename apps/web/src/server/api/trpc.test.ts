import { TRPCError } from "@trpc/server";
import { createTRPCClient, httpBatchLink, TRPCClientError } from "@trpc/client";
import { CoreError } from "@weaver/core/errors";
import { createSessionSecurityContext } from "@weaver/core/security/context";
import superjson from "superjson";
import { describe, expect, it, vi } from "vitest";

import { handleTrpcFetchRequest } from "./http-transport";
import { authedProcedure, createTRPCRouter, publicProcedure } from "./trpc";

vi.mock("~/server/auth", () => ({ getSessionUser: vi.fn() }));
vi.mock("@weaver/db", () => ({ db: {} }));
vi.mock("~/env", () => ({ env: {} }));

const HEAD_COMMIT_SHA = "a".repeat(40);
const conflicts = [{ kind: "cell", rowId: "row-1", columnId: "column-1" }];

const router = createTRPCRouter({
  coreFailure: authedProcedure.query(() => {
    throw new CoreError("NOT_FOUND");
  }),
  withMetadata: publicProcedure.query(() => {
    throw new TRPCError({
      code: "CONFLICT",
      cause: { conflicts, headCommitSha: HEAD_COMMIT_SHA },
    });
  }),
  withoutMetadata: publicProcedure.query(() => {
    throw new TRPCError({
      code: "CONFLICT",
      cause: { headCommitSha: 123 },
    });
  }),
});

const client = createTRPCClient<typeof router>({
  links: [
    httpBatchLink({
      transformer: superjson,
      url: "http://localhost/api/trpc",
      fetch: (url, init) =>
        handleTrpcFetchRequest({
          endpoint: "/api/trpc",
          req: new Request(url, init),
          router,
          createContext: () =>
            Promise.resolve({
              db: {},
              session: null,
              security: null,
              headers: new Headers(),
            }) as never,
        }),
    }),
  ],
});

describe("tRPC error metadata", () => {
  it("maps a core service failure through the authenticated procedure", async () => {
    const caller = router.createCaller({
      session: {
        user: {
          id: "user-1",
          email: "user@example.com",
          name: "User One",
          role: "User",
          sessionId: "session-1",
        },
      },
      security: createSessionSecurityContext({
        userId: "user-1",
        globalRole: "User",
        sessionId: "session-1",
      }),
      headers: new Headers(),
    } as never);

    await expect(caller.coreFailure()).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("lifts conflicts and a string headCommitSha from the error cause", async () => {
    const error = await client.withMetadata.query().catch((cause: unknown) => {
      if (!(cause instanceof Error)) throw cause;
      return TRPCClientError.from(cause);
    });

    expect(error.data).toMatchObject({
      conflicts,
      headCommitSha: HEAD_COMMIT_SHA,
    });
  });

  it("uses null when conflicts or a string headCommitSha are absent", async () => {
    const error = await client.withoutMetadata
      .query()
      .catch((cause: unknown) => {
        if (!(cause instanceof Error)) throw cause;
        return TRPCClientError.from(cause);
      });

    expect(error.data).toMatchObject({ conflicts: null, headCommitSha: null });
  });
});
