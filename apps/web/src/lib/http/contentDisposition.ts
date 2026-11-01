/** HTTP headers are Latin-1: an ASCII fallback plus the RFC 5987 UTF-8 form. */
export function attachmentDisposition(filename: string): string {
  const fallback = [...filename]
    .map((char) =>
      /^[\x20-\x7e]$/.test(char) && !/["\\]/.test(char) ? char : "_",
    )
    .join("");
  const encoded = encodeURIComponent(filename).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
