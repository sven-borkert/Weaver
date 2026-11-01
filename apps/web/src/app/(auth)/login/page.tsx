import { Suspense } from "react";
import { connection } from "next/server";
import { getOidcLoginPresentation } from "~/server/oidc";

import { LoginForm } from "./LoginForm";

export default async function LoginPage() {
  await connection();
  const oidc = await getOidcLoginPresentation().catch(() => null);
  return (
    <main className="flex min-h-screen items-center justify-center p-4 sm:p-8">
      <Suspense fallback={null}>
        <LoginForm oidcDisplayName={oidc?.displayName} />
      </Suspense>
    </main>
  );
}
