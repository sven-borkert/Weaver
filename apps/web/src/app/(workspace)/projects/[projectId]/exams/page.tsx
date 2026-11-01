import { ExamsScreen } from "./_components/ExamsScreen";
export default async function Page({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  return <ExamsScreen key={projectId} projectId={projectId} />;
}
