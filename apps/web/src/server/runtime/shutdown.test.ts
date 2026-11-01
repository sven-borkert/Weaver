import { describe, expect, it, vi } from "vitest";
import { createWebRuntimeCleanup } from "./shutdown";

describe("web runtime cleanup", () => {
  it("drains the publisher, writer, and database exactly once in order", async () => {
    const order: string[] = [];
    const stop = createWebRuntimeCleanup({
      stopPublisher: async () => {
        order.push("publisher");
      },
      emitStopped: () => {
        order.push("event");
      },
      stopWriter: async () => {
        order.push("writer");
      },
      disconnect: async () => {
        order.push("database");
      },
    });
    await Promise.all([stop(), stop()]);
    expect(order).toEqual(["publisher", "event", "writer", "database"]);
  });

  it("continues cleanup after a failed or stalled step without leaking its error", async () => {
    vi.useFakeTimers();
    try {
      const writer = vi.fn().mockRejectedValue(new Error("private credential"));
      const disconnect = vi.fn().mockResolvedValue(undefined);
      const stop = createWebRuntimeCleanup({
        stopPublisher: () => new Promise(() => undefined),
        emitStopped: vi.fn(),
        stopWriter: writer,
        disconnect,
        stepTimeoutMs: 10,
      });
      const assertion = expect(stop()).rejects.toThrow(
        "Web runtime cleanup failed",
      );
      await vi.advanceTimersByTimeAsync(10);
      await assertion;
      expect(writer).toHaveBeenCalledOnce();
      expect(disconnect).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
