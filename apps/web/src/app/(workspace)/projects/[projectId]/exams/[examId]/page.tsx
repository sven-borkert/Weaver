import { ExamEditorScreen } from "../_components/ExamEditorScreen";
export default async function Page({
  params,
}: {
  params: Promise<{ projectId: string; examId: string }>;
}) {
  const { projectId, examId } = await params;
  return (
    <ExamEditorScreen key={examId} projectId={projectId} examId={examId} />
  );
}
