import {
  createTRPCUntypedClient,
  loggerLink,
  TRPCClientError,
} from "@trpc/client";
import { observable } from "@trpc/server/observable";
import { describe, expect, it, vi } from "vitest";
import {
  logTrpcOperation,
  isTransientTrpcTransportError,
  isUserHandledTrpcError,
  shouldEnableTrpcLogger,
} from "./logger";

describe("tRPC logger", () => {
  it("redacts payloads even for future routers", () => {
    const output = vi
      .spyOn(console, "debug")
      .mockImplementation(() => undefined);
    try {
      const op = {
        path: "future.create",
        direction: "down" as const,
        input: { clientSecret: "INPUT_SENTINEL" },
        result: { secret: "OUTPUT_SENTINEL" },
      };
      logTrpcOperation(op);
      expect(JSON.stringify(output.mock.calls)).not.toContain("SENTINEL");
      expect(output).toHaveBeenCalledOnce();
    } finally {
      output.mockRestore();
    }
  });

  it.each(["oidc.update", "projectApiKey.create"])(
    "never logs %s credentials",
    (path) => {
      expect(
        shouldEnableTrpcLogger(
          { path, direction: "up" },
          { NEXT_PUBLIC_TRPC_LOGGER: "true" },
        ),
      ).toBe(false);
      expect(
        shouldEnableTrpcLogger(
          { path, direction: "down", result: { secret: "secret" } },
          { NEXT_PUBLIC_TRPC_LOGGER: "true" },
        ),
      ).toBe(false);
    },
  );

  it("does not log aborted client requests as console errors", () => {
    const aborted = Object.assign(new Error("network error"), {
      cause: new DOMException("The user aborted a request.", "AbortError"),
    });

    expect(
      shouldEnableTrpcLogger(
        { direction: "down", result: aborted },
        { NODE_ENV: "development" },
      ),
    ).toBe(false);
    expect(isTransientTrpcTransportError(aborted)).toBe(true);
  });

  it("logs real downlink errors", () => {
    expect(
      shouldEnableTrpcLogger(
        { direction: "down", result: new Error("Invalid input") },
        { NODE_ENV: "development" },
      ),
    ).toBe(true);
  });

  it("does not log fetches interrupted by navigation", () => {
    const interruptedFetch = new Error("network error");

    expect(
      shouldEnableTrpcLogger(
        { direction: "down", result: interruptedFetch },
        { NODE_ENV: "development" },
      ),
    ).toBe(false);
    expect(isTransientTrpcTransportError(interruptedFetch)).toBe(true);
    expect(isTransientTrpcTransportError(new Error("Failed to fetch"))).toBe(
      true,
    );
  });

  it("does not log expected business errors (CONFLICT, PRECONDITION_FAILED, etc.) — they have UI toasts", () => {
    const conflict = Object.assign(new Error("Site already in use"), {
      data: { code: "CONFLICT" },
    });
    expect(isUserHandledTrpcError(conflict)).toBe(true);
    expect(
      shouldEnableTrpcLogger(
        { direction: "down", result: conflict },
        { NODE_ENV: "development" },
      ),
    ).toBe(false);

    const precondition = Object.assign(new Error("Reference in use"), {
      data: { code: "PRECONDITION_FAILED" },
    });
    expect(
      shouldEnableTrpcLogger(
        { direction: "down", result: precondition },
        { NODE_ENV: "development" },
      ),
    ).toBe(false);
  });

  it("still logs unexpected server errors like INTERNAL_SERVER_ERROR", () => {
    const crash = Object.assign(new Error("DB connection lost"), {
      data: { code: "INTERNAL_SERVER_ERROR" },
    });
    expect(isUserHandledTrpcError(crash)).toBe(false);
    expect(
      shouldEnableTrpcLogger(
        { direction: "down", result: crash },
        { NODE_ENV: "development" },
      ),
    ).toBe(true);
  });

  it("opts back in to logging business errors when NEXT_PUBLIC_TRPC_LOGGER=true", () => {
    const conflict = Object.assign(new Error("Site in use"), {
      data: { code: "CONFLICT" },
    });
    expect(
      shouldEnableTrpcLogger(
        { direction: "down", result: conflict },
        { NODE_ENV: "development", NEXT_PUBLIC_TRPC_LOGGER: "true" },
      ),
    ).toBe(true);
  });

  it("logs successful development traffic only when explicitly enabled", () => {
    expect(
      shouldEnableTrpcLogger({ direction: "up" }, { NODE_ENV: "development" }),
    ).toBe(false);
    expect(
      shouldEnableTrpcLogger(
        { direction: "up" },
        { NODE_ENV: "development", NEXT_PUBLIC_TRPC_LOGGER: "true" },
      ),
    ).toBe(true);
  });
});

describe("private-key upload logging", () => {
  it.each([
    { logging: undefined, failure: true },
    { logging: "true", failure: false },
    { logging: "true", failure: true },
  ])(
    "never logs upload inputs with debug=$logging and failure=$failure",
    async ({ logging, failure }) => {
      const sentinel = "PRIVATE_KEY_SENTINEL_DO_NOT_LOG";
      const output = { log: vi.fn(), error: vi.fn() };
      const client = createTRPCUntypedClient({
        links: [
          loggerLink({
            enabled: (operation) =>
              shouldEnableTrpcLogger(operation, {
                NEXT_PUBLIC_TRPC_LOGGER: logging,
              }),
            console: output,
            colorMode: "none",
          }),
          () => () =>
            observable((observer) => {
              if (failure) {
                observer.error(
                  TRPCClientError.from(new Error("Unexpected server failure")),
                );
              } else {
                observer.next({ result: { data: { saved: true } } });
                observer.complete();
              }
            }),
        ],
      });
      const request = client.mutation("projectGitRemote.uploadKey", {
        privateKey: sentinel,
      });
      if (failure)
        await expect(request).rejects.toThrow("Unexpected server failure");
      else await expect(request).resolves.toEqual({ saved: true });
      expect(
        JSON.stringify([...output.log.mock.calls, ...output.error.mock.calls]),
      ).not.toContain(sentinel);
      expect(output.log).not.toHaveBeenCalled();
      expect(output.error).not.toHaveBeenCalled();
    },
  );
});

it.each([
  "account.changePassword",
  "user.create",
  "user.resetPassword",
  "apiKey.create",
  "llmConnection.create",
  "llmConnection.update",
  "externalMcpConnection.save",
])("never logs credential-bearing %s even in debug mode", (path) => {
  expect(
    shouldEnableTrpcLogger(
      { direction: "up", path },
      { NEXT_PUBLIC_TRPC_LOGGER: "true" },
    ),
  ).toBe(false);
  expect(
    shouldEnableTrpcLogger(
      { direction: "down", path, result: new Error("failure") },
      { NEXT_PUBLIC_TRPC_LOGGER: "true" },
    ),
  ).toBe(false);
});
