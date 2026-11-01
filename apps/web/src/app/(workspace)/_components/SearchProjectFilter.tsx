"use client";

import { ChevronDown, FolderSearch } from "lucide-react";

import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { normalizeGlobalSearchProjectIds } from "~/lib/knowledge/globalSearch";
import type { RouterOutputs } from "~/trpc/react";

type ProjectList = RouterOutputs["project"]["list"];

type SearchProjectFilterProps = {
  projects: ProjectList;
  selectedProjectIds: string[] | undefined;
  onChange: (projectIds: string[] | undefined) => void;
  disabled?: boolean;
};

const DESCRIPTION_ID = "global-search-project-filter-description";

export function SearchProjectFilter({
  projects,
  selectedProjectIds,
  onChange,
  disabled = false,
}: SearchProjectFilterProps) {
  const selected = new Set(selectedProjectIds ?? []);
  const atLimit = selected.size >= 50;
  const label = selectedProjectIds
    ? `${selectedProjectIds.length} project${selectedProjectIds.length === 1 ? "" : "s"}`
    : "All projects";

  const updateProjectIds = (nextIds: readonly string[]) => {
    const canonical = normalizeGlobalSearchProjectIds(nextIds);
    onChange(canonical?.slice(0, 50));
  };

  const updateProject = (projectId: string, checked: boolean) => {
    const nextIds = new Set(selectedProjectIds ?? []);
    if (checked) nextIds.add(projectId);
    else nextIds.delete(projectId);
    updateProjectIds([...nextIds]);
  };

  return (
    <>
      <span id={DESCRIPTION_ID} className="sr-only">
        Limit search to up to 50 accessible projects.
      </span>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled}
            aria-label={`Search scope: ${label}`}
            aria-describedby={DESCRIPTION_ID}
            className="max-w-48 shrink-0"
          >
            <FolderSearch aria-hidden />
            <span className="truncate">{label}</span>
            <ChevronDown aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="max-h-80 min-w-64">
          <DropdownMenuLabel>Search projects</DropdownMenuLabel>
          <DropdownMenuCheckboxItem
            checked={selectedProjectIds === undefined}
            onCheckedChange={() => updateProjectIds([])}
            onSelect={(event) => event.preventDefault()}
          >
            All accessible projects
          </DropdownMenuCheckboxItem>
          {projects.length > 0 ? <DropdownMenuSeparator /> : null}
          {projects.map((project) => {
            const checked =
              selectedProjectIds !== undefined && selected.has(project.id);
            return (
              <DropdownMenuCheckboxItem
                key={project.id}
                checked={checked}
                disabled={!checked && atLimit}
                onCheckedChange={(nextChecked) =>
                  updateProject(project.id, nextChecked === true)
                }
                onSelect={(event) => event.preventDefault()}
              >
                <span className="truncate">{project.name}</span>
              </DropdownMenuCheckboxItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}
