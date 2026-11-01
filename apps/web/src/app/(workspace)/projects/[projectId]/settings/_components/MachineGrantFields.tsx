"use client";

import { useDeferredValue, useState } from "react";

import { MACHINE_TARGET_KINDS } from "@weaver/core/projectApi/constants";
import type { GrantInput } from "@weaver/core/projectApi/schemas";
import type { MachineTargetKind } from "@weaver/core/projectApi/types";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import {
  MACHINE_ACTION_LABELS,
  MACHINE_TARGET_KIND_LABELS,
  applicableMachineActions,
} from "~/lib/project-api/policy";
import { dataUnlessAccessError } from "~/lib/query-presentation";
import { api } from "~/trpc/react";

export const MAX_MACHINE_GRANTS = 100;

export type GrantTargetDisplay = {
  label: string;
  location: string;
  available: boolean;
};

type TargetChoice = {
  kind: MachineTargetKind;
  targetId?: string;
  root?: true;
  path?: string[];
};

export const grantIdentity = (grant: TargetChoice) =>
  `${grant.kind}:${grant.root ? "root" : (grant.targetId ?? `path:${grant.path?.join("/")}`)}`;

const ROOT_LABELS: Partial<Record<MachineTargetKind, string>> = {
  documentFolder: "All documents (documents root)",
  tableFolder: "All tables (tables root)",
};

const KIND_PLURALS: Record<MachineTargetKind, string> = {
  document: "Documents",
  documentFolder: "Document folders",
  table: "Tables",
  tableFolder: "Table folders",
};

/** Target picker plus per-grant independent actions; selections expand into individual grants. */
export function MachineGrantFields({
  projectId,
  value,
  onChange,
  disabled,
  known,
  invalidGrants,
}: {
  projectId: string;
  value: GrantInput[];
  onChange: (value: GrantInput[]) => void;
  disabled: boolean;
  known: ReadonlyMap<string, GrantTargetDisplay>;
  invalidGrants: ReadonlySet<number>;
}) {
  const [kind, setKind] = useState<MachineTargetKind>("documentFolder");
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search.trim());
  const [picked, setPicked] = useState<ReadonlyMap<string, GrantTargetDisplay>>(
    () => new Map(),
  );
  const query = api.projectApiKey.targets.useInfiniteQuery(
    { projectId, kind, search: deferredSearch || undefined, limit: 50 },
    { getNextPageParam: (page) => page.nextCursor ?? undefined },
  );
  const pages = dataUnlessAccessError(query.data, query.error);
  const targets = pages?.pages.flatMap((page) => page.items) ?? [];
  const selected = new Set(value.map(grantIdentity));
  const display = (grant: GrantInput): GrantTargetDisplay => {
    const identity = grantIdentity(grant);
    if (grant.root)
      return { label: ROOT_LABELS[grant.kind]!, location: "", available: true };
    return (
      picked.get(identity) ??
      known.get(identity) ?? {
        label: grant.path?.join("/") ?? "Selected target",
        location: "",
        available: true,
      }
    );
  };

  function toggleTarget(target: (typeof targets)[number]) {
    const identity = grantIdentity(target);
    if (selected.has(identity)) {
      onChange(value.filter((grant) => grantIdentity(grant) !== identity));
      return;
    }
    setPicked((current) =>
      new Map(current).set(identity, {
        label: target.root ? ROOT_LABELS[target.kind]! : target.label,
        location: target.location,
        available: true,
      }),
    );
    const choice: GrantInput = target.root
      ? { kind: target.kind, root: true, actions: [] }
      : target.targetId
        ? { kind: target.kind, targetId: target.targetId, actions: [] }
        : { kind: target.kind, path: target.path!, actions: [] };
    onChange([...value, choice]);
  }

  function toggleAction(index: number, action: GrantInput["actions"][number]) {
    onChange(
      value.map((grant, position) =>
        position !== index
          ? grant
          : {
              ...grant,
              actions: grant.actions.includes(action)
                ? grant.actions.filter((a) => a !== action)
                : applicableMachineActions(grant.kind).filter(
                    (a) => a === action || grant.actions.includes(a),
                  ),
            },
      ),
    );
  }

  return (
    <fieldset className="flex min-w-0 flex-col gap-3" disabled={disabled}>
      <legend className="text-text mb-1 text-[13px] font-medium">
        Permissions
      </legend>
      <p className="text-text-3 m-0 text-[12px]">
        Read, Create, Update and Delete are independent; none is selected for
        you. Folder permissions include every subfolder and content added later.
      </p>
      <div className="grid gap-3 sm:grid-cols-[12rem_1fr]">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="machine-grant-kind">Target type</Label>
          <Select
            value={kind}
            disabled={disabled}
            onValueChange={(next) => {
              setKind(next as MachineTargetKind);
              setSearch("");
            }}
          >
            <SelectTrigger id="machine-grant-kind" className="w-full">
              <SelectValue>{KIND_PLURALS[kind]}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {MACHINE_TARGET_KINDS.map((option) => (
                <SelectItem key={option} value={option}>
                  {KIND_PLURALS[option]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="machine-grant-search">Search</Label>
          <Input
            id="machine-grant-search"
            placeholder="Filter by name or path"
            value={search}
            disabled={disabled}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
      </div>
      <div
        role="group"
        aria-label={`Available ${KIND_PLURALS[kind].toLowerCase()}`}
        className="border-border flex max-h-52 flex-col gap-1 overflow-auto rounded-lg border p-2"
      >
        {query.isLoading ? (
          <p className="text-text-3 m-0 text-[12px]">Loading targets…</p>
        ) : null}
        {query.error && !pages ? (
          <p role="alert" className="text-danger m-0 text-[12px]">
            Could not load targets.{" "}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void query.refetch()}
            >
              Retry
            </Button>
          </p>
        ) : null}
        {pages && targets.length === 0 ? (
          <p className="text-text-3 m-0 text-[12px]">No matching targets.</p>
        ) : null}
        {targets.map((target) => {
          const identity = grantIdentity(target);
          const isSelected = selected.has(identity);
          return (
            <label
              key={identity}
              className="text-text flex items-center gap-2 py-0.5 text-[13px]"
            >
              <input
                type="checkbox"
                checked={isSelected}
                disabled={
                  disabled ||
                  (!isSelected && value.length >= MAX_MACHINE_GRANTS)
                }
                onChange={() => toggleTarget(target)}
              />
              <span className="min-w-0 truncate">
                {target.root ? ROOT_LABELS[target.kind] : target.label}
              </span>
              {target.location && target.location !== target.label ? (
                <span className="text-text-3 min-w-0 truncate text-[12px]">
                  {target.location}
                </span>
              ) : null}
            </label>
          );
        })}
        {query.hasNextPage ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled || query.isFetchingNextPage}
            onClick={() => void query.fetchNextPage()}
          >
            {query.isFetchingNextPage ? "Loading…" : "More targets"}
          </Button>
        ) : null}
      </div>
      {value.length === 0 ? (
        <p className="text-text-3 m-0 text-[12px]">
          Select at least one target above.
        </p>
      ) : null}
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {value.map((grant, index) => {
          const target = display(grant);
          return (
            <li
              key={grantIdentity(grant)}
              className="border-border flex flex-col gap-2 rounded-lg border p-3"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-text text-[13px] font-medium break-words">
                    {target.label}
                  </div>
                  <div className="text-text-3 text-[12px] break-words">
                    {MACHINE_TARGET_KIND_LABELS[grant.kind]}
                    {target.location ? ` · ${target.location}` : ""}
                    {grant.kind.endsWith("Folder")
                      ? " · includes subfolders and future content"
                      : ""}
                  </div>
                  {!target.available ? (
                    <div className="text-danger text-[12px]">
                      Unavailable: grants nothing until this exact item exists
                      again.
                    </div>
                  ) : null}
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={disabled}
                  aria-label={`Remove ${target.label}`}
                  onClick={() =>
                    onChange(value.filter((_, position) => position !== index))
                  }
                >
                  Remove
                </Button>
              </div>
              <div className="flex flex-wrap gap-4">
                {applicableMachineActions(grant.kind).map((action) => (
                  <label
                    key={action}
                    className="text-text flex items-center gap-1.5 text-[13px]"
                  >
                    <input
                      type="checkbox"
                      checked={grant.actions.includes(action)}
                      disabled={disabled}
                      onChange={() => toggleAction(index, action)}
                    />
                    {MACHINE_ACTION_LABELS[action]}
                  </label>
                ))}
              </div>
              {invalidGrants.has(index) ? (
                <p className="text-danger m-0 text-[12px]">
                  Choose at least one action.
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>
    </fieldset>
  );
}
