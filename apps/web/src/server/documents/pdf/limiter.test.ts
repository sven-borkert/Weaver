import { describe, expect, it } from "vitest";
import { createLimiter, PdfBusyError } from "./limiter";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe("createLimiter", () => {
  it("runs one task at a time and queues the rest in order", async () => {
    const limiter = createLimiter({ concurrency: 1, maxWaiting: 4 });
    const first = deferred<string>();
    const order: string[] = [];
    const a = limiter.run(async () => {
      order.push("a-start");
      return first.promise;
    });
    const b = limiter.run(async () => {
      order.push("b-start");
      return "b";
    });
    await Promise.resolve();
    expect(order).toEqual(["a-start"]);
    expect(limiter.waiting).toBe(1);
    first.resolve("a");
    expect(await a).toBe("a");
    expect(await b).toBe("b");
    expect(order).toEqual(["a-start", "b-start"]);
  });

  it("refuses the fifth waiting render", async () => {
    const limiter = createLimiter({ concurrency: 1, maxWaiting: 4 });
    const gate = deferred<void>();
    const running = limiter.run(() => gate.promise);
    const waiting = Array.from({ length: 4 }, () =>
      limiter.run(async () => "ok"),
    );
    await expect(limiter.run(async () => "late")).rejects.toBeInstanceOf(
      PdfBusyError,
    );
    gate.resolve();
    await running;
    expect(await Promise.all(waiting)).toEqual(["ok", "ok", "ok", "ok"]);
  });

  it("keeps running after a task throws", async () => {
    const limiter = createLimiter({ concurrency: 1, maxWaiting: 4 });
    await expect(
      limiter.run(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await limiter.run(async () => "next")).toBe("next");
  });
});
