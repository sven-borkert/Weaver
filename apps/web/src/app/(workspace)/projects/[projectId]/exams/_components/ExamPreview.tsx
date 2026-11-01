"use client";
import { AssistantMarkdown } from "~/components/assistant/AssistantMarkdown";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "~/components/ui/dialog";
import type { ExamFormValues } from "./examForm";
import { ExamQuestionPrompt } from "./ExamQuestionPrompt";
export function ExamPreview({ values }: { values: ExamFormValues }) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button type="button" variant="outline">
          Preview
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{values.title || "Exam preview"}</DialogTitle>
          <DialogDescription>
            {values.timeLimitMinutes} minutes · {values.questions.length}{" "}
            questions
          </DialogDescription>
        </DialogHeader>
        <AssistantMarkdown text={values.instructions ?? ""} />
        {values.questions.map((q, i) => (
          <section key={q.id ?? i} className="space-y-2">
            <h3>
              Question {i + 1} · {q.weight} points
            </h3>
            <ExamQuestionPrompt text={q.prompt} />
            {q.choices?.map((c, j) => (
              <label key={c.id ?? j} className="flex gap-2">
                <input disabled type={q.allowMultiple ? "checkbox" : "radio"} />
                {c.text}
              </label>
            ))}
            {q.kind === "free_text" ? (
              <textarea
                disabled
                aria-label={`Answer ${i + 1}`}
                className="border-line w-full rounded border"
              />
            ) : null}
          </section>
        ))}
      </DialogContent>
    </Dialog>
  );
}
