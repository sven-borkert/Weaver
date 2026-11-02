import { WikiRunsScreen } from "../_components/WikiRunsScreen";

export default async function WikiRunsPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  return <WikiRunsScreen key={projectId} projectId={projectId} />;
}
