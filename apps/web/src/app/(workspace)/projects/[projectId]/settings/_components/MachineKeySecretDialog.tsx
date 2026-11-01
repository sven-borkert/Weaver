"use client";

import { toast } from "sonner";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { buildMachineApiExamples } from "~/lib/project-api/examples";
import type { RouterOutputs } from "~/trpc/react";

type GrantSummary =
  RouterOutputs["projectApiKey"]["list"][number]["grants"][number];

const EXAMPLE_TITLES = {
  updateMarkdown: "Update a fixed Markdown document (curl)",
  createMarkdown: "Create a dated report (curl)",
  appendRows: "Append audit rows (curl)",
  python: "Update a document (Python standard library)",
} as const;

function copy(text: string, label: string) {
  void navigator.clipboard.writeText(text).then(
    () => toast.success(`${label} copied`),
    () => toast.error(`Could not copy the ${label.toLowerCase()}`),
  );
}

/** Copyable curl/Python examples for a key's grants; the secret stays a placeholder. */
export function MachineKeyExamples({
  baseUrl,
  projectId,
  grants,
}: {
  baseUrl: string;
  projectId: string;
  grants: GrantSummary[];
}) {
  const columns = grants.find(
    (grant) => grant.kind === "table" && grant.actions.includes("create"),
  )?.columns;
  const examples = buildMachineApiExamples({
    baseUrl,
    projectId,
    grants,
    columns,
  });
  return (
    <div className="flex flex-col gap-3">
      <p className="text-text-3 m-0 text-[12px]">
        Store the key as <code>WEAVER_PROJECT_API_KEY</code> in your script’s
        secret storage. Replace any UUID placeholders with targets this key can
        reach. After a 412 response, fetch the new revision and rebuild the
        change with a fresh operation ID.
      </p>
      {(Object.keys(EXAMPLE_TITLES) as (keyof typeof EXAMPLE_TITLES)[]).map(
        (name) => (
          <div key={name} className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-text text-[13px] font-medium">
                {EXAMPLE_TITLES[name]}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => copy(examples[name], "Example")}
              >
                Copy
              </Button>
            </div>
            <pre className="bg-canvas text-text-2 m-0 max-h-64 overflow-auto rounded-lg p-3 text-[12px]">
              {examples[name]}
            </pre>
          </div>
        ),
      )}
    </div>
  );
}

export function MachineKeySecretDialog({
  secret,
  projectId,
  baseUrl,
  grants,
  refreshFailed,
  onRetry,
  onClose,
}: {
  secret: string;
  projectId: string;
  baseUrl: string | null;
  grants: GrantSummary[];
  refreshFailed: boolean;
  onRetry: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Copy your project API key</DialogTitle>
          <DialogDescription>
            The key was created. This is the only time Weaver shows the secret;
            store it before closing this dialog.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          <pre
            aria-label="New project API key"
            className="bg-canvas text-text m-0 overflow-x-auto rounded-lg p-3 text-[12px] break-all whitespace-pre-wrap"
          >
            {secret}
          </pre>
          <Button
            type="button"
            className="w-fit"
            onClick={() => copy(secret, "Key")}
          >
            Copy key
          </Button>
        </div>
        {refreshFailed ? (
          <p role="alert" className="text-danger m-0 text-[12px]">
            The key is ready, but the key list could not refresh.{" "}
            <Button type="button" variant="outline" size="sm" onClick={onRetry}>
              Retry list refresh
            </Button>
          </p>
        ) : null}
        {baseUrl ? (
          <MachineKeyExamples
            baseUrl={baseUrl}
            projectId={projectId}
            grants={grants}
          />
        ) : null}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            I saved the key
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
