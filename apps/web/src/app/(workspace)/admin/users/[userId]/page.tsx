import { UserDetailPage } from "./_components/UserDetailPage";

export const metadata = { title: "User · Administration · Weaver" };

export default async function AdminUserDetailPage({
  params,
}: {
  params: Promise<{ userId: string }>;
}) {
  const { userId } = await params;
  return <UserDetailPage key={userId} userId={userId} />;
}
