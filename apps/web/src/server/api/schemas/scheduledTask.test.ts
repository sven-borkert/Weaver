import { expect, it } from "vitest";
import { createTaskInput, updateTaskInput } from "./scheduledTask";
const definition = {
  name: "Report",
  instruction: "Summarize",
  scope: { kind: "project", projectId: "f87601ef-8fd4-48f8-b1b4-27103227bcf4" },
  outputProjectId: "f87601ef-8fd4-48f8-b1b4-27103227bcf4",
  outputFolderPath: [],
  schedule: { kind: "hourly", minute: 0 },
  timezone: "UTC",
};
it("defaults create inputs but preserves omitted update inputs through the API schema", () => {
  expect(createTaskInput.parse(definition).externalInputs).toEqual([]);
  expect(
    updateTaskInput.parse({ ...definition, taskId: definition.outputProjectId })
      .externalInputs,
  ).toBeUndefined();
  expect(
    updateTaskInput.parse({
      ...definition,
      taskId: definition.outputProjectId,
      externalInputs: [],
    }).externalInputs,
  ).toEqual([]);
});
