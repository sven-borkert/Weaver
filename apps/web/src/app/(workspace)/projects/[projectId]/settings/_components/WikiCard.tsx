"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import Link from "next/link";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";

import { Badge } from "~/components/ui/badge";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Skeleton } from "~/components/ui/skeleton";
import { api, type RouterOutputs } from "~/trpc/react";
import { ReviewGuideDialog } from "./ReviewGuideDialog";

type Settings = RouterOutputs["wiki"]["settings"];

// Client-side mirror of the server's wiki.update input.
const budgetSchema = z.object({
  destructiveBudget24h: z
    .number({ error: "Enter a whole number" })
    .int("Enter a whole number")
    .min(1_000, "Use at least 1,000 characters")
    .max(10_000_000, "Use at most 10,000,000 characters"),
});
type BudgetValues = z.infer<typeof budgetSchema>;

function day(value: Date | string | null) {
  return value ? new Date(value).toISOString().slice(0, 10) : null;
}

export function WikiCard({
  projectId,
  isOwner,
}: {
  projectId: string;
  isOwner: boolean;
}) {
  const query = api.wiki.settings.useQuery({ projectId }, { retry: false });
  return (
    <Card>
      <CardHeader>
        <CardTitle>Wiki agent</CardTitle>
        <CardDescription>
          An unattended assistant that keeps a linked wiki for this project,
          under its own identity.
        </CardDescription>
      </CardHeader>
      <CardContent aria-label="Wiki agent settings">
        {query.isLoading ? (
          <Skeleton className="h-32 w-full" />
        ) : query.data === undefined ? (
          <div className="flex flex-col items-start gap-2" role="alert">
            <p className="text-text-2 m-0 text-[13px]">
              Wiki settings could not be loaded. Maintainer access is required.
            </p>
            <Button variant="outline" onClick={() => void query.refetch()}>
              Retry
            </Button>
          </div>
        ) : (
          <WikiSettings
            projectId={projectId}
            isOwner={isOwner}
            settings={query.data}
          />
        )}
      </CardContent>
    </Card>
  );
}

export function WikiSettings({
  projectId,
  isOwner,
  settings,
}: {
  projectId: string;
  isOwner: boolean;
  settings: Settings;
}) {
  const utils = api.useUtils();
  const [confirm, setConfirm] = useState<"disable" | "revoke" | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const invalidate = () => {
    void utils.wiki.settings.invalidate({ projectId });
    void utils.wiki.suggestions.invalidate({ projectId });
  };
  const onError = (error: { data?: { code?: string } | null }) => {
    toast.error(
      error.data?.code === "CONFLICT"
        ? "The wiki settings changed. Reload and try again."
        : "Could not update the wiki settings. Check your access and try again.",
    );
    invalidate();
  };
  const input = { projectId, expectedRevision: settings.revision };
  const enable = api.wiki.enable.useMutation({
    onSuccess: () => {
      toast.success("Wiki agent enabled");
      invalidate();
      void utils.document.list.invalidate();
    },
    onError,
  });
  const disable = api.wiki.disable.useMutation({
    onSuccess: () => {
      toast.success("Wiki agent disabled");
      setConfirm(null);
      invalidate();
    },
    onError,
  });
  const revoke = api.wiki.revokeAgent.useMutation({
    onSuccess: () => {
      toast.success("Wiki agent identity revoked");
      setConfirm(null);
      invalidate();
    },
    onError,
  });
  const busy = enable.isPending || disable.isPending || revoke.isPending;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={settings.enabled ? "default" : "secondary"}>
          {settings.enabled ? "Enabled" : "Off"}
        </Badge>
        <Badge variant={settings.routeReady ? "outline" : "destructive"}>
          {settings.routeReady ? "Model route ready" : "No model route"}
        </Badge>
        {settings.agent ? (
          <span className="text-text-3 text-[12px]">
            {settings.agent.live ? "Agent created" : "Agent revoked; created"}{" "}
            {day(settings.agent.createdAt)}
          </span>
        ) : null}
      </div>
      {!settings.routeReady ? (
        <p className="text-text-2 m-0 text-[13px]">
          An administrator assigns the model in Administration › AI. The setting
          works without it, but the agent cannot run.
        </p>
      ) : null}
      <p className="text-text-3 m-0 text-[12px]">
        The wiki model route is shared. Unassigning it in Administration › AI
        stops the agent in every project.
      </p>

      {!settings.enabled ? (
        <div className="flex flex-col items-start gap-2">
          <p className="text-text-2 m-0 text-[13px]">
            Enabling creates the agent identity, a wiki folder with a sources
            folder, a guide page from Weaver&apos;s template and an overview
            page. Existing pages are not touched.
          </p>
          {isOwner ? (
            <Button
              disabled={busy}
              onClick={() => enable.mutate(input)}
              data-testid="wiki-enable"
            >
              {enable.isPending ? "Enabling…" : "Enable wiki agent"}
            </Button>
          ) : (
            <p className="text-text-3 m-0 text-[12px]">
              A project Owner can enable it.
            </p>
          )}
        </div>
      ) : null}

      {settings.guide.documentId ? (
        <GuideSection
          projectId={projectId}
          settings={settings}
          isOwner={isOwner}
          onReview={() => setReviewOpen(true)}
        />
      ) : null}
      {settings.enabled ? (
        <Suggestions
          projectId={projectId}
          guideId={settings.guide.documentId}
        />
      ) : null}
      {settings.enabled && isOwner ? (
        <BudgetForm key={settings.revision} settings={settings} />
      ) : null}
      {settings.enabled && !isOwner ? (
        <p className="text-text-3 m-0 text-[12px]">
          24-hour destructive budget:{" "}
          {settings.destructiveBudget24h.toLocaleString("en-US")} characters
          {settings.destructivePausedAt ? " (paused)" : ""}
        </p>
      ) : null}

      {settings.enabled && isOwner ? (
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => setConfirm("disable")}
          >
            Disable
          </Button>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => setConfirm("revoke")}
          >
            Revoke agent identity
          </Button>
        </div>
      ) : null}

      <ReviewGuideDialog
        projectId={projectId}
        open={reviewOpen}
        onOpenChange={setReviewOpen}
      />
      <Dialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setConfirm(null);
        }}
      >
        <DialogContent aria-busy={busy}>
          <DialogHeader>
            <DialogTitle>
              {confirm === "revoke"
                ? "Revoke the wiki agent identity?"
                : "Disable the wiki agent?"}
            </DialogTitle>
            <DialogDescription>
              {confirm === "revoke"
                ? "The agent stops and the feature turns off. Pages and history stay, and past changes stay attributed to this identity. Enabling again creates a new one."
                : "The agent stops. Pages, inputs and history stay, and you can enable it again."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => setConfirm(null)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() =>
                confirm === "revoke"
                  ? revoke.mutate(input)
                  : disable.mutate(input)
              }
            >
              {confirm === "revoke" ? "Revoke identity" : "Disable"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function GuideSection({
  projectId,
  settings,
  isOwner,
  onReview,
}: {
  projectId: string;
  settings: Settings;
  isOwner: boolean;
  onReview: () => void;
}) {
  const { guide } = settings;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-text text-[13px] font-medium">Guide</span>
        <Badge variant={guide.approved ? "outline" : "destructive"}>
          {guide.approved
            ? `Approved ${day(guide.approvedAt) ?? ""}`.trim()
            : "Not approved"}
        </Badge>
      </div>
      <p className="text-text-2 m-0 text-[13px]">
        <Link
          className="underline"
          href={`/projects/${projectId}/documents/${guide.documentId}`}
        >
          {guide.title ?? "Guide page"}
        </Link>
        {guide.approved
          ? ""
          : ". Runs wait until a Maintainer approves the guide."}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" onClick={onReview}>
          Review guide
        </Button>
        {isOwner ? (
          <GuidePicker projectId={projectId} settings={settings} />
        ) : null}
      </div>
    </div>
  );
}

function GuidePicker({
  projectId,
  settings,
}: {
  projectId: string;
  settings: Settings;
}) {
  const utils = api.useUtils();
  const [choice, setChoice] = useState<string>("");
  const documents = api.document.list.useQuery({
    projectId,
    page: 1,
    pageSize: 200,
    sort: "title",
    dir: "asc",
  });
  const set = api.wiki.setGuideDocument.useMutation({
    onSuccess: () => {
      toast.success("Guide page changed. A Maintainer must approve it.");
      setChoice("");
      void utils.wiki.settings.invalidate({ projectId });
    },
    onError: () => {
      toast.error("That page cannot be the guide, or the settings changed.");
      void utils.wiki.settings.invalidate({ projectId });
    },
  });
  const options = (documents.data?.items ?? []).filter(
    (item) =>
      item.documentKind === "markdown" && item.id !== settings.guide.documentId,
  );
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select value={choice} onValueChange={setChoice} disabled={set.isPending}>
        <SelectTrigger aria-label="Use a different guide page" className="w-56">
          <SelectValue placeholder="Use a different page" />
        </SelectTrigger>
        <SelectContent>
          {options.map((item) => (
            <SelectItem key={item.id} value={item.id}>
              {item.title}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button
        variant="outline"
        disabled={choice === "" || set.isPending}
        onClick={() =>
          set.mutate({
            projectId,
            expectedRevision: settings.revision,
            documentId: choice,
          })
        }
      >
        Use as guide
      </Button>
    </div>
  );
}

function Suggestions({
  projectId,
  guideId,
}: {
  projectId: string;
  guideId: string | null;
}) {
  const utils = api.useUtils();
  const query = api.wiki.suggestions.useQuery({ projectId }, { retry: false });
  const dismiss = api.wiki.resolveSuggestion.useMutation({
    onSuccess: () => {
      void utils.wiki.suggestions.invalidate({ projectId });
      void utils.wiki.settings.invalidate({ projectId });
    },
    onError: () => toast.error("Could not dismiss the suggestion."),
  });
  const items = query.data ?? [];
  if (items.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      <span className="text-text text-[13px] font-medium">
        Guide suggestions
      </span>
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {items.map((item) => (
          <li
            key={item.id}
            className="border-line flex flex-col gap-1 rounded-[10px] border p-3"
          >
            <span className="text-text-3 text-[12px]">
              Written by the agent
            </span>
            <span className="text-text text-[13px] break-words whitespace-pre-wrap">
              {item.text}
            </span>
            <div className="flex gap-2">
              {guideId ? (
                <Button asChild variant="outline" size="sm">
                  <Link href={`/projects/${projectId}/documents/${guideId}`}>
                    Open guide editor
                  </Link>
                </Button>
              ) : null}
              <Button
                variant="outline"
                size="sm"
                disabled={dismiss.isPending}
                onClick={() =>
                  dismiss.mutate({ projectId, suggestionId: item.id })
                }
              >
                Dismiss
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function BudgetForm({ settings }: { settings: Settings }) {
  const utils = api.useUtils();
  const form = useForm<BudgetValues>({
    resolver: zodResolver(budgetSchema),
    defaultValues: { destructiveBudget24h: settings.destructiveBudget24h },
  });
  const save = api.wiki.update.useMutation({
    onSuccess: () => {
      toast.success("Wiki settings saved");
      void utils.wiki.settings.invalidate({ projectId: settings.projectId });
    },
    onError: (error) => {
      toast.error(
        error.data?.code === "CONFLICT"
          ? "The wiki settings changed. Reload and try again."
          : "Could not save the wiki settings.",
      );
      void utils.wiki.settings.invalidate({ projectId: settings.projectId });
    },
  });
  const error = form.formState.errors.destructiveBudget24h;
  return (
    <form
      aria-label="Wiki budget"
      className="flex flex-col gap-1.5"
      onSubmit={form.handleSubmit((values) =>
        save.mutate({
          projectId: settings.projectId,
          expectedRevision: settings.revision,
          destructiveBudget24h: values.destructiveBudget24h,
        }),
      )}
    >
      <Label htmlFor="wiki-budget">
        24-hour destructive budget (characters)
      </Label>
      <div className="flex flex-wrap items-start gap-2">
        <Input
          id="wiki-budget"
          type="number"
          className="w-40"
          aria-invalid={error ? true : undefined}
          disabled={save.isPending}
          {...form.register("destructiveBudget24h", { valueAsNumber: true })}
        />
        <Button
          type="submit"
          variant="outline"
          disabled={save.isPending || !form.formState.isDirty}
        >
          Save
        </Button>
      </div>
      {error ? (
        <p className="text-danger m-0 text-[12px]">{error.message}</p>
      ) : (
        <p className="text-text-3 m-0 text-[12px]">
          Caps how much text the agent may rewrite or remove from pages it did
          not create. {settings.destructivePausedAt ? "Currently paused." : ""}
        </p>
      )}
    </form>
  );
}
