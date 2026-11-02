import { PageIndexScreen } from "../_components/PageIndexScreen";

export default async function PageIndexPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  return <PageIndexScreen key={projectId} projectId={projectId} />;
}
