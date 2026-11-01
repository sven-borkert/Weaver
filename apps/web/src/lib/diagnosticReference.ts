const SUFFIX = /\s\(ref ([0-9a-f]{8})\)$/;

export function splitReference(message: string | null): {
  text: string;
  reference: string | null;
} {
  if (!message) return { text: "", reference: null };
  const match = SUFFIX.exec(message);
  if (!match) return { text: message, reference: null };
  return { text: message.slice(0, match.index), reference: match[1]! };
}
