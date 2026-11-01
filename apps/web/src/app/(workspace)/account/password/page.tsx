import { headers } from "next/headers";

import { getSessionUser } from "~/server/auth";
import { ChangePasswordCard } from "./_components/ChangePasswordCard";

export default async function AccountPasswordPage() {
  const user = await getSessionUser(await headers());
  return (
    <div className="flex w-full flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-text m-0 text-[20px] font-semibold">Password</h1>
        <p className="text-text-3 m-0 text-[13px]">
          Change the password used to sign in.
        </p>
      </div>
      <ChangePasswordCard forced={user?.mustChangePassword ?? false} />
    </div>
  );
}
