import { APP_BASE_PATH, stripBasePath } from "~/lib/basePath";

export function safeLoginCallbackUrl(
  callbackUrl: string | null | undefined,
  basePath = APP_BASE_PATH,
): string {
  if (
    !callbackUrl ||
    !callbackUrl.startsWith("/") ||
    callbackUrl.startsWith("//")
  ) {
    return "/";
  }
  if (callbackUrl.includes("\\") || /[\u0000-\u001f\u007f]/.test(callbackUrl)) {
    return "/";
  }

  try {
    const parsed = new URL(callbackUrl, "http://weaver.local");
    if (parsed.origin !== "http://weaver.local") return "/";
    const stripped = stripBasePath(
      `${parsed.pathname}${parsed.search}${parsed.hash}`,
      basePath,
    );
    return stripped.startsWith("//") ? "/" : stripped;
  } catch {
    return "/";
  }
}
