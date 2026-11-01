import { parseKnowledgeConfig } from "@weaver/core/knowledge/config";
import { sendKnowledgePublisherJob } from "./publisher";
import {
  knowledgeJobSendOptions,
  type JobSendOptions,
  type KnowledgeJobName,
  type KnowledgeJobPayloads,
  type ScheduledJobName,
} from "./types";

export interface JobQueue {
  send<N extends KnowledgeJobName>(
    name: N,
    data: KnowledgeJobPayloads[N],
    options?: JobSendOptions,
  ): Promise<string | null>;
  work<N extends KnowledgeJobName>(
    name: N,
    handler: (
      data: KnowledgeJobPayloads[N],
      execution: JobExecution,
    ) => Promise<void>,
  ): Promise<void>;
  schedule(name: ScheduledJobName, cron: string): Promise<void>;
  unschedule?(name: ScheduledJobName): Promise<void>;
  stop(): Promise<void>;
}

export type JobExecution = {
  jobId: string | null;
  /** pg-boss retry count of this delivery; null when the queue cannot tell. */
  retryCount: number | null;
  signal: AbortSignal;
};

type CapturedKnowledgeJob = {
  [N in KnowledgeJobName]: { name: N; data: KnowledgeJobPayloads[N] };
}[KnowledgeJobName];

export class FakeJobQueue implements JobQueue {
  readonly jobs: CapturedKnowledgeJob[] = [];
  readonly schedules: Array<{ name: ScheduledJobName; cron: string }> = [];
  readonly handlers = new Map<
    KnowledgeJobName,
    (data: never, execution: JobExecution) => Promise<void>
  >();
  readonly #singletonJobs = new Map<string, CapturedKnowledgeJob>();
  #runs = 0;

  async send<N extends KnowledgeJobName>(
    name: N,
    data: KnowledgeJobPayloads[N],
    options?: JobSendOptions,
  ): Promise<string | null> {
    const singletonKey = options?.singletonKey;
    if (singletonKey) {
      const queued = this.#singletonJobs.get(singletonKey);
      if (queued && this.jobs.includes(queued)) return null;
    }
    const captured = { name, data } as CapturedKnowledgeJob;
    this.jobs.push(captured);
    if (singletonKey) this.#singletonJobs.set(singletonKey, captured);
    return `fake-job-${this.jobs.length}`;
  }

  async work<N extends KnowledgeJobName>(
    name: N,
    handler: (
      data: KnowledgeJobPayloads[N],
      execution: JobExecution,
    ) => Promise<void>,
  ): Promise<void> {
    this.handlers.set(name, handler);
  }

  /** Runs a captured handler the way the worker would, for tests of handler behavior. */
  async run<N extends KnowledgeJobName>(
    name: N,
    data: KnowledgeJobPayloads[N],
    execution?: Partial<JobExecution>,
  ): Promise<void> {
    const handler = this.handlers.get(name);
    if (!handler) throw new Error(`no handler registered for ${name}`);
    // pg-boss only blocks a new send while a same-key job is outstanding, not once it has run.
    const singletonKey = knowledgeJobSendOptions(name, data)?.singletonKey;
    if (singletonKey) this.#singletonJobs.delete(singletonKey);
    this.#runs += 1;
    await handler(data as never, {
      jobId: execution?.jobId ?? `fake-run-${this.#runs}`,
      retryCount:
        execution?.retryCount === undefined ? 0 : execution.retryCount,
      signal: execution?.signal ?? new AbortController().signal,
    });
  }

  async schedule(name: ScheduledJobName, cron: string): Promise<void> {
    this.schedules.push({ name, cron });
  }

  async unschedule(name: ScheduledJobName): Promise<void> {
    for (let index = this.schedules.length - 1; index >= 0; index -= 1) {
      if (this.schedules[index]!.name === name) this.schedules.splice(index, 1);
    }
  }

  async stop(): Promise<void> {
    return Promise.resolve();
  }
}

let jobQueueForTests: JobQueue | null = null;
let processJobQueue: JobQueue | null = null;
let processJobsStopped = false;

export function setJobQueueForTests(queue: JobQueue | null): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("JobQueue test overrides require the test runtime");
  }
  jobQueueForTests = queue;
}

// The worker runtime registers its own started queue so handler enqueues never
// lazily boot a second pg-boss instance.
export function setProcessJobQueue(queue: JobQueue | null): void {
  processJobQueue = queue;
}

// After the worker runtime has drained and closed its publisher, a late enqueue
// must fail loudly instead of booting a pg-boss instance nothing will stop.
export function setProcessJobsStopped(stopped: boolean): void {
  processJobsStopped = stopped;
}

export async function requestKnowledgeJob<N extends KnowledgeJobName>(
  name: N,
  data: KnowledgeJobPayloads[N],
): Promise<string | null> {
  const config = parseKnowledgeConfig(process.env);
  if (!config.jobsEnabled) return null;

  const options = knowledgeJobSendOptions(name, data);
  if (jobQueueForTests) return jobQueueForTests.send(name, data, options);
  if (processJobQueue) return processJobQueue.send(name, data, options);
  if (processJobsStopped) {
    throw new Error(
      `Knowledge job ${name} requested after the worker runtime stopped`,
    );
  }
  return sendKnowledgePublisherJob(name, data, options);
}
