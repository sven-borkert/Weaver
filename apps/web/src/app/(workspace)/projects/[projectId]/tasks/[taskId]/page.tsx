import { TaskDetailScreen } from "../_components/TaskDetailScreen";

export default async function TaskPage({
  params,
}: {
  params: Promise<{ projectId: string; taskId: string }>;
}) {
  const { projectId, taskId } = await params;
  return (
    <TaskDetailScreen key={taskId} projectId={projectId} taskId={taskId} />
  );
}
