import { parseKnowledgeConfig } from "../knowledge/config";
import { PgBossQueue } from "./pgBossQueue";
import { KNOWLEDGE_JOB_NAMES, type KnowledgeJobPayloads } from "./types";

export function createKnowledgeQueue(
  mode: "worker" | "publisher",
): PgBossQueue<KnowledgeJobPayloads> {
  const config = parseKnowledgeConfig(process.env);
  return new PgBossQueue<KnowledgeJobPayloads>({
    connectionString: process.env.DATABASE_URL!,
    queueNames: KNOWLEDGE_JOB_NAMES,
    workerConcurrency: config.workerConcurrency,
    mode,
  });
}
