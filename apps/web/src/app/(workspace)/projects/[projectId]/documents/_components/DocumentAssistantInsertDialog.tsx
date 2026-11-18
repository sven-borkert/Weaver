"use client";

import type { Editor, JSONContent } from "@tiptap/core";
import { MAX_DOCUMENT_GENERATION_INSTRUCTION_CHARS } from "@weaver/core/documents/limits";
import { useId, useMemo, useState } from "react";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Label } from "~/components/ui/label";
import { Textarea } from "~/components/ui/textarea";
import { parseGeneratedMarkdown } from "~/lib/editor/generated-markdown";
import { renderDocumentContent } from "~/lib/editor/render";
import { api } from "~/trpc/react";
import { withMermaidRendererMapping } from "./MermaidRenderer";

const previewMapping = withMermaidRendererMapping({
  image: ({ node }) => (
    <span>{typeof node.attrs.alt === "string" ? node.attrs.alt : "Image"}</span>
  ),
});

type AssistantInsertFormProps = {
  editor: Editor;
  projectId: string;
  documentId: string;
  onClose: () => void;
  onInsert: (markdown: string) => boolean;
};

export function DocumentAssistantInsertDialog({
  open,
  onCloseAutoFocus,
  ...formProps
}: AssistantInsertFormProps & {
  open: boolean;
  onCloseAutoFocus: (event: Event) => void;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) formProps.onClose();
      }}
    >
      <DialogContent
        className="max-h-[85dvh] overflow-y-auto sm:max-w-xl"
        onCloseAutoFocus={onCloseAutoFocus}
        onEscapeKeyDown={(event) => {
          if (event.isComposing) event.preventDefault();
          else event.stopPropagation();
        }}
      >
        <DialogHeader>
          <DialogTitle>Insert with assistant</DialogTitle>
          <DialogDescription>
            Describe what you want to add, such as a formula, a diagram, or a
            code snippet.
          </DialogDescription>
        </DialogHeader>
        {open ? <AssistantInsertForm {...formProps} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function AssistantInsertForm({
  editor,
  projectId,
  documentId,
  onClose,
  onInsert,
}: AssistantInsertFormProps) {
  const id = useId();
  const [instruction, setInstruction] = useState("");
  const [markdown, setMarkdown] = useState<string>();
  const [error, setError] = useState<string>();
  const { mutateAsync, isPending } = api.document.generateContent.useMutation({
    gcTime: 0,
  });
  const preview = useMemo(() => {
    if (!markdown) return null;
    try {
      const parsed = parseGeneratedMarkdown(editor.schema, markdown);
      return {
        content: renderDocumentContent(
          parsed.toJSON() as JSONContent,
          previewMapping,
        ),
      };
    } catch {
      return null;
    }
  }, [editor, markdown]);
  const message =
    error ??
    (markdown && !preview
      ? "The response could not be previewed. Try generating it again."
      : undefined);

  return (
    <form
      className="flex min-w-0 flex-col gap-4"
      onSubmit={async (event) => {
        event.preventDefault();
        const text = instruction.trim();
        if (!text || isPending) return;
        setError(undefined);
        setMarkdown(undefined);
        try {
          const result = await mutateAsync({
            projectId,
            documentId,
            instruction: text,
          });
          setMarkdown(result.markdown);
        } catch (cause) {
          const data = (
            cause as { data?: { code?: string; field?: string } } | null
          )?.data;
          setError(
            data?.code === "PRECONDITION_FAILED"
              ? "An assistant model needs to be configured first."
              : data?.code === "FORBIDDEN" || data?.code === "NOT_FOUND"
                ? "Editing access is no longer available for this document."
                : data?.field === "instruction"
                  ? "Use a shorter description for the configured assistant model."
                  : "The assistant could not generate content. Try again.",
          );
        }
      }}
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={id}>What would you like to insert?</Label>
        <Textarea
          id={id}
          autoFocus
          rows={4}
          className="min-h-24"
          maxLength={MAX_DOCUMENT_GENERATION_INSTRUCTION_CHARS}
          placeholder="Write a displayed formula for the quadratic equation’s solutions"
          disabled={isPending}
          value={instruction}
          onChange={(event) => {
            setInstruction(event.target.value);
            setError(undefined);
            setMarkdown(undefined);
          }}
        />
      </div>
      <p role="status" className={isPending ? undefined : "sr-only"}>
        {isPending ? "Generating content…" : preview ? "Preview ready." : ""}
      </p>
      {message ? (
        <p role="alert" className="text-danger text-sm">
          {message}
        </p>
      ) : null}
      {preview ? (
        <section
          aria-label="Generated preview"
          className="document-prose border-line bg-surface-2 overflow-auto rounded-lg border p-3"
        >
          {preview.content}
        </section>
      ) : null}
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onClose}>
          {isPending ? "Close" : "Cancel"}
        </Button>
        <Button
          type="submit"
          variant={preview ? "outline" : "default"}
          disabled={isPending || !instruction.trim()}
        >
          {preview ? "Generate again" : "Generate"}
        </Button>
        {preview && markdown ? (
          <Button
            type="button"
            onClick={() => {
              if (!onInsert(markdown))
                setError(
                  "This content cannot be inserted at the current cursor position.",
                );
            }}
          >
            Insert at cursor
          </Button>
        ) : null}
      </div>
    </form>
  );
}
