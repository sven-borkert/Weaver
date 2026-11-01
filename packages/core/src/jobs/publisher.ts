import { parseKnowledgeConfig } from "../knowledge/config";
import { createKnowledgeQueue } from "./knowledgeQueue";
import type { PgBossQueue } from "./pgBossQueue";
import { type JobSendOptions, type KnowledgeJobPayloads } from "./types";

export type KnowledgePublisherQueue = Pick<
  PgBossQueue<KnowledgeJobPayloads>,
  "start" | "send" | "stop"
>;

export function createKnowledgePublisher(queue: KnowledgePublisherQueue) {
  // A retained resolved start promise doubles as the "running" state.
  let startPromise: Promise<void> | null = null;
  let stopPromise: Promise<void> | null = null;

  function start(): Promise<void> {
    if (stopPromise) {
      return stopPromise.catch(() => undefined).then(start);
    }
    startPromise ??= queue.start().catch((error: unknown) => {
      startPromise = null;
      throw error;
    });
    return startPromise;
  }

  function stop(): Promise<void> {
    if (stopPromise) return stopPromise;
    const started = startPromise;
    if (!started) return Promise.resolve();

    const attempt = (async () => {
      const outcome = await started.then(
        () => "started" as const,
        () => "failed" as const,
      );
      if (outcome === "failed") return;
      try {
        await queue.stop();
      } finally {
        startPromise = null;
      }
    })();
    const sharedStop = attempt.finally(() => {
      if (stopPromise === sharedStop) stopPromise = null;
    });
    stopPromise = sharedStop;
    return sharedStop;
  }

  return {
    start,
    async send<Name extends keyof KnowledgeJobPayloads>(
      name: Name,
      payload: KnowledgeJobPayloads[Name],
      options?: JobSendOptions,
    ) {
      await start();
      return queue.send(name, payload, options);
    },
    stop,
  };
}

const config = parseKnowledgeConfig(process.env);
const globalState = globalThis as typeof globalThis & {
  weaverKnowledgePublisher?: ReturnType<typeof createKnowledgePublisher>;
};

function productionPublisher() {
  return (globalState.weaverKnowledgePublisher ??= createKnowledgePublisher(
    createKnowledgeQueue("publisher"),
  ));
}

export async function sendKnowledgePublisherJob<
  Name extends keyof KnowledgeJobPayloads,
>(name: Name, payload: KnowledgeJobPayloads[Name], options?: JobSendOptions) {
  return productionPublisher().send(name, payload, options);
}

export async function startKnowledgePublisher() {
  if (!config.jobsEnabled) return;
  await productionPublisher().start();
}

export async function stopKnowledgePublisher() {
  await globalState.weaverKnowledgePublisher?.stop();
}
