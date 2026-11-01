import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { db } from "@weaver/db";
import { resolveLandingProjectId } from "@weaver/core/services/landingProject";
import { captureError } from "@weaver/core/diagnostics/writer";

import { getSessionUser } from "~/server/auth";

export default async function RootPage() {
  const user = await getSessionUser(await headers());
  // The (workspace) layout already redirected anonymous visitors to /login.
  if (!user) redirect("/login");

  let projectId: string | null;
  try {
    projectId = await resolveLandingProjectId(db, user.id);
  } catch (error) {
    captureError({
      event: "landing.workspace_failed",
      message: "failed to resolve the landing project for a signed-in user",
      error,
      userId: user.id,
    });
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-2 p-8 text-center">
        <h1 className="text-lg font-semibold">Could not open your workspace</h1>
        <p className="text-text-2">
          Something went wrong while loading your projects — please try again.
        </p>
        <Link href="/" className="text-brand-text underline">
          Try again
        </Link>
      </main>
    );
  }
  if (!projectId) redirect("/login");
  redirect(`/projects/${projectId}/documents`);
}
