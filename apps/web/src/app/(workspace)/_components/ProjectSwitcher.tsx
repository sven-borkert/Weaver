"use client";

import { Check, ChevronsUpDown, FolderKanban } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { Input } from "~/components/ui/input";
import { Skeleton } from "~/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "~/components/ui/tooltip";
import { withBasePath } from "~/lib/basePath";
import { useActiveProjectId } from "~/lib/navigation/use-active-project-id";
import {
  filterProjects,
  PROJECT_FILTER_THRESHOLD,
  projectSwitchDestination,
} from "~/lib/navigation/project-switch";
import {
  dataUnlessAccessError,
  resolveQueryPresentation,
} from "~/lib/query-presentation";
import { confirmNavigation } from "~/lib/use-unsaved-changes-guard";
import { cn } from "~/lib/utils";
import { api } from "~/trpc/react";
import { CreateProjectDialog } from "./CreateProjectDialog";

export function ProjectSwitcher({
  collapsed = false,
}: {
  collapsed?: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const { projectId, fromRoute } = useActiveProjectId();
  const [filter, setFilter] = useState("");
  const [open, setOpen] = useState(false);
  const projectQuery = api.project.get.useQuery(
    { projectId: projectId ?? "" },
    { enabled: Boolean(projectId) },
  );
  const listQuery = api.project.list.useQuery();
  const current = dataUnlessAccessError(projectQuery.data, projectQuery.error);
  const projects = dataUnlessAccessError(listQuery.data, listQuery.error);
  const presentation = resolveQueryPresentation(listQuery);
  const hasFilter = filter.trim().length > 0;
  const visible = filterProjects(projects ?? [], filter);
  const showFilter = (projects?.length ?? 0) > PROJECT_FILTER_THRESHOLD;

  let label: React.ReactNode = "Projects";
  if (projectId && projectQuery.isLoading)
    label = <Skeleton className="h-4 w-28" />;
  else if (projectId && current) label = current.name;

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) setFilter("");
      }}
    >
      {collapsed ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="icon-sm"
                aria-label="Switch project"
                className="bg-surface text-text-2 shrink-0"
              >
                <FolderKanban className="size-4" aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="right">Switch project</TooltipContent>
        </Tooltip>
      ) : (
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="outline"
            aria-label="Switch project"
            className="bg-surface text-text w-full min-w-0 justify-start gap-2 px-2.5 text-[13px] font-medium"
          >
            <FolderKanban
              className="text-text-3 size-4 shrink-0"
              aria-hidden="true"
            />
            <span className="min-w-0 flex-1 truncate text-left">{label}</span>
            <ChevronsUpDown
              className="text-text-3 size-3.5 shrink-0"
              aria-hidden="true"
            />
          </Button>
        </DropdownMenuTrigger>
      )}
      <DropdownMenuContent
        align="start"
        side={collapsed ? "right" : "bottom"}
        className="w-64"
      >
        <DropdownMenuLabel>Projects</DropdownMenuLabel>
        {showFilter ? (
          <div className="px-2 pb-1">
            <FilterInput
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              onKeyDown={(event) => {
                // Keep typeahead/roving-focus keys local; let Escape/Enter/Tab reach Radix.
                if (
                  event.key.length === 1 ||
                  event.key === "Home" ||
                  event.key === "End"
                ) {
                  event.stopPropagation();
                  return;
                }
                // Radix only moves focus between items, so hand the first/last item over explicitly.
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  const items = event.currentTarget
                    .closest("[data-radix-menu-content]")
                    ?.querySelectorAll<HTMLElement>(
                      '[role="menuitem"]:not([data-disabled])',
                    );
                  const target =
                    event.key === "ArrowDown"
                      ? items?.[0]
                      : items?.[items.length - 1];
                  if (target) {
                    event.preventDefault();
                    event.stopPropagation();
                    target.focus();
                  }
                }
              }}
              placeholder="Filter projects"
              aria-label="Filter projects"
              className="h-7 text-[13px]"
            />
          </div>
        ) : null}
        {presentation === "loading" ? (
          <DropdownMenuItem disabled>Loading…</DropdownMenuItem>
        ) : presentation === "error" ? (
          <DropdownMenuItem onSelect={() => void listQuery.refetch()}>
            Could not load projects — retry
          </DropdownMenuItem>
        ) : visible.length === 0 ? (
          <DropdownMenuItem disabled>
            {hasFilter ? "No matching projects" : "No projects yet"}
          </DropdownMenuItem>
        ) : (
          visible.map((project) => {
            const isCurrent = fromRoute && project.id === projectId;
            return (
              <DropdownMenuItem
                key={project.id}
                aria-current={isCurrent ? "true" : undefined}
                className={cn(isCurrent && "bg-brand-bg text-brand-text")}
                onSelect={() => {
                  if (isCurrent) return;
                  const href = projectSwitchDestination(
                    pathname,
                    project.id,
                    project.myRole,
                  );
                  if (!confirmNavigation(withBasePath(href))) return;
                  router.push(href);
                }}
              >
                <span className="truncate">{project.name}</span>
                {project.personalOwnerId ? (
                  <span className="text-text-3 ml-2 text-[11px]">Personal</span>
                ) : null}
                {isCurrent ? (
                  <Check className="ml-auto size-4" aria-hidden="true" />
                ) : null}
              </DropdownMenuItem>
            );
          })
        )}
        <DropdownMenuSeparator />
        <div className="px-1 py-0.5 [&_button]:w-full [&_button]:justify-start">
          <CreateProjectDialog
            onOpenChange={(dialogOpen) => {
              // Closing the nested dialog must also close the menu, or it reappears underneath.
              if (!dialogOpen) setOpen(false);
            }}
          />
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function FilterInput(props: React.ComponentProps<typeof Input>) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    // Radix focuses the menu content in its own mount effect; take focus back after it ran.
    const id = window.setTimeout(() => ref.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, []);
  return <Input ref={ref} {...props} />;
}
