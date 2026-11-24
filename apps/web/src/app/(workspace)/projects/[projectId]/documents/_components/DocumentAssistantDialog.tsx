"use client";

import type { JSONContent } from "@tiptap/core";
import type { Schema } from "@tiptap/pm/model";
import {
  formatDocumentAssistantReply,
  type DocumentAssistantAction,
  type DocumentAssistantContext,
  type DocumentAssistantReply,
  type DocumentAssistantTurn,
} from "@weaver/core/documents/assistantReply";
import {
  MAX_DOCUMENT_ASSISTANT_SELECTION_CHARS,
  MAX_DOCUMENT_ASSISTANT_TURN_CHARS,
  MAX_DOCUMENT_ASSISTANT_TURNS,
  MAX_DOCUMENT_GENERATION_INSTRUCTION_CHARS,
} from "@weaver/core/documents/limits";
import { Send } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { AssistantMarkdown } from "~/components/assistant/AssistantMarkdown";
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

export type DocumentAssistantTarget = {
  context: DocumentAssistantContext;
  /** The draft has selected text a reply can replace. */
  hasSelection: boolean;
};

type Turn = {
  id: number;
  instruction: string;
  result?: DocumentAssistantReply;
  error?: string;
};

type DocumentAssistantFormProps = {
  projectId: string;
  documentId: string;
  schema: Schema;
  target: DocumentAssistantTarget;
  onClose: () => void;
  /** Applies Markdown to the draft; returns why it could not, or null once applied. */
  onApply: (markdown: string, action: DocumentAssistantAction) => string | null;
};

function generationError(cause: unknown): string {
  const data = (cause as { data?: { code?: string; field?: string } } | null)
    ?.data;
  return data?.code === "PRECONDITION_FAILED"
    ? "An assistant model needs to be configured first."
    : data?.code === "FORBIDDEN" || data?.code === "NOT_FOUND"
      ? "Editing access is no longer available for this document."
      : data?.field === "instruction"
        ? "Use a shorter message for the configured assistant model."
        : data?.field === "selection"
          ? "The selected text is too large to send to the assistant. Select less text or use a shorter message."
          : "The assistant could not answer. Try again.";
}

function canInsert(schema: Schema, markdown: string): boolean {
  try {
    parseGeneratedMarkdown(schema, markdown);
    return true;
  } catch {
    return false;
  }
}

export function DocumentAssistantDialog({
  open,
  target,
  onCloseAutoFocus,
  ...formProps
}: Omit<DocumentAssistantFormProps, "target"> & {
  open: boolean;
  target: DocumentAssistantTarget | null;
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
        className="flex max-h-[85dvh] flex-col sm:max-w-2xl"
        onCloseAutoFocus={onCloseAutoFocus}
        onEscapeKeyDown={(event) => {
          if (event.isComposing) event.preventDefault();
          else event.stopPropagation();
        }}
      >
        <DialogHeader>
          <DialogTitle>Ask the assistant</DialogTitle>
          <DialogDescription>
            {target?.hasSelection
              ? "Ask about the selected text, ask for a change, or describe what to add after it. The assistant sees the selection and the page around it."
              : "Ask about this page or describe what to insert at the cursor, such as a formula, a plot, a diagram, or a code snippet. The assistant sees the page around the cursor."}
          </DialogDescription>
        </DialogHeader>
        {open && target ? (
          <DocumentAssistantForm {...formProps} target={target} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function DocumentAssistantForm({
  projectId,
  documentId,
  schema,
  target,
  onClose,
  onApply,
}: DocumentAssistantFormProps) {
  const id = useId();
  const [instruction, setInstruction] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const nextTurn = useRef(0);
  const end = useRef<HTMLDivElement>(null);
  const { mutateAsync, isPending } = api.document.generateContent.useMutation({
    gcTime: 0,
  });
  const selectionTooLong =
    target.context.selection.length > MAX_DOCUMENT_ASSISTANT_SELECTION_CHARS;
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: "nearest" });
  }, [turns]);

  const ask = async (text: string, earlier: Turn[]) => {
    if (!text || isPending || selectionTooLong) return;
    const history: DocumentAssistantTurn[] = earlier
      .flatMap((turn): DocumentAssistantTurn[] =>
        turn.result
          ? [
              { role: "user", text: turn.instruction },
              {
                role: "assistant",
                text: formatDocumentAssistantReply(turn.result).slice(
                  0,
                  MAX_DOCUMENT_ASSISTANT_TURN_CHARS,
                ),
              },
            ]
          : [],
      )
      .slice(-MAX_DOCUMENT_ASSISTANT_TURNS);
    const turnId = nextTurn.current++;
    const update = (change: Partial<Turn>) =>
      setTurns((current) =>
        current.map((turn) =>
          turn.id === turnId ? { ...turn, ...change } : turn,
        ),
      );
    setTurns([...earlier, { id: turnId, instruction: text }]);
    try {
      const result = await mutateAsync({
        projectId,
        documentId,
        instruction: text,
        context: target.context,
        ...(history.length ? { history } : {}),
      });
      update({ result });
    } catch (cause) {
      update({ error: generationError(cause) });
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="-mx-1 flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-1">
        {target.hasSelection ? (
          <section
            aria-label="Selected text"
            className="border-line bg-surface-2 rounded-lg border"
          >
            <p className="text-text-2 m-0 px-3 pt-2 text-xs font-medium">
              Selected text
            </p>
            <pre className="m-0 max-h-28 overflow-auto px-3 pt-1 pb-2 font-mono text-xs break-words whitespace-pre-wrap">
              {target.context.selection}
            </pre>
          </section>
        ) : null}
        {selectionTooLong ? (
          <p role="alert" className="text-danger m-0 text-sm">
            The selection is longer than{" "}
            {MAX_DOCUMENT_ASSISTANT_SELECTION_CHARS.toLocaleString("en")}{" "}
            characters. Select less text to ask about it.
          </p>
        ) : null}
        {turns.length ? (
          <ol
            aria-label="Conversation"
            className="m-0 flex list-none flex-col gap-4 p-0"
          >
            {turns.map((turn, index) => (
              <li key={turn.id} className="flex flex-col gap-2">
                <p className="bg-brand-bg text-text m-0 max-w-[85%] self-end rounded-2xl rounded-br-sm px-3 py-2 text-sm whitespace-pre-wrap">
                  {turn.instruction}
                </p>
                {turn.result ? (
                  <AssistantReply
                    result={turn.result}
                    schema={schema}
                    hasSelection={target.hasSelection}
                    onApply={onApply}
                  />
                ) : turn.error ? (
                  <p role="alert" className="text-danger m-0 text-sm">
                    {turn.error}{" "}
                    {index === turns.length - 1 ? (
                      <Button
                        type="button"
                        variant="link"
                        size="sm"
                        className="h-auto p-0"
                        disabled={isPending}
                        onClick={() =>
                          void ask(turn.instruction, turns.slice(0, index))
                        }
                      >
                        Try again
                      </Button>
                    ) : null}
                  </p>
                ) : (
                  <p role="status" className="text-text-2 m-0 text-sm">
                    Thinking…
                  </p>
                )}
              </li>
            ))}
          </ol>
        ) : null}
        <div ref={end} />
      </div>
      <form
        className="flex flex-col gap-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          const text = instruction.trim();
          if (!text || isPending || selectionTooLong) return;
          setInstruction("");
          void ask(text, turns);
        }}
      >
        <Label htmlFor={id}>
          {target.hasSelection
            ? "Ask or describe a change"
            : "Ask or describe what to insert"}
        </Label>
        <Textarea
          id={id}
          autoFocus
          rows={3}
          className="min-h-20 resize-none"
          maxLength={MAX_DOCUMENT_GENERATION_INSTRUCTION_CHARS}
          placeholder={
            target.hasSelection
              ? "Explain this, simplify it, or add an example below it"
              : "Write a displayed formula for the quadratic equation’s solutions"
          }
          value={instruction}
          onChange={(event) => setInstruction(event.target.value)}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
        />
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            {isPending ? "Close" : "Cancel"}
          </Button>
          <Button
            type="submit"
            disabled={isPending || !instruction.trim() || selectionTooLong}
          >
            <Send data-icon="inline-start" aria-hidden="true" />
            Ask
          </Button>
        </div>
      </form>
    </div>
  );
}

function AssistantReply({
  result,
  schema,
  hasSelection,
  onApply,
}: {
  result: DocumentAssistantReply;
  schema: Schema;
  hasSelection: boolean;
  onApply: DocumentAssistantFormProps["onApply"];
}) {
  const [applyError, setApplyError] = useState<string>();
  const { markdown, action, reply } = result;
  const preview = useMemo(() => {
    if (!markdown) return null;
    try {
      return renderDocumentContent(
        parseGeneratedMarkdown(schema, markdown).toJSON() as JSONContent,
        previewMapping,
      );
    } catch {
      return undefined;
    }
  }, [schema, markdown]);
  const answerInsertable = useMemo(
    () => !markdown && Boolean(reply) && canInsert(schema, reply),
    [markdown, reply, schema],
  );
  const apply = (content: string, how: DocumentAssistantAction) =>
    setApplyError(onApply(content, how) ?? undefined);
  const insertLabel = hasSelection
    ? "Insert after selection"
    : "Insert at cursor";
  const replaceFirst = hasSelection && action === "replace";

  return (
    <div className="flex min-w-0 flex-col gap-2">
      {reply ? <AssistantMarkdown text={reply} /> : null}
      {preview ? (
        <section
          aria-label="Generated preview"
          className="document-prose border-line bg-surface-2 overflow-auto rounded-lg border p-3"
        >
          {preview}
        </section>
      ) : null}
      {preview === undefined ? (
        <p role="alert" className="text-danger m-0 text-sm">
          The proposed content could not be previewed. Ask again.
        </p>
      ) : null}
      {applyError ? (
        <p role="alert" className="text-danger m-0 text-sm">
          {applyError}
        </p>
      ) : null}
      {preview && markdown ? (
        <div className="flex flex-wrap gap-2">
          {replaceFirst ? (
            <Button
              type="button"
              size="sm"
              onClick={() => apply(markdown, "replace")}
            >
              Replace selection
            </Button>
          ) : null}
          <Button
            type="button"
            size="sm"
            variant={replaceFirst ? "outline" : "default"}
            onClick={() => apply(markdown, "insert")}
          >
            {insertLabel}
          </Button>
          {hasSelection && !replaceFirst ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => apply(markdown, "replace")}
            >
              Replace selection
            </Button>
          ) : null}
        </div>
      ) : null}
      {answerInsertable ? (
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => apply(reply, "insert")}
          >
            Insert answer
          </Button>
        </div>
      ) : null}
    </div>
  );
}
