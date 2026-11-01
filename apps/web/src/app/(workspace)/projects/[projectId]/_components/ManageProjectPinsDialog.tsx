"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import {
  DASHBOARD_LIMITS,
  pinContentInput,
  type ContentKind,
  type PinContentInput,
  type ProjectOverview,
} from "@weaver/core/dashboard/schema";
import { useEffect, useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { toast } from "sonner";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import {
  dataUnlessAccessError,
  queryErrorCode,
} from "~/lib/query-presentation";
import { applyTrpcErrorToForm } from "~/lib/trpcErrors";
import { api } from "~/trpc/react";

export function ManageProjectPinsDialog({
  overview,
  open,
  onOpenChange,
  onRestoreFocus,
}: {
  overview: ProjectOverview;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRestoreFocus?: () => void;
}) {
  const projectId = overview.project.id;
  const utils = api.useUtils();
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [kindFilter, setKindFilter] = useState<ContentKind | "">("");
  const [accessDenied, setAccessDenied] = useState(false);
  const form = useForm<PinContentInput>({
    resolver: zodResolver(pinContentInput),
    defaultValues: { projectId, kind: "document", resourceId: "" },
  });
  const [selectedKind, selectedId] = useWatch({
    control: form.control,
    name: ["kind", "resourceId"],
  });
  useEffect(() => {
    const timer = setTimeout(
      () => setDebounced(search),
      DASHBOARD_LIMITS.pinSearchDebounceMs,
    );
    return () => clearTimeout(timer);
  }, [search]);
  const candidatesQuery = api.dashboard.pinCandidates.useQuery(
    {
      projectId,
      search: debounced,
      ...(kindFilter ? { kind: kindFilter } : {}),
    },
    { enabled: open && overview.canManagePins && !accessDenied, retry: false },
  );
  const candidates = dataUnlessAccessError(
    candidatesQuery.data,
    candidatesQuery.error,
  );
  const invalidate = () => {
    void utils.dashboard.projectOverview.invalidate({ projectId });
    void utils.dashboard.pinCandidates.invalidate({ projectId });
  };
  const pin = api.dashboard.pin.useMutation({
    onSuccess: () => {
      toast.success("Content pinned");
      form.reset({ projectId, kind: "document", resourceId: "" });
      invalidate();
    },
    onError: (error) => {
      applyTrpcErrorToForm(error, (name, detail) =>
        form.setError(name as keyof PinContentInput, detail),
      );
      form.setError("root", {
        message: error.message || "Could not pin content",
      });
      if (
        ["FORBIDDEN", "UNAUTHORIZED", "NOT_FOUND"].includes(
          queryErrorCode(error) ?? "",
        )
      ) {
        setAccessDenied(true);
        invalidate();
      }
    },
  });
  const unpin = api.dashboard.unpin.useMutation({
    onSuccess: () => {
      toast.success("Pin removed");
      invalidate();
    },
    onError: (error) => {
      toast.error(error.message || "Could not remove the pin");
      if (
        ["FORBIDDEN", "UNAUTHORIZED", "NOT_FOUND"].includes(
          queryErrorCode(error) ?? "",
        )
      ) {
        setAccessDenied(true);
        invalidate();
      }
    },
  });
  const busy = pin.isPending || unpin.isPending;
  const unavailable =
    accessDenied ||
    ["FORBIDDEN", "UNAUTHORIZED", "NOT_FOUND"].includes(
      queryErrorCode(candidatesQuery.error) ?? "",
    );
  const selectionVisible =
    search === debounced &&
    !!candidates?.items.some(
      (item) => item.id === selectedId && item.kind === selectedKind,
    );
  if (!overview.canManagePins) return null;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (busy) return;
        if (!next) {
          setAccessDenied(false);
          form.reset({ projectId, kind: "document", resourceId: "" });
        }
        onOpenChange(next);
      }}
    >
      <DialogContent
        showCloseButton={false}
        aria-busy={busy}
        onCloseAutoFocus={(event) => {
          if (onRestoreFocus) {
            event.preventDefault();
            onRestoreFocus();
          }
        }}
        className="max-h-[85vh] overflow-y-auto sm:max-w-xl"
      >
        <DialogHeader>
          <DialogTitle>Manage pinned content</DialogTitle>
          <DialogDescription>
            Shared shortcuts for this project. Removing a pin keeps its content.
          </DialogDescription>
        </DialogHeader>
        {unavailable ? (
          <p role="alert" className="text-danger text-sm">
            Content or access changed. Close this dialog and try again.
          </p>
        ) : (
          <>
            <p className="text-text-3 text-sm">
              {overview.pinCapacity?.used ?? 0} of{" "}
              {DASHBOARD_LIMITS.projectPins} pins used
            </p>
            {overview.pins.length ? (
              <ul aria-label="Current pins" className="space-y-2">
                {overview.pins.map((item) => {
                  const title = item.available
                    ? item.content.title
                    : `Unavailable ${item.kind}`;
                  return (
                    <li
                      key={item.pinId}
                      className="border-line flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm"
                    >
                      <span className="truncate">{title}</span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        aria-label={`Remove ${title}`}
                        onClick={() =>
                          unpin.mutate({ projectId, pinId: item.pinId })
                        }
                      >
                        Remove
                      </Button>
                    </li>
                  );
                })}
              </ul>
            ) : null}
            <form
              className="space-y-3"
              onSubmit={form.handleSubmit((values) => {
                if (selectionVisible) pin.mutate(values);
              })}
              noValidate
            >
              <div className="space-y-1.5">
                <Label htmlFor="pin-search">Search content</Label>
                <Input
                  id="pin-search"
                  value={search}
                  maxLength={DASHBOARD_LIMITS.pinSearchLength}
                  onChange={(event) => {
                    setSearch(event.target.value);
                    form.setValue("resourceId", "");
                    form.clearErrors();
                  }}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="pin-kind">Content type</Label>
                <select
                  id="pin-kind"
                  className="border-input bg-surface text-text h-9 w-full rounded-md border px-2 text-sm"
                  value={kindFilter}
                  onChange={(event) => {
                    setKindFilter(event.target.value as ContentKind | "");
                    form.setValue("resourceId", "");
                    form.clearErrors();
                  }}
                >
                  <option value="">Documents and tables</option>
                  <option value="document">Documents</option>
                  <option value="table">Tables</option>
                </select>
              </div>
              {candidatesQuery.error ? (
                <div role="alert" className="text-text-3 text-sm">
                  <p>
                    {candidates
                      ? "Could not refresh candidates. Showing earlier results."
                      : "Could not load candidates."}
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => void candidatesQuery.refetch()}
                  >
                    Retry
                  </Button>
                </div>
              ) : null}
              {!candidates && candidatesQuery.isLoading ? (
                <p role="status" className="text-text-3 text-sm">
                  Loading content…
                </p>
              ) : null}
              {candidates?.items.length ? (
                <fieldset className="space-y-2">
                  <legend className="text-text-2 mb-2 text-sm font-medium">
                    Choose content to pin
                  </legend>
                  {candidates.items.map((item) => (
                    <label
                      key={`${item.kind}:${item.id}`}
                      className="border-line hover:bg-hover flex cursor-pointer items-center gap-3 rounded-md border px-3 py-2 text-sm"
                    >
                      <input
                        type="radio"
                        name="pin-candidate"
                        value={`${item.kind}:${item.id}`}
                        checked={
                          selectedKind === item.kind && selectedId === item.id
                        }
                        disabled={busy}
                        onChange={() => {
                          form.setValue("kind", item.kind);
                          form.setValue("resourceId", item.id, {
                            shouldValidate: true,
                          });
                          form.clearErrors("root");
                        }}
                      />
                      <span className="min-w-0">
                        <span className="block truncate">{item.title}</span>
                        <span className="text-text-3 text-xs">
                          {item.kind === "document" ? "Document" : "Table"}
                        </span>
                      </span>
                    </label>
                  ))}
                </fieldset>
              ) : candidates ? (
                <p className="text-text-3 text-sm">No matching content.</p>
              ) : null}
              {form.formState.errors.root ? (
                <p role="alert" className="text-danger text-sm">
                  {form.formState.errors.root.message}
                </p>
              ) : null}
              {form.formState.errors.resourceId ? (
                <p role="alert" className="text-danger text-sm">
                  Choose content to pin.
                </p>
              ) : null}
              <div className="flex justify-end">
                <Button type="submit" disabled={busy || !selectionVisible}>
                  {pin.isPending ? "Pinning…" : "Pin"}
                </Button>
              </div>
            </form>
          </>
        )}
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline" disabled={busy}>
              Close
            </Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
