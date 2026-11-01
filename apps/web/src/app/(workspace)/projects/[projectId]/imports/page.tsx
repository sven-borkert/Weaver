import { env } from "~/env";
import { ImportsClient } from "./_components/ImportsClient";

export default async function ImportsPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  return (
    <ImportsClient
      key={projectId}
      projectId={projectId}
      maxBytes={env.WEAVER_INGESTION_MAX_FILE_BYTES}
    />
  );
}
