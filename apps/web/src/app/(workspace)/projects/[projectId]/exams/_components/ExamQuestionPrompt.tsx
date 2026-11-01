"use client";
import { useMemo } from "react";
import { Code2 } from "lucide-react";
import { parseDocumentBody } from "@weaver/core/editor/markdown";
import { withAssistantBasePath } from "~/components/assistant/AssistantMarkdown";
import { renderDocumentContent } from "~/lib/editor/render";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "~/components/ui/dialog";

function CodeExample({ code, language }: { code: string; language: string }) {
  return (
    <div className="not-prose my-3">
      <Dialog>
        <DialogTrigger asChild>
          <Button type="button" variant="outline">
            <Code2 aria-hidden="true" />
            View code example{language ? ` (${language})` : ""}
          </Button>
        </DialogTrigger>
        <DialogContent className="max-h-[85vh] sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Code example</DialogTitle>
            <DialogDescription>
              {language
                ? `${language} example for this question.`
                : "Example for this question."}{" "}
              Read the code below to answer the question.
            </DialogDescription>
          </DialogHeader>
          <pre className="bg-surface-2 border-line max-h-[60vh] overflow-auto rounded-lg border p-4 text-sm">
            <code className={language ? `language-${language}` : undefined}>
              {code}
            </code>
          </pre>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function ExamQuestionPrompt({ text }: { text: string }) {
  const content = useMemo(
    () =>
      renderDocumentContent(withAssistantBasePath(parseDocumentBody(text)), {
        codeBlock: ({ node }) => (
          <CodeExample
            code={node.textContent}
            language={
              typeof node.attrs.language === "string" ? node.attrs.language : ""
            }
          />
        ),
      }),
    [text],
  );
  return (
    <div className="document-prose text-text text-[14px] leading-relaxed">
      {content}
    </div>
  );
}
