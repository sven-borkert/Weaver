import { AttemptScreen } from "./_components/AttemptScreen";
export default async function Page({
  params,
}: {
  params: Promise<{ projectId: string; attemptId: string }>;
}) {
  const { projectId, attemptId } = await params;
  return (
    <AttemptScreen
      key={attemptId}
      projectId={projectId}
      attemptId={attemptId}
    />
  );
}
