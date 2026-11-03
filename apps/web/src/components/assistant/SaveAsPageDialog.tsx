"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { FilePlus2 } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { parseDocumentBody } from "@weaver/core/editor/markdown";
import { projectRoleAtLeast } from "@weaver/core/roles";

import { Button } from "~/components/ui/button";
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
import { Textarea } from "~/components/ui/textarea";
import {
  buildSaveAsPagePrefill,
  parseFolderInput,
  savePropertiesFor,
  SAVE_AS_PAGE_TITLE_MAX,
  type SaveAsPageSource,
} from "~/lib/assistant/saveAsPage";
import { applyTrpcErrorToForm } from "~/lib/trpcErrors";
import { api } from "~/trpc/react";

/** Client-side mirror of the server's document.create input. */
const saveFormSchema = z.object({
  title: z
    .string()
    .trim()
    .min(1, "Title is required")
    .max(SAVE_AS_PAGE_TITLE_MAX, "Use at most 200 characters"),
  folder: z.string().max(1_000),
  body: z.string().min(1, "The page needs some text"),
});
type SaveFormValues = z.infer<typeof saveFormSchema>;

/** Editors and above see the action; it opens the prefilled create dialog. */
export function SaveAsPageButton({
  conversationId,
  messageId,
  text,
}: {
  conversationId: string;
  messageId: string;
  text: string;
}) {
  const [open, setOpen] = useState(false);
  const projects = api.project.list.useQuery(undefined, { retry: false });
  const editable = (projects.data ?? []).filter((project) =>
    projectRoleAtLeast(project.myRole, "Editor"),
  );
  if (editable.length === 0 || text.trim().length === 0) return null;
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className="self-start"
        onClick={() => setOpen(true)}
      >
        <FilePlus2 data-icon="inline-start" />
        Save as page
      </Button>
      {open ? (
        <SaveAsPageDialog
          conversationId={conversationId}
          messageId={messageId}
          text={text}
          projects={editable.map((p) => ({ id: p.id, name: p.name }))}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

function SaveAsPageDialog({
  conversationId,
  messageId,
  text,
  projects,
  onClose,
}: {
  conversationId: string;
  messageId: string;
  text: string;
  projects: Array<{ id: string; name: string }>;
  onClose: () => void;
}) {
  const citations = api.assistant.listCitations.useQuery({
    conversationId,
    messageId,
  });
  const cards = useMemo(
    () => (citations.data ?? []).filter((c) => c.messageId === messageId),
    [citations.data, messageId],
  );
  // The project most citations point at, else the first editable one.
  const [projectId, setProjectId] = useState<string>(() => {
    const ids = new Set(projects.map((p) => p.id));
    const counts = new Map<string, number>();
    for (const card of cards)
      if (ids.has(card.projectId))
        counts.set(card.projectId, (counts.get(card.projectId) ?? 0) + 1);
    const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    return best ?? projects[0]!.id;
  });
  const target = api.wiki.saveTarget.useQuery({ projectId }, { retry: false });
  const prefill = useMemo(
    () =>
      buildSaveAsPagePrefill({
        answerText: text,
        citations: cards,
        targetProjectId: projectId,
        wikiFolderPath: target.data?.enabled ? target.data.folderPath : null,
      }),
    [text, cards, projectId, target.data],
  );
  return (
    <SaveAsPageForm
      key={`${projectId}:${prefill.folderPath.join("/")}:${prefill.sources.length}`}
      prefill={prefill}
      projects={projects}
      projectId={projectId}
      onProject={setProjectId}
      loading={citations.isLoading || target.isLoading}
      onClose={onClose}
    />
  );
}

function SaveAsPageForm({
  prefill,
  projects,
  projectId,
  onProject,
  loading,
  onClose,
}: {
  prefill: ReturnType<typeof buildSaveAsPagePrefill>;
  projects: Array<{ id: string; name: string }>;
  projectId: string;
  onProject: (id: string) => void;
  loading: boolean;
  onClose: () => void;
}) {
  const utils = api.useUtils();
  const [sources, setSources] = useState<SaveAsPageSource[]>(prefill.sources);
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors },
  } = useForm<SaveFormValues>({
    resolver: zodResolver(saveFormSchema),
    defaultValues: {
      title: prefill.title,
      folder: prefill.folderPath.join("/"),
      body: prefill.body,
    },
  });
  const create = api.document.create.useMutation({
    onSuccess: (created) => {
      void utils.document.list.invalidate({ projectId });
      toast.success(
        <span>
          Page created.{" "}
          <Link
            className="underline"
            href={`/projects/${projectId}/documents/${created.id}`}
          >
            Open it
          </Link>
        </span>,
      );
      onClose();
    },
    onError: (error) => {
      if (error.data?.field)
        applyTrpcErrorToForm(error, (name, issue) =>
          setError(name as Parameters<typeof setError>[0], issue),
        );
      else toast.error(error.message || "Could not create the page");
    },
  });
  const onSubmit = handleSubmit((values) => {
    create.mutate({
      projectId,
      folderPath: parseFolderInput(values.folder),
      title: values.title,
      contentJson: parseDocumentBody(values.body),
      properties: savePropertiesFor(prefill.type, sources),
    });
  });
  const pending = create.isPending;
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !pending) onClose();
      }}
    >
      <DialogContent aria-busy={pending || undefined} className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Save as page</DialogTitle>
          <DialogDescription>
            Creates a synthesis page under your name. It follows the
            project&apos;s normal review.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="flex flex-col gap-3" noValidate>
          <fieldset disabled={pending} className="flex flex-col gap-3">
            {projects.length > 1 ? (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="save-page-project">Project</Label>
                <Select value={projectId} onValueChange={onProject}>
                  <SelectTrigger id="save-page-project" aria-label="Project">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {projects.map((project) => (
                      <SelectItem key={project.id} value={project.id}>
                        {project.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : null}
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="save-page-title">Title</Label>
              <Input
                id="save-page-title"
                autoFocus
                aria-invalid={errors.title ? true : undefined}
                {...register("title")}
              />
              {errors.title ? (
                <p className="text-danger text-[12px]">
                  {errors.title.message}
                </p>
              ) : null}
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="save-page-folder">
                Folder{" "}
                <span className="text-text-muted font-normal">
                  (slash-separated, empty for the root)
                </span>
              </Label>
              <Input
                id="save-page-folder"
                aria-invalid={errors.folder ? true : undefined}
                {...register("folder")}
              />
              {errors.folder ? (
                <p className="text-danger text-[12px]">
                  {errors.folder.message}
                </p>
              ) : null}
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="save-page-body">Text</Label>
              <Textarea
                id="save-page-body"
                rows={8}
                aria-invalid={errors.body ? true : undefined}
                {...register("body")}
              />
              {errors.body ? (
                <p className="text-danger text-[12px]">{errors.body.message}</p>
              ) : null}
            </div>
            <p className="text-text-2 m-0 text-[12px]">
              Type: <strong>{prefill.type}</strong>
            </p>
            {sources.length > 0 ? (
              <div className="flex flex-col gap-1.5">
                <span className="text-text text-[13px] font-medium">
                  Sources
                </span>
                <ul className="m-0 flex list-none flex-col gap-1 p-0">
                  {sources.map((source, index) => (
                    <li key={`${source.kind}:${source.id}`}>
                      <label className="flex items-start gap-2 text-[13px]">
                        <input
                          type="checkbox"
                          checked={source.checked}
                          disabled={!source.inTargetProject}
                          onChange={(event) =>
                            setSources((current) =>
                              current.map((entry, at) =>
                                at === index
                                  ? { ...entry, checked: event.target.checked }
                                  : entry,
                              ),
                            )
                          }
                        />
                        <span>
                          {source.label}
                          {source.warning ? (
                            <span className="text-danger block text-[12px]">
                              {source.warning}
                            </span>
                          ) : null}
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </fieldset>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={onClose}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={pending || loading}>
              {pending ? "Creating…" : "Create page"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
