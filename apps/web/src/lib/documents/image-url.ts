import { APP_BASE_PATH, withBasePath } from "~/lib/basePath";

const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

export function resolveDocumentImageUrl(input: {
  projectId: string;
  documentPath: string;
  src: string;
  at?: string;
  basePath?: string;
}): string | undefined {
  const { src } = input;
  if (
    src.length === 0 ||
    SCHEME_RE.test(src) ||
    src.startsWith("/") ||
    src.includes("\\")
  )
    return undefined;
  const stack = input.documentPath.split("/").slice(0, -1);
  for (const segment of src.split("/")) {
    if (segment.length === 0) return undefined;
    if (segment === ".") continue;
    if (segment === "..") {
      if (stack.length === 0) return undefined;
      stack.pop();
      continue;
    }
    stack.push(segment);
  }
  const encoded = stack.map(encodeURIComponent).join("/");
  const query = input.at ? `?at=${input.at}` : "";
  return withBasePath(
    `/api/projects/${input.projectId}/files/${encoded}${query}`,
    input.basePath ?? APP_BASE_PATH,
  );
}
