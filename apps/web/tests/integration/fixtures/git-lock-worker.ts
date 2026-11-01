import { setTimeout as delay } from "node:timers/promises";
import { withProjectRepo } from "@weaver/git-store";
import { appendEvent, waitForEventCount } from "./lock-events";

const BARRIER_TIMEOUT_MS = 10_000;
const AUTHOR_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

type WorkerMode = "crash" | "once" | "overlap" | "serial";

function isWorkerMode(value: string | undefined): value is WorkerMode {
  return (
    value === "crash" ||
    value === "once" ||
    value === "overlap" ||
    value === "serial"
  );
}

async function main(): Promise<void> {
  const [projectId, markerFile, workerId, mode, rawHoldMs] =
    process.argv.slice(2);
  const holdMs = Number(rawHoldMs);
  if (
    !projectId ||
    !markerFile ||
    !workerId ||
    !isWorkerMode(mode) ||
    !Number.isFinite(holdMs) ||
    holdMs < 0
  ) {
    process.exit(2);
  }

  if (mode === "serial" || mode === "overlap") {
    await appendEvent(markerFile, workerId, "ready");
    await waitForEventCount(markerFile, "ready", 2, BARRIER_TIMEOUT_MS);
  }

  await withProjectRepo(projectId, async (repo) => {
    if (mode === "crash") {
      await appendEvent(markerFile, workerId, "locked");
      await new Promise<never>(() => undefined);
    }
    await appendEvent(markerFile, workerId, "start");
    if (mode === "overlap") {
      await waitForEventCount(markerFile, "start", 2, BARRIER_TIMEOUT_MS);
    }
    await delay(holdMs);
    await repo.writeFileAtomic(`${workerId}.md`, `# ${workerId}\n`);
    await repo.commitAll(`test: ${workerId}`, {
      name: workerId,
      email: `${workerId}@weaver.test`,
      userId: AUTHOR_ID,
    });
    await appendEvent(markerFile, workerId, "end");
  });
}

void main().then(
  () => process.exit(0),
  () => process.exit(1),
);
