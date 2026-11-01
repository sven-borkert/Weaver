import { appendFile, readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

export type WorkerEvent = {
  workerId: string;
  kind: string;
  timestamp: number;
};

export async function appendEvent(
  markerFile: string,
  workerId: string,
  kind: string,
): Promise<void> {
  await appendFile(markerFile, `${workerId}:${kind}:${Date.now()}\n`);
}

export async function readEvents(markerFile: string): Promise<WorkerEvent[]> {
  const content = await readFile(markerFile, "utf8").catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    },
  );
  if (!content.trim()) return [];
  return content
    .trim()
    .split("\n")
    .map((line) => {
      const [workerId, kind, rawTimestamp, ...extra] = line.split(":");
      const timestamp = Number(rawTimestamp);
      if (
        !workerId ||
        !kind ||
        extra.length > 0 ||
        !Number.isFinite(timestamp)
      ) {
        throw new Error(`invalid worker event: ${line}`);
      }
      return { workerId, kind, timestamp };
    });
}

export async function waitForEvent(
  markerFile: string,
  workerId: string,
  kind: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const events = await readEvents(markerFile);
    if (
      events.some((event) => event.workerId === workerId && event.kind === kind)
    ) {
      return;
    }
    await delay(25);
  }
  throw new Error(`timed out waiting for ${workerId}:${kind}`);
}

export async function waitForEventCount(
  markerFile: string,
  kind: string,
  count: number,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const events = await readEvents(markerFile);
    if (events.filter((event) => event.kind === kind).length >= count) return;
    await delay(25);
  }
  throw new Error(`timed out waiting for ${count} ${kind} events`);
}
