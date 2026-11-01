import { headers } from "next/headers";
import { notFound } from "next/navigation";

import { getSessionUser } from "~/server/auth";

export default async function AdminLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const user = await getSessionUser(await headers());
  if (user?.role !== "Admin") notFound();
  return children;
}
