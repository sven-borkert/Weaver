import { ReviewScreen } from "../_components/ReviewScreen";

export default async function ImportReviewPage({
  params,
}: {
  params: Promise<{ projectId: string; fileId: string }>;
}) {
  const { projectId, fileId } = await params;
  return <ReviewScreen key={fileId} projectId={projectId} fileId={fileId} />;
}
