import { TasksScreen } from "./_components/TasksScreen";

export default async function TasksPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  return <TasksScreen key={projectId} projectId={projectId} />;
}
