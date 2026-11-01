export function modelOutputFailure(
  result: {
    text: string;
    finishReason: string;
  },
  options: { allowEmpty?: boolean } = {},
): string | null {
  if (result.finishReason !== "stop")
    return "the model returned incomplete content";
  if (!options.allowEmpty && !result.text.trim())
    return "the model returned no content";
  return null;
}
