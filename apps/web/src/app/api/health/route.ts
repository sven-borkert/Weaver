// Liveness probe for container HEALTHCHECK / orchestrators. Unauthenticated
// and dependency-free (no DB call).
import { getAppVersionInfo } from "~/lib/appVersion";

export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({ status: "ok", ...getAppVersionInfo() });
}
