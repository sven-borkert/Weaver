"use client";

import {
  Cable,
  CalendarClock,
  Activity,
  ChevronDown,
  KeyRound,
  Lock,
  LogOut,
  Plug,
  RefreshCw,
  Server,
} from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";
import { authClient } from "~/lib/authClient";
import { withBasePath } from "~/lib/basePath";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { Skeleton } from "~/components/ui/skeleton";
import { resolveQueryPresentation } from "~/lib/query-presentation";
import {
  confirmNavigation,
  suppressUnsavedPrompt,
} from "~/lib/use-unsaved-changes-guard";
import { api } from "~/trpc/react";

function initialsOf(name: string | null | undefined): string {
  const words = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  return words
    .slice(0, 2)
    .map((word) => word.charAt(0).toUpperCase())
    .join("");
}

function UserAvatar({
  name,
  loading,
}: {
  name?: string | null;
  loading: boolean;
}) {
  return (
    <span className="bg-brand-bg text-brand-text flex size-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold">
      {loading ? (
        <Skeleton className="size-6 rounded-full" />
      ) : (
        initialsOf(name)
      )}
    </span>
  );
}

export async function signOutWithGuard(): Promise<void> {
  const loginHref = withBasePath("/login");
  if (!confirmNavigation(loginHref)) return;
  // The discard is already confirmed; a second native prompt could strand a signed-out page.
  const restorePrompt = suppressUnsavedPrompt();
  try {
    const result = await authClient.signOut();
    if (!result.error) {
      window.location.replace(loginHref);
      return;
    }
  } catch {
    // reported below
  }
  restorePrompt();
  toast.error("Could not sign out");
}

const FAILED_NAME = "Account unavailable";
const FAILED_DETAIL = "Could not load your account";

export function UserMenu() {
  const meQuery = api.account.me.useQuery();
  const me = meQuery.data;
  const presentation = resolveQueryPresentation(meQuery);
  const failed = presentation === "error";
  const loading = presentation === "loading" || presentation === "empty";
  const name = failed ? FAILED_NAME : (me?.name ?? "—");
  const detail = failed ? FAILED_DETAIL : (me?.email ?? "—");

  return (
    <DropdownMenu>
      <div className="flex items-center gap-0.5">
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="User menu"
            className="hover:bg-hover flex items-center gap-1.5 rounded-[6px] px-1.5 py-1"
          >
            <UserAvatar name={me?.name} loading={loading} />
            <ChevronDown className="text-text-3 size-3.5 shrink-0" />
          </button>
        </DropdownMenuTrigger>
        {failed ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Retry loading account"
            title="Retry loading account"
            className="text-text-3 hover:text-text shrink-0"
            onClick={() => void meQuery.refetch()}
          >
            <RefreshCw />
          </Button>
        ) : null}
      </div>
      <DropdownMenuContent className="w-64" side="bottom" align="end">
        <div className="px-2.5 py-2">
          <div className="text-text text-[13px] font-medium">{name}</div>
          <div className="text-text-3 mt-0.5 text-[12px]">{detail}</div>
          {me?.role ? (
            <Badge variant="secondary" className="mt-1.5">
              {me.role}
            </Badge>
          ) : null}
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/account/password">
            <Lock />
            Password
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link href="/account/api-keys">
            <KeyRound />
            API keys
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link href="/account/connected-apps">
            <Plug />
            Connected apps
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link href="/account/connections">
            <Cable />
            MCP connections
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link href="/account/remote-instances">
            <Server />
            Remote instances
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link href="/account/tasks">
            <CalendarClock />
            Tasks
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link href="/account/background-work">
            <Activity />
            Background work
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void signOutWithGuard()}>
          <LogOut />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
