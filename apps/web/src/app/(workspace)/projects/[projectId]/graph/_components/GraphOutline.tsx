"use client";

import { LocateFixed, Network } from "lucide-react";

import { Button } from "~/components/ui/button";
import {
  graphSelectionLabel,
  graphSelectionText,
  orderedGraphEdges,
  orderedGraphNodes,
} from "~/lib/knowledge/graphPresentation";
import type {
  GraphPresentationNode,
  GraphPresentationState,
  GraphSelection,
} from "~/lib/knowledge/graphState";
import { cn } from "~/lib/utils";

export function GraphOutline({
  state,
  seeds,
  seedHeading,
  selection,
  onSelect,
  onFocus,
  onExpand,
  expandDisabled,
  registerSelectionControl,
}: {
  state: GraphPresentationState | null;
  seeds: GraphPresentationNode[];
  seedHeading: string;
  selection?: GraphSelection;
  onSelect: (selection: GraphSelection, requestDetailFocus: boolean) => void;
  onFocus: (node: GraphPresentationNode) => void;
  onExpand: (node: GraphPresentationNode) => void;
  expandDisabled: boolean;
  registerSelectionControl: (
    selection: GraphSelection,
    control: HTMLButtonElement | null,
  ) => void;
}) {
  return (
    <section
      aria-labelledby="graph-outline-heading"
      className="border-line bg-canvas rounded-[10px] border"
    >
      <div className="border-line-faint border-b px-4 py-3">
        <h2
          id="graph-outline-heading"
          className="text-text m-0 text-[15px] font-semibold"
        >
          Graph outline
        </h2>
        <p className="text-text-3 mt-1 mb-0 text-xs">
          Every loaded entity and relation is available as a keyboard-usable
          control.
        </p>
      </div>

      {seeds.length > 0 ? (
        <SeedOutline heading={seedHeading} seeds={seeds} onFocus={onFocus} />
      ) : null}
      {state ? (
        <FocusedOutline
          state={state}
          selection={selection}
          onSelect={onSelect}
          onFocus={onFocus}
          onExpand={onExpand}
          expandDisabled={expandDisabled}
          registerSelectionControl={registerSelectionControl}
        />
      ) : seeds.length === 0 ? (
        <p className="text-text-3 m-0 px-4 py-5 text-sm">
          Choose an entity to load its neighborhood.
        </p>
      ) : null}
    </section>
  );
}

function FocusedOutline({
  state,
  selection,
  onSelect,
  onFocus,
  onExpand,
  expandDisabled,
  registerSelectionControl,
}: {
  state: GraphPresentationState;
  selection?: GraphSelection;
  onSelect: (selection: GraphSelection, requestDetailFocus: boolean) => void;
  onFocus: (node: GraphPresentationNode) => void;
  onExpand: (node: GraphPresentationNode) => void;
  expandDisabled: boolean;
  registerSelectionControl: (
    selection: GraphSelection,
    control: HTMLButtonElement | null,
  ) => void;
}) {
  const nodes = orderedGraphNodes(state);
  const edges = orderedGraphEdges(state);

  return (
    <div className="grid min-w-0 gap-5 p-4 lg:grid-cols-2">
      <section aria-labelledby="graph-outline-entities-heading">
        <h3
          id="graph-outline-entities-heading"
          className="text-text-2 m-0 text-xs font-semibold tracking-wide uppercase"
        >
          Entities ({nodes.length})
        </h3>
        <ul className="mt-2 space-y-2">
          {nodes.map((node) => {
            const selected =
              selection?.kind === "entity" && selection.id === node.entityId;
            const label = graphSelectionLabel(
              { kind: "entity", id: node.entityId },
              state,
            );
            return (
              <li
                key={node.entityId}
                className={cn(
                  "border-line-faint bg-surface rounded-lg border p-3",
                  selected && "border-brand-border ring-brand/30 ring-2",
                )}
              >
                <div className="flex min-w-0 items-start justify-between gap-3">
                  <button
                    ref={(control) =>
                      registerSelectionControl(
                        { kind: "entity", id: node.entityId },
                        control,
                      )
                    }
                    type="button"
                    aria-current={selected ? "true" : undefined}
                    aria-label={`Select ${label}`}
                    onClick={(event) =>
                      onSelect(
                        { kind: "entity", id: node.entityId },
                        event.detail === 0,
                      )
                    }
                    className="focus-visible:ring-ring/50 min-w-0 flex-1 rounded-md text-left outline-none focus-visible:ring-3"
                  >
                    <span className="text-text block truncate text-sm font-medium">
                      {node.canonicalName}
                    </span>
                    <span className="text-text-3 mt-1 block text-xs">
                      {node.entityType} · {node.projectName}
                      {node.entityId === state.focusId ? " · Focus" : ""}
                    </span>
                  </button>
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    aria-label={`Focus ${label}`}
                    disabled={node.entityId === state.focusId}
                    onClick={() => onFocus(node)}
                  >
                    <LocateFixed aria-hidden />
                    Focus
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    aria-label={`Expand ${label}`}
                    disabled={expandDisabled}
                    onClick={() => onExpand(node)}
                  >
                    <Network aria-hidden />
                    Expand
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      </section>

      <section aria-labelledby="graph-outline-relations-heading">
        <h3
          id="graph-outline-relations-heading"
          className="text-text-2 m-0 text-xs font-semibold tracking-wide uppercase"
        >
          Relations ({edges.length})
        </h3>
        {edges.length > 0 ? (
          <ul className="mt-2 space-y-2">
            {edges.map((edge) => {
              const selected =
                selection?.kind === "relation" &&
                selection.id === edge.relationId;
              const label = graphSelectionLabel(
                { kind: "relation", id: edge.relationId },
                state,
              );
              return (
                <li key={edge.relationId}>
                  <button
                    ref={(control) =>
                      registerSelectionControl(
                        { kind: "relation", id: edge.relationId },
                        control,
                      )
                    }
                    type="button"
                    aria-current={selected ? "true" : undefined}
                    aria-label={`Select ${label}`}
                    onClick={(event) =>
                      onSelect(
                        { kind: "relation", id: edge.relationId },
                        event.detail === 0,
                      )
                    }
                    className={cn(
                      "border-line-faint bg-surface focus-visible:ring-ring/50 text-text hover:bg-hover w-full rounded-lg border p-3 text-left text-sm outline-none focus-visible:ring-3",
                      selected && "border-brand-border ring-brand/30 ring-2",
                    )}
                  >
                    {graphSelectionText(
                      { kind: "relation", id: edge.relationId },
                      state,
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-text-3 mt-2 mb-0 text-sm">
            No relations match the active filters.
          </p>
        )}
      </section>
    </div>
  );
}

function SeedOutline({
  heading,
  seeds,
  onFocus,
}: {
  heading: string;
  seeds: GraphPresentationNode[];
  onFocus: (node: GraphPresentationNode) => void;
}) {
  return (
    <section aria-labelledby="graph-seeds-heading" className="p-4">
      <h3
        id="graph-seeds-heading"
        className="text-text-2 m-0 text-xs font-semibold tracking-wide uppercase"
      >
        {heading}
      </h3>
      <ul className="mt-2 grid gap-2 md:grid-cols-2">
        {seeds.map((seed) => (
          <li
            key={`${seed.projectId}:${seed.entityId}`}
            className="border-line-faint bg-surface flex min-w-0 items-center justify-between gap-3 rounded-lg border p-3"
          >
            <span className="min-w-0">
              <span className="text-text block truncate text-sm font-medium">
                {seed.canonicalName}
              </span>
              <span className="text-text-3 mt-1 block text-xs">
                {seed.entityType} · {seed.projectName}
              </span>
            </span>
            <Button
              type="button"
              variant="outline"
              size="xs"
              aria-label={`Focus ${seed.canonicalName}, ${seed.entityType} in ${seed.projectName}. Entity ID ${seed.entityId}.`}
              onClick={() => onFocus(seed)}
            >
              <LocateFixed aria-hidden />
              Focus
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}
