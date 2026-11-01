import { ExamResultsScreen } from "../_components/ExamResultsScreen";
export default async function Page({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  return <ExamResultsScreen key={projectId} projectId={projectId} />;
}
