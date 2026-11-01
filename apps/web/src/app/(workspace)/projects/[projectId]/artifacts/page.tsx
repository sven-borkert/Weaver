import { env } from "~/env";
import { ArtifactsScreen } from "./_components/ArtifactsScreen";

export default async function ArtifactsPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ file?: string | string[] }>;
}) {
  const { projectId } = await params;
  const { file } = await searchParams;
  const focusFilename = typeof file === "string" ? file.slice(0, 255) : null;
  return (
    <ArtifactsScreen
      // Remount on a new deep link so a client-side ?file= change reseeds
      // search instead of leaving the previous filename applied.
      key={`${projectId}:${focusFilename ?? ""}`}
      projectId={projectId}
      maxFileBytes={env.WEAVER_ARTIFACT_MAX_FILE_BYTES}
      focusFilename={focusFilename}
    />
  );
}
