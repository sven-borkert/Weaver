import { afterEach, describe, expect, it } from "vitest";
import { createWorkerHealthServer } from "./health";

describe("worker health server", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => close?.());

  it("reports process liveness without touching dependencies", async () => {
    const health = await createWorkerHealthServer(0);
    close = health.close;
    const response = await fetch(`http://127.0.0.1:${health.port}/health`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: "ok",
      runtime: "agent-worker",
    });
  });

  it("reports starting until the readiness probe flips", async () => {
    let ready = false;
    const health = await createWorkerHealthServer(0, "127.0.0.1", () => ready);
    close = health.close;

    const before = await fetch(`http://127.0.0.1:${health.port}/health`);
    expect(before.status).toBe(503);
    await expect(before.json()).resolves.toMatchObject({ status: "starting" });

    ready = true;
    const after = await fetch(`http://127.0.0.1:${health.port}/health`);
    expect(after.status).toBe(200);
    await expect(after.json()).resolves.toMatchObject({ status: "ok" });
  });

  it("reports the worker's configured roles once ready", async () => {
    const health = await createWorkerHealthServer(0, "127.0.0.1", () => true, {
      roles: ["ingestion"],
    });
    close = health.close;
    const response = await fetch(`http://127.0.0.1:${health.port}/health`);
    await expect(response.json()).resolves.toEqual({
      status: "ok",
      runtime: "agent-worker",
      roles: ["ingestion"],
    });
  });
});

it("reports dependency failure separately from process liveness", async () => {
  let dependenciesReady = false;
  const server = await createWorkerHealthServer(0, "127.0.0.1", () => true, {
    checkDependencies: async () => dependenciesReady,
  });
  try {
    expect((await fetch(`http://127.0.0.1:${server.port}/health`)).status).toBe(
      200,
    );
    expect((await fetch(`http://127.0.0.1:${server.port}/ready`)).status).toBe(
      503,
    );
    dependenciesReady = true;
    expect((await fetch(`http://127.0.0.1:${server.port}/ready`)).status).toBe(
      200,
    );
  } finally {
    await server.close();
  }
});
