import { expect, it } from "vitest";
import {
  createLlmModelInput,
  updateLlmModelInput,
  importLlmModelsInput,
} from "./llmSchemas";
const id = "00000000-0000-4000-8000-000000000001";
const model = {
  providerModelId: "test",
  displayName: "Test",
  capabilities: ["chat"],
};
it.each(["contextWindow", "maxOutputTokens"])(
  "rejects zero %s across model entry points",
  (field) => {
    expect(
      createLlmModelInput.safeParse({ connectionId: id, ...model, [field]: 0 })
        .success,
    ).toBe(false);
    expect(
      updateLlmModelInput.safeParse({ modelId: id, [field]: 0 }).success,
    ).toBe(false);
    expect(
      importLlmModelsInput.safeParse({
        connectionId: id,
        updateExisting: true,
        models: [{ ...model, [field]: 0 }],
      }).success,
    ).toBe(false);
    expect(
      createLlmModelInput.safeParse({ connectionId: id, ...model, [field]: 1 })
        .success,
    ).toBe(true);
  },
);
