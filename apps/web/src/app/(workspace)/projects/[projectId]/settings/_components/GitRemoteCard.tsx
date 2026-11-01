"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect, useRef, useState, type RefObject } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";

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
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Skeleton } from "~/components/ui/skeleton";
import { focusDialogTarget } from "~/lib/dialog-focus";
import { applyTrpcErrorToForm } from "~/lib/trpcErrors";
import {
  GIT_PULL_ERROR_FALLBACK,
  GIT_PULL_ERROR_MESSAGES,
  GIT_PUSH_ERROR_FALLBACK,
  GIT_PUSH_ERROR_MESSAGES,
} from "@weaver/core/documents/gitRemoteMessages";
import { api, type RouterOutputs } from "~/trpc/react";

type Remote = NonNullable<RouterOutputs["projectGitRemote"]["get"]>;

// Client-side mirror of the server's projectGitRemote.save input.
const configurationSchema = z.object({
  remoteUrl: z
    .string()
    .trim()
    .min(1, "SSH remote URL is required")
    .max(2048, "Use at most 2048 characters"),
  branch: z
    .string()
    .trim()
    .min(1, "Branch is required")
    .max(255, "Use at most 255 characters"),
  enabled: z.boolean(),
});
// Client-side mirror of the server's projectGitRemote.uploadKey name.
const keySchema = z.object({
  keyName: z
    .string()
    .trim()
    .min(1, "Key name is required")
    .max(120, "Use at most 120 characters"),
});
type Configuration = z.infer<typeof configurationSchema>;
const defaults = (remote: Remote | null): Configuration => ({
  remoteUrl: remote?.remoteUrl ?? "",
  branch: remote?.branch ?? "main",
  enabled: remote?.enabled ?? false,
});

function timestamp(value: Date | string | null) {
  return value
    ? new Date(value)
        .toISOString()
        .replace("T", " ")
        .replace(/\.\d{3}Z$/, " UTC")
    : "Never";
}

export function GitRemoteCard({ projectId }: { projectId: string }) {
  const query = api.projectGitRemote.get.useQuery(
    { projectId },
    { refetchInterval: 5000 },
  );
  const [reload, setReload] = useState(0);
  const region = useRef<HTMLDivElement>(null);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Git remote</CardTitle>
        <CardDescription>
          Push committed project history to your SSH Git repository.
        </CardDescription>
      </CardHeader>
      <CardContent ref={region} tabIndex={-1} aria-label="Git remote settings">
        {query.isLoading ? (
          <Skeleton className="h-40 w-full" />
        ) : query.error || query.data === undefined ? (
          <div className="flex flex-col items-start gap-2" role="alert">
            <p className="text-text-2 text-[13px]">
              Git remote settings could not be loaded. Project Owner access is
              required.
            </p>
            <Button variant="outline" onClick={() => void query.refetch()}>
              Retry
            </Button>
          </div>
        ) : (
          <GitRemoteForm
            key={`${projectId}:${reload}`}
            projectId={projectId}
            remote={query.data}
            region={region}
            onReload={() => setReload((value) => value + 1)}
          />
        )}
      </CardContent>
    </Card>
  );
}

function GitRemoteForm({
  projectId,
  remote,
  onReload,
  region,
}: {
  projectId: string;
  remote: Remote | null;
  onReload: () => void;
  region: RefObject<HTMLDivElement | null>;
}) {
  const utils = api.useUtils();
  const [revision, setRevision] = useState(remote?.revision);
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [confirmation, setConfirmation] = useState<
    "key" | "connection" | "pull" | null
  >(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const confirmationTrigger = useRef<HTMLButtonElement | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const configuration = useForm<Configuration>({
    resolver: zodResolver(configurationSchema),
    defaultValues: defaults(remote),
  });
  const keyForm = useForm<z.infer<typeof keySchema>>({
    resolver: zodResolver(keySchema),
    defaultValues: { keyName: "" },
  });
  const accept = (saved: Remote, identity: { projectId: string }) => {
    setRevision(saved.revision);
    utils.projectGitRemote.get.setData(
      { projectId: identity.projectId },
      saved,
    );
    void utils.projectGitRemote.get.invalidate({
      projectId: identity.projectId,
    });
  };
  const onError = (error: { data?: { code?: string } | null }) => {
    toast.error(
      error.data?.code === "CONFLICT"
        ? "These settings changed. Reload the saved settings and try again."
        : "Could not update the Git remote. Check your access and try again.",
    );
    void utils.projectGitRemote.get.invalidate({ projectId });
  };
  const save = api.projectGitRemote.save.useMutation({
    onSuccess: (saved, variables) => {
      accept(saved, variables);
      configuration.reset(defaults(saved));
      toast.success("Git remote saved");
    },
    onError: (error) => {
      const field = error.data?.field;
      if (field === "remoteUrl" || field === "branch" || field === "enabled") {
        const message =
          field === "remoteUrl"
            ? "Use an SSH URL such as git@host:team/repository.git."
            : field === "branch"
              ? "Enter a valid Git branch name."
              : "Upload an SSH private key before enabling automatic pushes.";
        applyTrpcErrorToForm({ ...error, message }, (name, detail) =>
          configuration.setError(name as keyof Configuration, detail),
        );
      } else onError(error);
    },
  });
  const upload = api.projectGitRemote.uploadKey.useMutation({
    gcTime: 0,
    onSuccess: (saved, variables) => {
      accept(saved, variables);
      setFile(null);
      setFileError(null);
      if (fileInput.current) fileInput.current.value = "";
      keyForm.reset({ keyName: "" });
      upload.reset();
      toast.success("SSH key saved");
    },
    onError: (error) => {
      upload.reset();
      if (error.data?.code === "BAD_REQUEST")
        setFileError(
          "Upload a valid, unencrypted OpenSSH or PEM private key, at most 64 KiB. Passphrase-protected keys are unsupported.",
        );
      else if (error.data?.code === "PRECONDITION_FAILED")
        setFileError(
          "SSH key encryption is unavailable. Contact your administrator to enable secure credential storage, then try again.",
        );
      else onError(error);
    },
  });
  const deleteKey = api.projectGitRemote.deleteKey.useMutation({
    onSuccess: (saved, variables) => {
      accept(saved, variables);
      configuration.setValue("enabled", false);
      setConfirmation(null);
      toast.success("SSH key deleted; automatic pushes paused");
    },
    onError,
  });
  const remove = api.projectGitRemote.remove.useMutation({
    onSuccess: (_result, variables) => {
      utils.projectGitRemote.get.setData(
        { projectId: variables.projectId },
        null,
      );
      void utils.projectGitRemote.get.invalidate({
        projectId: variables.projectId,
      });
      setConfirmation(null);
      toast.success("Git remote removed");
      onReload();
    },
    onError,
  });
  const push = api.projectGitRemote.pushNow.useMutation({
    onSuccess: (saved, variables) => {
      utils.projectGitRemote.get.setData(
        { projectId: variables.projectId },
        saved,
      );
      void utils.projectGitRemote.get.invalidate({
        projectId: variables.projectId,
      });
      toast.success("Push queued");
    },
    onError,
  });
  const pull = api.projectGitRemote.pull.useMutation({
    onSuccess: (saved, variables) => {
      utils.projectGitRemote.get.setData(
        { projectId: variables.projectId },
        saved,
      );
      void utils.projectGitRemote.get.invalidate({
        projectId: variables.projectId,
      });
      setConfirmation(null);
      toast.success("Pull queued");
    },
    onError,
  });
  const busy =
    reading ||
    save.isPending ||
    upload.isPending ||
    deleteKey.isPending ||
    remove.isPending ||
    push.isPending ||
    pull.isPending;
  const changed = remote?.revision !== revision;
  const uploadKey = async (values: z.infer<typeof keySchema>) => {
    if (busy || revision === undefined) return;
    if (!file) {
      setFileError("Choose a private key file.");
      return;
    }
    if (file.size === 0 || file.size > 65536) {
      setFileError("Choose a nonempty private key file of at most 64 KiB.");
      return;
    }
    setReading(true);
    setFileError(null);
    try {
      const privateKey = await file.text();
      if (mounted.current)
        upload.mutate({
          projectId,
          expectedRevision: revision,
          keyName: values.keyName,
          privateKey,
        });
    } catch {
      if (mounted.current)
        setFileError("The key file could not be read. Choose it again.");
    } finally {
      if (mounted.current) setReading(false);
    }
  };
  return (
    <div className="flex flex-col gap-5">
      <p className="text-text-3 text-[13px]">
        Includes committed history and project metadata, including members’
        names, email addresses, and roles. Removed members remain in Git
        history. Choose a remote whose readers may access this information.
        Weaver checks for changes about every minute and never force-pushes.
        Pull uses the shared history to merge changes and preserves conflicts as
        separate copies. Review a diverged merge before pushing it.
      </p>
      {remote?.lastPullSha && !remote.enabled ? (
        <p role="status" className="text-text-2 text-[13px]">
          Automatic pushes are paused. Review the pulled content, then enable
          automatic pushes and save the connection when ready.
        </p>
      ) : null}
      {changed ? (
        <div
          role="status"
          className="border-info-border bg-info-bg text-info rounded-md border p-3 text-[13px]"
        >
          Saved settings changed. Your draft is preserved.
          <Button
            className="ml-2"
            variant="outline"
            disabled={busy}
            onClick={onReload}
          >
            Reload saved settings
          </Button>
        </div>
      ) : null}
      <form
        aria-label="Git remote configuration"
        noValidate
        onSubmit={configuration.handleSubmit((values) => {
          if (!busy)
            save.mutate({
              projectId,
              ...(revision === undefined ? {} : { expectedRevision: revision }),
              ...values,
            });
        })}
      >
        <fieldset disabled={busy} className="flex min-w-0 flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="git-remote-url">SSH remote URL</Label>
            <Input
              id="git-remote-url"
              placeholder="git@host:team/repository.git"
              autoComplete="off"
              aria-invalid={!!configuration.formState.errors.remoteUrl}
              {...configuration.register("remoteUrl")}
            />
            <p className="text-text-3 text-[12px]">
              Use git@host:path or ssh://user@host:port/path.
            </p>
            {configuration.formState.errors.remoteUrl ? (
              <p className="text-danger text-[12px]">
                {configuration.formState.errors.remoteUrl.message}
              </p>
            ) : null}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="git-remote-branch">Branch</Label>
            <Input
              id="git-remote-branch"
              autoComplete="off"
              aria-invalid={!!configuration.formState.errors.branch}
              {...configuration.register("branch")}
            />
            {configuration.formState.errors.branch ? (
              <p className="text-danger text-[12px]">
                {configuration.formState.errors.branch.message}
              </p>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            <input
              id="git-remote-enabled"
              type="checkbox"
              disabled={busy || !remote?.key}
              {...configuration.register("enabled")}
            />
            <Label htmlFor="git-remote-enabled">Enable automatic pushes</Label>
          </div>
          {configuration.formState.errors.enabled ? (
            <p className="text-danger text-[12px]">
              {configuration.formState.errors.enabled.message}
            </p>
          ) : null}
          {!remote?.key ? (
            <p className="text-text-3 text-[12px]">
              Save the connection, then upload an SSH key to enable pushes.
            </p>
          ) : null}
          <div className="flex justify-end">
            <Button type="submit" disabled={busy}>
              {save.isPending ? "Saving…" : "Save connection"}
            </Button>
          </div>
        </fieldset>
      </form>
      {remote ? (
        <>
          <section
            className="border-line flex flex-col gap-3 border-t pt-4"
            aria-label="SSH key"
          >
            <h3 className="text-text text-[14px] font-medium">SSH key</h3>
            <div className="text-text-2 text-[13px]">
              <p>Remote host key</p>
              {remote.hostKeyFingerprints.length ? (
                remote.hostKeyFingerprints.map((fingerprint) => (
                  <p
                    key={fingerprint}
                    className="font-mono text-[12px] break-all"
                  >
                    {fingerprint}
                  </p>
                ))
              ) : (
                <p>
                  The first connection pins the remote host key. Verify its
                  fingerprint here after connecting.
                </p>
              )}
            </div>
            {remote.key ? (
              <div className="text-text-2 flex flex-col gap-1 text-[13px]">
                <p>{remote.key.name}</p>
                <p className="font-mono text-[12px] break-all">
                  {remote.key.fingerprint}
                </p>
                <p className="text-text-3 text-[12px]">
                  Uploaded {timestamp(remote.key.uploadedAt)}
                </p>
                <Button
                  className="self-start"
                  variant="outline"
                  disabled={busy}
                  onClick={(event) => {
                    confirmationTrigger.current = event.currentTarget;
                    setConfirmation("key");
                  }}
                >
                  Delete SSH key
                </Button>
              </div>
            ) : (
              <p className="text-text-3 text-[13px]">No SSH key uploaded.</p>
            )}
            <form
              aria-label="Git remote SSH key"
              noValidate
              onSubmit={(event) => keyForm.handleSubmit(uploadKey)(event)}
            >
              <fieldset disabled={busy} className="flex min-w-0 flex-col gap-3">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="git-remote-key-name">Key name</Label>
                  <Input
                    id="git-remote-key-name"
                    autoComplete="off"
                    placeholder="Project deployment key"
                    aria-invalid={!!keyForm.formState.errors.keyName}
                    {...keyForm.register("keyName")}
                  />
                  {keyForm.formState.errors.keyName ? (
                    <p className="text-danger text-[12px]">
                      {keyForm.formState.errors.keyName.message}
                    </p>
                  ) : null}
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="git-remote-private-key">
                    Private key file
                  </Label>
                  <Input
                    id="git-remote-private-key"
                    ref={fileInput}
                    type="file"
                    aria-invalid={!!fileError}
                    onChange={(event) => {
                      setFile(event.target.files?.[0] ?? null);
                      setFileError(null);
                    }}
                  />
                  <p className="text-text-3 text-[12px]">
                    Unencrypted OpenSSH or PEM, at most 64 KiB.
                    Passphrase-protected keys are unsupported. Stored encrypted
                    and never offered for download.
                  </p>
                  {fileError ? (
                    <p role="alert" className="text-danger text-[12px]">
                      {fileError}
                    </p>
                  ) : null}
                </div>
                <div className="flex justify-end">
                  <Button type="submit" variant="outline" disabled={busy}>
                    {reading || upload.isPending
                      ? "Uploading…"
                      : remote.key
                        ? "Replace SSH key"
                        : "Upload SSH key"}
                  </Button>
                </div>
              </fieldset>
            </form>
          </section>
          <section
            className="border-line flex flex-col gap-3 border-t pt-4"
            aria-label="Push status"
          >
            <div role="status" className="text-text text-[14px] font-medium">
              {remote.pulling
                ? "Pulling…"
                : remote.pullQueued
                  ? "Pull queued"
                  : remote.pushing
                    ? "Pushing…"
                    : remote.queued
                      ? "Push queued"
                      : !remote.enabled
                        ? "Automatic pushes paused"
                        : remote.lastErrorCode
                          ? "Push needs attention"
                          : "Automatic pushes enabled"}
            </div>
            <dl className="text-text-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-[12px]">
              <dt>Last successful push</dt>
              <dd>{timestamp(remote.lastPushedAt)}</dd>
              <dt>Last pushed commit</dt>
              <dd className="font-mono break-all">
                {remote.lastPushedSha ?? "None"}
              </dd>
              <dt>Last attempt</dt>
              <dd>{timestamp(remote.lastAttemptAt)}</dd>
              {remote.nextAttemptAt && remote.enabled ? (
                <>
                  <dt>Next attempt</dt>
                  <dd>{timestamp(remote.nextAttemptAt)}</dd>
                </>
              ) : null}
              <dt>Last pull</dt>
              <dd>{timestamp(remote.lastPullAt)}</dd>
              <dt>Last pulled commit</dt>
              <dd className="font-mono break-all">
                {remote.lastPullSha ?? "None"}
              </dd>
            </dl>
            {remote.lastErrorCode ? (
              <p role="status" className="text-danger text-[13px]">
                {Object.hasOwn(GIT_PUSH_ERROR_MESSAGES, remote.lastErrorCode)
                  ? GIT_PUSH_ERROR_MESSAGES[remote.lastErrorCode]
                  : GIT_PUSH_ERROR_FALLBACK}
              </p>
            ) : null}
            {remote.lastPullErrorCode ? (
              <p role="status" className="text-danger text-[13px]">
                {Object.hasOwn(
                  GIT_PULL_ERROR_MESSAGES,
                  remote.lastPullErrorCode,
                )
                  ? GIT_PULL_ERROR_MESSAGES[remote.lastPullErrorCode]
                  : GIT_PULL_ERROR_FALLBACK}
              </p>
            ) : null}
            <div className="flex flex-wrap justify-between gap-2">
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  disabled={
                    busy ||
                    !remote.enabled ||
                    !remote.key ||
                    remote.queued ||
                    remote.pushing
                  }
                  onClick={() => push.mutate({ projectId })}
                >
                  Push now
                </Button>
                <Button
                  variant="outline"
                  disabled={
                    busy ||
                    !remote.key ||
                    remote.pullQueued ||
                    remote.pulling ||
                    remote.queued ||
                    remote.pushing
                  }
                  onClick={(event) => {
                    confirmationTrigger.current = event.currentTarget;
                    setConfirmation("pull");
                  }}
                >
                  Pull existing content
                </Button>
              </div>
              <Button
                variant="outline"
                disabled={busy}
                onClick={(event) => {
                  confirmationTrigger.current = event.currentTarget;
                  setConfirmation("connection");
                }}
              >
                Remove connection
              </Button>
            </div>
          </section>
        </>
      ) : null}
      <p className="text-text-3 text-[12px]">
        The first SSH connection trusts and pins the server&apos;s host key. A
        changed host key blocks later pushes. A push already in progress may
        finish after you pause pushes or delete the key. Removing the connection
        requires the current push to finish.
      </p>
      <Dialog
        open={confirmation !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setConfirmation(null);
        }}
      >
        <DialogContent
          aria-busy={busy || undefined}
          showCloseButton={!busy}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            focusDialogTarget(confirmationTrigger.current, region.current);
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {confirmation === "key"
                ? "Delete SSH key"
                : confirmation === "pull"
                  ? "Pull existing content"
                  : "Remove Git remote"}
            </DialogTitle>
            <DialogDescription>
              {confirmation === "key"
                ? `Delete the stored key “${remote?.key?.name ?? ""}” and pause automatic pushes? A push already in progress may finish.`
                : confirmation === "pull"
                  ? "The remote branch will be merged using shared history. Remote edits and deletions are applied when local content is unchanged; conflicts are preserved as separate copies. Review a diverged merge before pushing it."
                  : `Remove the connection to ${remote?.remoteUrl ?? ""} and its stored SSH key? Existing remote history is retained. A push already in progress may finish.`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => setConfirmation(null)}
            >
              Cancel
            </Button>
            <Button
              variant={confirmation === "pull" ? "default" : "destructive"}
              disabled={busy}
              onClick={() => {
                if (busy) return;
                if (confirmation === "pull") {
                  pull.mutate({ projectId });
                  return;
                }
                if (revision === undefined) return;
                if (confirmation === "key")
                  deleteKey.mutate({ projectId, expectedRevision: revision });
                else remove.mutate({ projectId, expectedRevision: revision });
              }}
            >
              {pull.isPending
                ? "Pulling…"
                : busy
                  ? "Removing…"
                  : confirmation === "key"
                    ? "Delete key"
                    : confirmation === "pull"
                      ? "Pull and merge"
                      : "Remove connection"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
