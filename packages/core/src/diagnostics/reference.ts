export const DIAGNOSTIC_REFERENCE_LENGTH = 8;
export const DIAGNOSTIC_REFERENCE_PATTERN = /^[0-9a-f]{8}$/;

export function diagnosticReference(
  eventId: string | null | undefined,
): string | null {
  if (typeof eventId !== "string") return null;
  const reference = eventId.slice(0, DIAGNOSTIC_REFERENCE_LENGTH).toLowerCase();
  return DIAGNOSTIC_REFERENCE_PATTERN.test(reference) ? reference : null;
}

/** Appends ` (ref xxxxxxxx)`; with `maxChars` the message is cut so the suffix always survives. */
export function withReference(
  message: string,
  reference: string | null,
  maxChars?: number,
): string {
  if (!reference)
    return maxChars === undefined ? message : message.slice(0, maxChars);
  const suffix = ` (ref ${reference})`;
  const body =
    maxChars === undefined
      ? message
      : message.slice(0, Math.max(0, maxChars - suffix.length));
  return `${body}${suffix}`;
}

/** Primary-key range covering every uuid that starts with the reference. */
export function referenceIdBounds(reference: string): {
  gte: string;
  lte: string;
} {
  return {
    gte: `${reference}-0000-0000-0000-000000000000`,
    lte: `${reference}-ffff-ffff-ffff-ffffffffffff`,
  };
}
