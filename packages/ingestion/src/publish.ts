import { requestKnowledgeJob } from "@weaver/core/jobs/queue";
import type { IngestionStagePayload } from "@weaver/core/jobs/types";

/** Publication after a committed transition; false leaves the file for system.reconcile to republish after the TTL. */
export async function publishStage(
  name: "ingestion.analyze" | "ingestion.link",
  payload: IngestionStagePayload,
): Promise<boolean> {
  try {
    return (await requestKnowledgeJob(name, payload)) !== null;
  } catch {
    return false;
  }
}
