import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createKnowledgePublisher,
  type KnowledgePublisherQueue,
} from "./publisher";

describe("knowledge publisher", () => {
  afterEach(() => vi.restoreAllMocks());

  it("starts once, publishes without registering workers, and stops", async () => {
    const queue: KnowledgePublisherQueue = {
      start: vi.fn().mockResolvedValue(undefined),
      send: vi.fn().mockResolvedValue("job-1"),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const publisher = createKnowledgePublisher(queue);
    await Promise.all([publisher.start(), publisher.start()]);
    await publisher.send("system.reconcile", {});
    await publisher.stop();
    expect(queue.start).toHaveBeenCalledTimes(1);
    expect(queue.send).toHaveBeenCalledWith("system.reconcile", {}, undefined);
    expect(queue.stop).toHaveBeenCalledTimes(1);
  });

  it("can retry after queue startup fails", async () => {
    const startError = new Error("start failed");
    const queue: KnowledgePublisherQueue = {
      start: vi
        .fn()
        .mockRejectedValueOnce(startError)
        .mockResolvedValue(undefined),
      send: vi.fn().mockResolvedValue("job-1"),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const publisher = createKnowledgePublisher(queue);

    await expect(publisher.start()).rejects.toBe(startError);
    await expect(publisher.start()).resolves.toBeUndefined();

    expect(queue.start).toHaveBeenCalledTimes(2);
  });

  it("shares one in-flight stop", async () => {
    let releaseStop!: () => void;
    const stopGate = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    const queue: KnowledgePublisherQueue = {
      start: vi.fn().mockResolvedValue(undefined),
      send: vi.fn().mockResolvedValue("job-1"),
      stop: vi.fn().mockReturnValue(stopGate),
    };
    const publisher = createKnowledgePublisher(queue);
    await publisher.start();

    const firstStop = publisher.stop();
    const secondStop = publisher.stop();
    releaseStop();
    await Promise.all([firstStop, secondStop]);
    expect(queue.stop).toHaveBeenCalledTimes(1);
  });

  it("can restart after queue shutdown fails", async () => {
    const stopError = new Error("stop failed");
    const queue: KnowledgePublisherQueue = {
      start: vi.fn().mockResolvedValue(undefined),
      send: vi.fn().mockResolvedValue("job-1"),
      stop: vi
        .fn()
        .mockRejectedValueOnce(stopError)
        .mockResolvedValue(undefined),
    };
    const publisher = createKnowledgePublisher(queue);
    await publisher.start();

    await expect(publisher.stop()).rejects.toBe(stopError);
    await publisher.start();

    expect(queue.start).toHaveBeenCalledTimes(2);
  });

  it("waits for an overlapping stop before starting again", async () => {
    let releaseStop!: () => void;
    const stopGate = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    const queue: KnowledgePublisherQueue = {
      start: vi.fn().mockResolvedValue(undefined),
      send: vi.fn().mockResolvedValue("job-1"),
      stop: vi.fn().mockReturnValue(stopGate),
    };
    const publisher = createKnowledgePublisher(queue);
    await publisher.start();

    const stopping = publisher.stop();
    let restarted = false;
    const restarting = publisher.start().then(() => {
      restarted = true;
    });
    await Promise.resolve();

    expect(restarted).toBe(false);
    expect(queue.start).toHaveBeenCalledTimes(1);

    releaseStop();
    await Promise.all([stopping, restarting]);
    expect(queue.start).toHaveBeenCalledTimes(2);
  });
});
