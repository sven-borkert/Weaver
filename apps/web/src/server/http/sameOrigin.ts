import { env } from "~/env";

/** True only for a well-formed Origin header equal to the app's own origin. */
export function sameOrigin(req: Request): boolean {
  const supplied = req.headers.get("origin");
  if (!supplied) return false;
  try {
    const parsed = new URL(supplied);
    if (
      parsed.origin !== supplied ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash
    ) {
      return false;
    }
    return parsed.origin === new URL(env.AUTH_URL ?? req.url).origin;
  } catch {
    return false;
  }
}
