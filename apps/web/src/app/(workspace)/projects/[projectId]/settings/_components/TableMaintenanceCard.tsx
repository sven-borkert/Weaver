"use client";

import { useState } from "react";
import { toast } from "sonner";

import { Button } from "~/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { invalidateTableCaches } from "~/lib/tables/table-cache-invalidation";
import { api, type RouterOutputs } from "~/trpc/react";

type RebuildResult = RouterOutputs["table"]["rebuildIndex"];

export function TableMaintenanceCard({ projectId }: { projectId: string }) {
  const utils = api.useUtils();
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<RebuildResult>();
  const [rebuildError, setRebuildError] = useState<string>();
  const rebuildIndex = api.table.rebuildIndex.useMutation({
    onSuccess: async (nextResult) => {
      setResult(nextResult);
      setRebuildError(undefined);
      await invalidateTableCaches(utils, projectId);
      toast.success(
        nextResult.skipped.length
          ? `Indexed ${nextResult.indexed} tables; skipped ${nextResult.skipped.length}`
          : `Indexed ${nextResult.indexed} tables`,
      );
    },
    onError: (err) => {
      const message = err.message || "Could not rebuild the table index";
      setRebuildError(message);
      toast.error(message);
    },
  });

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Table index</CardTitle>
          <CardDescription>
            Rebuild the table index from the project&apos;s Git content.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex items-center justify-between gap-3">
          <p className="text-text-2 m-0 max-w-[420px] text-[13px]">
            Use this when table metadata is out of sync. Rebuilding never
            changes Git content or creates a commit.
          </p>
          <Button
            variant="outline"
            onClick={() => {
              setResult(undefined);
              setRebuildError(undefined);
              setOpen(true);
            }}
          >
            Rebuild index
          </Button>
        </CardContent>
      </Card>

      <Dialog
        open={open}
        onOpenChange={(nextOpen) => {
          if (!rebuildIndex.isPending) setOpen(nextOpen);
        }}
      >
        <DialogContent
          showCloseButton={!rebuildIndex.isPending}
          aria-busy={rebuildIndex.isPending}
        >
          <DialogHeader>
            <DialogTitle>Rebuild table index</DialogTitle>
            <DialogDescription>
              This reads the current Git content and replaces the derived table
              index. Git content is not changed.
            </DialogDescription>
          </DialogHeader>
          {result ? (
            <div className="flex flex-col gap-2">
              <p className="text-text m-0 text-[13px]">
                Indexed {result.indexed} table
                {result.indexed === 1 ? "" : "s"}.
              </p>
              {result.skipped.length ? (
                <ul className="border-line max-h-48 overflow-y-auto rounded-[6px] border p-2">
                  {result.skipped.map((skipped) => (
                    <li
                      key={`${skipped.path}:${skipped.reason}`}
                      className="text-text-2 py-1 text-[12px]"
                    >
                      <span className="font-medium">{skipped.path || "/"}</span>
                      : {skipped.reason}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
          {rebuildError ? (
            <p role="alert" className="text-danger m-0 text-[12px]">
              {rebuildError}
            </p>
          ) : null}
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" disabled={rebuildIndex.isPending}>
                {result ? "Close" : "Cancel"}
              </Button>
            </DialogClose>
            {!result ? (
              <Button
                disabled={rebuildIndex.isPending}
                onClick={() => {
                  setRebuildError(undefined);
                  rebuildIndex.mutate({ projectId });
                }}
              >
                {rebuildIndex.isPending ? "Rebuilding…" : "Rebuild index"}
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
