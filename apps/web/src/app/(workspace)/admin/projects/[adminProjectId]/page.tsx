import { ProjectAdminDetailPage } from "./_components/ProjectAdminDetailPage";

export const metadata = { title: "Project · Administration · Weaver" };

export default async function AdminProjectDetailRoute({
  params,
}: {
  params: Promise<{ adminProjectId: string }>;
}) {
  const { adminProjectId } = await params;
  return (
    <ProjectAdminDetailPage key={adminProjectId} projectId={adminProjectId} />
  );
}
