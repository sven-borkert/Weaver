import { env } from "~/env";
import { WikiInputScreen } from "./_components/WikiInputScreen";

export default async function WikiPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  return (
    <WikiInputScreen
      key={projectId}
      projectId={projectId}
      maxBytes={env.WEAVER_INGESTION_MAX_FILE_BYTES}
    />
  );
}
