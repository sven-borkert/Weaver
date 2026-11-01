"use client";

import {
  ChevronDown,
  Filter,
  LocateFixed,
  Maximize2,
  Network,
  RotateCcw,
} from "lucide-react";

import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import type { GraphPresentationNode } from "~/lib/knowledge/graphState";
import { cn } from "~/lib/utils";
import type { RouterOutputs } from "~/trpc/react";

type ProjectList = RouterOutputs["project"]["list"];

export function GraphToolbar({
  projects,
  selectedProjectIds,
  entityTypes,
  selectedEntityTypes,
  relationTypes,
  selectedRelationTypes,
  onProjectIdsChange,
  onEntityTypesChange,
  onRelationTypesChange,
  focusedNode,
  selectedNode,
  expansionAtCapacity,
  graphActionLoading,
  hasGraph,
  canvasReady,
  onFocus,
  onExpand,
  onReset,
  onFit,
  mode = "all",
  className,
}: {
  projects: ProjectList;
  selectedProjectIds: string[];
  entityTypes: string[];
  selectedEntityTypes: string[];
  relationTypes: string[];
  selectedRelationTypes: string[];
  onProjectIdsChange: (projectIds: string[]) => void;
  onEntityTypesChange: (entityTypes: string[]) => void;
  onRelationTypesChange: (relationTypes: string[]) => void;
  focusedNode?: GraphPresentationNode;
  selectedNode?: GraphPresentationNode;
  expansionAtCapacity: boolean;
  graphActionLoading: boolean;
  hasGraph: boolean;
  canvasReady: boolean;
  onFocus: (node: GraphPresentationNode) => void;
  onExpand: (node: GraphPresentationNode) => void;
  onReset: () => void;
  onFit: () => void;
  mode?: "all" | "filters" | "actions";
  className?: string;
}) {
  const selectedProjects = new Set(selectedProjectIds);
  const selectedEntities = new Set(selectedEntityTypes);
  const selectedRelations = new Set(selectedRelationTypes);
  const showFilters = mode !== "actions";
  const showActions = mode !== "filters";

  return (
    <div
      role="group"
      aria-label={mode === "actions" ? "Graph actions" : "Graph filters"}
      className={cn(
        "border-line-faint flex flex-wrap items-center gap-2 border-b px-4 py-3",
        className,
      )}
    >
      {showFilters ? (
        <>
          <Filter className="text-text-muted size-4" aria-hidden />
          <GraphFilterMenu
            label="Projects"
            summary={selectionSummary(selectedProjectIds.length, "project")}
            options={projects.map((project) => ({
              value: project.id,
              label: project.name,
            }))}
            selected={selectedProjects}
            limit={50}
            onChange={onProjectIdsChange}
          />
          <GraphFilterMenu
            label="Entity types"
            summary={selectionSummary(
              selectedEntityTypes.length,
              "entity type",
            )}
            options={entityTypes.map((value) => ({ value, label: value }))}
            selected={selectedEntities}
            limit={20}
            onChange={onEntityTypesChange}
          />
          <GraphFilterMenu
            label="Relation types"
            summary={selectionSummary(
              selectedRelationTypes.length,
              "relation type",
            )}
            options={relationTypes.map((value) => ({
              value,
              label: value.replaceAll("_", " "),
            }))}
            selected={selectedRelations}
            limit={20}
            onChange={onRelationTypesChange}
          />
        </>
      ) : null}
      {showFilters && showActions ? (
        <span className="border-line-faint mx-1 h-6 border-l" aria-hidden />
      ) : null}
      {showActions ? (
        <>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={
              graphActionLoading ||
              !selectedNode ||
              selectedNode.entityId === focusedNode?.entityId
            }
            onClick={() => selectedNode && onFocus(selectedNode)}
          >
            <LocateFixed aria-hidden />
            Focus
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={
              graphActionLoading || !selectedNode || expansionAtCapacity
            }
            title={
              expansionAtCapacity
                ? "The graph reached the 100-entity or 200-relation canvas limit."
                : undefined
            }
            onClick={() => selectedNode && onExpand(selectedNode)}
          >
            <Network aria-hidden />
            Expand
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!hasGraph || graphActionLoading}
            onClick={onReset}
          >
            <RotateCcw aria-hidden />
            Reset
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!hasGraph || !canvasReady}
            title={
              hasGraph && !canvasReady
                ? "Fit becomes available when the visual graph is ready."
                : undefined
            }
            onClick={onFit}
          >
            <Maximize2 aria-hidden />
            Fit
          </Button>
          {expansionAtCapacity ? (
            <span className="text-text-3 text-xs">
              Expand unavailable at 100 entities or 200 relations. Focus remains
              available.
            </span>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function GraphFilterMenu({
  label,
  summary,
  options,
  selected,
  limit,
  onChange,
}: {
  label: string;
  summary: string;
  options: Array<{ value: string; label: string }>;
  selected: Set<string>;
  limit: number;
  onChange: (values: string[]) => void;
}) {
  const update = (value: string, checked: boolean) => {
    const next = new Set(selected);
    if (checked) next.add(value);
    else next.delete(value);
    onChange([...next].sort().slice(0, limit));
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-label={`${label}: ${summary}`}
        >
          <span>{summary}</span>
          <ChevronDown aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-56">
        <DropdownMenuLabel>{label}</DropdownMenuLabel>
        {options.length === 0 ? (
          <p className="text-text-3 m-0 px-2 py-1.5 text-xs">
            No options available
          </p>
        ) : (
          options.map((option) => {
            const checked = selected.has(option.value);
            return (
              <DropdownMenuCheckboxItem
                key={option.value}
                checked={checked}
                disabled={!checked && selected.size >= limit}
                onCheckedChange={(nextChecked) =>
                  update(option.value, nextChecked === true)
                }
                onSelect={(event) => event.preventDefault()}
              >
                <span className="truncate">{option.label}</span>
              </DropdownMenuCheckboxItem>
            );
          })
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function selectionSummary(count: number, noun: string) {
  if (count === 0) return `All ${noun}s`;
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
