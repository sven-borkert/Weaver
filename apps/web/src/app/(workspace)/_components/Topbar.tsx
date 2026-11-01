"use client";

import { Search, Sparkles } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";

import { useAssistant } from "~/components/assistant/AssistantProvider";
import { BackgroundWorkBell } from "~/components/background-work/BackgroundWorkBell";
import { Button } from "~/components/ui/button";
import { Separator } from "~/components/ui/separator";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "~/components/ui/tooltip";
import { confirmNavigation } from "~/lib/use-unsaved-changes-guard";
import { withBasePath } from "~/lib/basePath";
import { useMounted } from "~/lib/use-mounted";
import { ThemeToggle } from "./ThemeToggle";
import { UserMenu } from "./UserMenu";
import { WorkspaceBreadcrumbs } from "./WorkspaceBreadcrumbs";
import { MobileNavigation } from "./MobileNavigation";

type TopbarProps = {
  searchTriggerRef: React.RefObject<HTMLButtonElement | null>;
  onOpenSearch(): void;
  assistantTriggerRef: React.RefObject<HTMLButtonElement | null>;
};

export function Topbar(props: TopbarProps) {
  const { searchTriggerRef } = props;
  const pathname = usePathname();
  const mounted = useMounted();
  const isMacLike =
    mounted && /Mac|iPhone|iPad|iPod/.test(window.navigator.platform);

  return (
    <header className="bg-surface border-line flex min-h-(--topbar-h) shrink-0 flex-wrap items-center justify-between gap-x-2 gap-y-1 border-b px-2 py-1.5 sm:px-4">
      <MobileNavigation key={pathname} />
      <div className="min-w-0 flex-1 overflow-x-auto [&_ol]:flex-nowrap [&_ol]:whitespace-nowrap">
        <WorkspaceBreadcrumbs />
      </div>

      <div className="flex shrink-0 items-center gap-1 sm:gap-2">
        <Button
          ref={searchTriggerRef}
          type="button"
          variant="outline"
          size="sm"
          aria-label="Search knowledge"
          onClick={() => props.onOpenSearch()}
          className="text-text-2 size-7 justify-center p-0 sm:h-7 sm:w-40 sm:justify-start sm:px-2.5 lg:w-64 2xl:w-80"
        >
          <Search className="text-text-muted" aria-hidden />
          <span className="hidden sm:inline">Search</span>
          {mounted ? (
            <kbd className="border-line bg-subtle text-text-muted ml-auto hidden rounded border px-1.5 py-0.5 font-sans text-[10px] leading-none sm:inline">
              {isMacLike ? "⌘K" : "Ctrl K"}
            </kbd>
          ) : null}
        </Button>

        <AssistantToggle
          triggerRef={props.assistantTriggerRef}
          isMacLike={isMacLike}
        />

        <BackgroundWorkBell />

        <ThemeToggle />

        <Separator orientation="vertical" className="hidden h-5 sm:block" />

        <UserMenu />
      </div>
    </header>
  );
}

function AssistantToggle({
  triggerRef,
  isMacLike,
}: {
  triggerRef: React.RefObject<HTMLButtonElement | null>;
  isMacLike: boolean;
}) {
  const { open, toggle, setOpen, unseenCompletion } = useAssistant();
  const router = useRouter();
  const pathname = usePathname();
  const onRoute = pathname.startsWith("/assistant");
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          ref={triggerRef}
          type="button"
          variant={open || onRoute ? "secondary" : "ghost"}
          size="icon-sm"
          aria-label="Assistant"
          aria-pressed={open || onRoute}
          className="relative"
          onClick={() => {
            if (onRoute) {
              if (!confirmNavigation(withBasePath("/"))) return;
              setOpen(true);
              router.push("/");
              return;
            }
            toggle();
          }}
        >
          <Sparkles className="size-4" aria-hidden="true" />
          {unseenCompletion ? (
            <span
              aria-hidden="true"
              className="bg-brand absolute top-1 right-1 size-1.5 rounded-full"
            />
          ) : null}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        Assistant ({isMacLike ? "⌘J" : "Ctrl J"})
      </TooltipContent>
    </Tooltip>
  );
}
