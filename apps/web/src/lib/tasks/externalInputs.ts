import {
  EXTERNAL_ERROR_MESSAGES,
  EXTERNAL_UNKNOWN_WARNING,
} from "@weaver/core/externalMcp/errors";
import { z } from "zod";
import type {
  AvailableExternalTool,
  ExternalInput,
} from "@weaver/core/externalMcp/types";

export class ExternalInputFieldError extends Error {
  readonly field = "externalInputs";
}

export function buildLiteralInput(
  name: string,
  toolId: string,
  jsonText: string,
): ExternalInput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new ExternalInputFieldError("Enter valid JSON arguments.");
  }
  const object = z.record(z.string().min(1), z.json()).safeParse(parsed);
  if (!object.success)
    throw new ExternalInputFieldError(
      "Arguments must be a JSON object with named properties.",
    );
  return {
    name,
    toolId,
    arguments: Object.fromEntries(
      Object.entries(object.data).map(([key, value]) => [
        key,
        { kind: "literal" as const, value },
      ]),
    ),
  };
}

export function literalArgumentsText(input: ExternalInput): string {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(input.arguments)
        .filter(([, binding]) => binding.kind === "literal")
        .map(([key, binding]) => [
          key,
          binding.kind === "literal" ? binding.value : null,
        ]),
    ),
    null,
    2,
  );
}

export function eligibleTaskTools(
  source: AvailableExternalTool[],
  output: AvailableExternalTool[],
): AvailableExternalTool[] {
  const eligible = (tool: AvailableExternalTool) => tool.effect === "read";
  const ids = new Set(output.filter(eligible).map((tool) => tool.id));
  return source.filter((tool) => eligible(tool) && ids.has(tool.id));
}

const failureLabels: Record<string, string> = {
  ...EXTERNAL_ERROR_MESSAGES,
  EXTERNAL_APPROVAL_REQUIRED:
    "The connection asked before every call when this ran.",
  EXTERNAL_INPUT_INVALID: "Review the external input arguments.",
  EXTERNAL_CONTEXT_LIMIT:
    "The external input exceeded the report context limit.",
};
const summarySchema = z.object({
  name: z.string().max(120),
  status: z.enum(["completed", "failed"]),
  retrievedAt: z.iso.datetime({ offset: true }).nullable(),
  truncated: z.boolean(),
  errorCode: z.string().nullable().optional(),
  outcome: z.enum(["completed", "denied", "failed", "unknown"]).optional(),
});
export function readExternalInputSummaries(context: unknown) {
  const envelope = z
    .object({ externalInputs: z.array(z.unknown()).max(5) })
    .safeParse(context);
  if (!envelope.success) return [];
  return envelope.data.externalInputs.flatMap((item) => {
    const parsed = summarySchema.safeParse(item);
    if (!parsed.success) return [];
    const { name, status, retrievedAt, truncated, errorCode, outcome } =
      parsed.data;
    return [
      {
        name,
        status,
        retrievedAt,
        truncated,
        failure:
          status === "failed"
            ? `${Object.hasOwn(failureLabels, errorCode ?? "") ? failureLabels[errorCode!] : "External input failed."}${outcome === "unknown" ? ` ${EXTERNAL_UNKNOWN_WARNING}` : ""}`
            : null,
      },
    ];
  });
}
