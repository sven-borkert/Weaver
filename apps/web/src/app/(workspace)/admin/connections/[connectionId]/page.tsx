import { redirect } from "next/navigation";

export default async function AdminConnectionRedirect({
  params,
}: {
  params: Promise<{ connectionId: string }>;
}) {
  redirect(`/account/connections/${(await params).connectionId}`);
}
