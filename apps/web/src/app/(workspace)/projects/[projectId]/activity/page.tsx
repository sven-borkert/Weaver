import { ProjectActivityScreen } from "../_components/ProjectActivityScreen";

export default async function ProjectActivityPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  return <ProjectActivityScreen key={projectId} projectId={projectId} />;
}
