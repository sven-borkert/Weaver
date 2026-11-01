import { useEffect } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { useForm, useFieldArray, type UseFormReturn } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { afterEach, expect, it } from "vitest";
import { examDefinitionInputSchema } from "@weaver/core/exams/schema";
import { QuestionFields } from "./QuestionFields";
import { newQuestion, type ExamFormValues } from "./examForm";

let form: UseFormReturn<ExamFormValues>;
let move: (from: number, to: number) => void;
let renderer: ReactTestRenderer | undefined;
function Harness({ questions }: { questions: ExamFormValues["questions"] }) {
  const activeForm = useForm<ExamFormValues>({
    defaultValues: { title: "Safety", timeLimitMinutes: 5, questions },
    resolver: zodResolver(examDefinitionInputSchema),
  });
  const fields = useFieldArray({
    control: activeForm.control,
    name: "questions",
    keyName: "fieldKey",
  });
  useEffect(() => {
    form = activeForm;
    move = fields.move;
  }, [activeForm, fields.move]);
  return (
    <>
      {fields.fields.map((question, index) => (
        <QuestionFields
          key={question.fieldKey}
          form={activeForm}
          index={index}
          count={fields.fields.length}
          onMove={(to) => fields.move(index, to)}
          onRemove={() => fields.remove(index)}
        />
      ))}
    </>
  );
}
afterEach(async () => {
  if (renderer) await act(async () => renderer?.unmount());
  renderer = undefined;
});
it("submits a free-text question without creating a forbidden choices array", async () => {
  await act(async () => {
    renderer = create(
      <Harness
        questions={[
          { ...newQuestion("free_text"), prompt: "Explain the response" },
        ]}
      />,
    );
  });
  expect(form.getValues("questions.0")).not.toHaveProperty("choices");
  let valid = false;
  await act(async () => {
    valid = await form.trigger();
  });
  expect(valid).toBe(true);
});
it("keeps choices on their multiple-choice question when questions are reordered", async () => {
  const choices = [
    { id: "11111111-1111-4111-8111-111111111111", text: "Stop", correct: true },
    { id: "22222222-2222-4222-8222-222222222222", text: "Run", correct: false },
  ];
  await act(async () => {
    renderer = create(
      <Harness
        questions={[
          { ...newQuestion("multiple_choice"), prompt: "Choose", choices },
          { ...newQuestion("free_text"), prompt: "Explain" },
        ]}
      />,
    );
  });
  await act(async () => move(0, 1));
  expect(form.getValues("questions.0")).not.toHaveProperty("choices");
  expect(form.getValues("questions.1.choices")).toEqual(choices);
  let valid = false;
  await act(async () => {
    valid = await form.trigger();
  });
  expect(valid).toBe(true);
});
