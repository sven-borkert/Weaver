import { redirect } from "next/navigation";

/** The former Outside Git area: untracked documents now live in the documents explorer. */
export default async function LocalDocumentsPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  redirect(`/projects/${projectId}/documents`);
}
