import { expect, it } from "vitest";
import { mapWithConcurrency } from "./concurrency";
it("stops scheduling work after a failure and drains in-flight workers", async () => {
  const seen: number[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const result = mapWithConcurrency([0, 1, 2, 3], 2, async (item) => {
    seen.push(item);
    if (item === 0) throw new Error("failed");
    await gate;
    return item;
  });
  const failure = expect(result).rejects.toThrow("failed");
  await Promise.resolve();
  release();
  await failure;
  await Promise.resolve();
  expect(seen).toEqual([0, 1]);
});
