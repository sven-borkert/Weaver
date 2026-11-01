"use client";
import { useFieldArray, type UseFormReturn } from "react-hook-form";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { ExamTextarea } from "./ExamTextarea";
import { newChoice, type ExamFormValues } from "./examForm";
export function QuestionFields({
  form,
  index,
  count,
  onMove,
  onRemove,
}: {
  form: UseFormReturn<ExamFormValues>;
  index: number;
  count: number;
  onMove: (to: number) => void;
  onRemove: () => void;
}) {
  const q = form.watch(`questions.${index}`);
  const errors = form.formState.errors.questions?.[index];
  return (
    <section className="border-line space-y-3 rounded-lg border p-4">
      <header className="flex flex-wrap items-center gap-2">
        <h3>
          Question {index + 1} ·{" "}
          {q.kind === "multiple_choice" ? "Multiple choice" : "Free text"}
        </h3>
        <Button
          type="button"
          variant="outline"
          disabled={!index}
          onClick={() => onMove(index - 1)}
        >
          Move up
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={index === count - 1}
          onClick={() => onMove(index + 1)}
        >
          Move down
        </Button>
        <Button type="button" variant="outline" onClick={onRemove}>
          Remove question
        </Button>
      </header>
      <label htmlFor={`prompt-${index}`}>Prompt</label>
      <ExamTextarea
        value={q.prompt ?? ""}
        id={`prompt-${index}`}
        aria-describedby={`prompt-help-${index}`}
        maxLength={10000}
        aria-invalid={!!errors?.prompt}
        {...form.register(`questions.${index}.prompt`)}
      />
      <p id={`prompt-help-${index}`} className="text-text-3 text-sm">
        Make the question self-contained. If it refers to example code, include
        the complete example here in a fenced Markdown code block with its
        language (for example, ```python). Trainees can open it with View code
        example. Keep solutions and grading guidance in Expected answer.
      </p>
      {errors?.prompt ? (
        <p role="alert" className="text-danger">
          {errors.prompt.message}
        </p>
      ) : null}
      <label htmlFor={`weight-${index}`}>Weight</label>
      <Input
        id={`weight-${index}`}
        type="number"
        min={1}
        max={1000}
        {...form.register(`questions.${index}.weight`, { valueAsNumber: true })}
      />
      {errors?.weight ? (
        <p role="alert" className="text-danger">
          {errors.weight.message}
        </p>
      ) : null}
      {q.kind === "multiple_choice" ? (
        <MultipleChoiceFields key={index} form={form} index={index} />
      ) : null}
      <label htmlFor={`expected-${index}`}>Expected answer</label>
      <ExamTextarea
        value={q.expectedAnswer ?? ""}
        id={`expected-${index}`}
        maxLength={10000}
        {...form.register(`questions.${index}.expectedAnswer`)}
      />
    </section>
  );
}

function MultipleChoiceFields({
  form,
  index,
}: {
  form: UseFormReturn<ExamFormValues>;
  index: number;
}) {
  const q = form.watch(`questions.${index}`);
  const choices = useFieldArray({
    control: form.control,
    name: `questions.${index}.choices`,
  });
  const errors = form.formState.errors.questions?.[index];
  return (
    <>
      <label className="flex gap-2">
        <input
          type="checkbox"
          {...form.register(`questions.${index}.allowMultiple`)}
        />
        Allow multiple answers
      </label>
      {choices.fields.map((c, j) => (
        <div key={c.id} className="flex items-center gap-2">
          <label className="sr-only" htmlFor={`choice-${index}-${j}`}>
            Choice {j + 1}
          </label>
          <Input
            id={`choice-${index}-${j}`}
            maxLength={2000}
            {...form.register(`questions.${index}.choices.${j}.text`)}
          />
          <label className="flex gap-2">
            <input
              type={q.allowMultiple ? "checkbox" : "radio"}
              name={`correct-${index}`}
              checked={q.choices?.[j]?.correct ?? false}
              onChange={(e) => {
                if (!q.allowMultiple)
                  q.choices?.forEach((_, n) =>
                    form.setValue(
                      `questions.${index}.choices.${n}.correct`,
                      n === j,
                      { shouldDirty: true },
                    ),
                  );
                else
                  form.setValue(
                    `questions.${index}.choices.${j}.correct`,
                    e.target.checked,
                    { shouldDirty: true },
                  );
              }}
            />
            Correct
          </label>
          <Button
            type="button"
            variant="outline"
            disabled={choices.fields.length <= 2}
            onClick={() => choices.remove(j)}
          >
            Remove choice
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        disabled={choices.fields.length >= 10}
        onClick={() => choices.append(newChoice())}
      >
        Add choice
      </Button>
      {errors?.choices ? (
        <p role="alert" className="text-danger">
          {errors.choices.message ??
            errors.choices.root?.message ??
            "Check the choices and select the correct answer."}
        </p>
      ) : null}
    </>
  );
}
