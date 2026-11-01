import { emitDiagnostic } from "@weaver/core/diagnostics/writer";
import { createSlidingWindowLimiter } from "@weaver/core/security/rateLimit";

const reports = createSlidingWindowLimiter({ limit: 60, windowMs: 60_000 });
const MAX_REPORT_BYTES = 8192;

export async function POST(req: Request) {
  if (!reports.check("csp").allowed) return new Response(null, { status: 429 });
  if (!req.body) return new Response(null, { status: 400 });
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_REPORT_BYTES) {
        await reader.cancel();
        return new Response(null, { status: 413 });
      }
      chunks.push(value);
    }
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const envelope: unknown = Array.isArray(parsed) ? parsed[0] : parsed;
    const report: unknown =
      envelope && typeof envelope === "object"
        ? ((envelope as Record<string, unknown>)["csp-report"] ??
          (envelope as Record<string, unknown>).body)
        : null;
    if (!report || typeof report !== "object")
      return new Response(null, { status: 400 });
    const fields = report as Record<string, unknown>;
    const directive =
      fields["effective-directive"] ?? fields.effectiveDirective;
    const known = new Set([
      "script-src",
      "script-src-elem",
      "script-src-attr",
      "style-src",
      "style-src-elem",
      "style-src-attr",
      "img-src",
      "connect-src",
      "font-src",
      "object-src",
      "frame-src",
      "frame-ancestors",
      "base-uri",
      "default-src",
    ]);
    if (typeof directive !== "string" || !known.has(directive))
      return new Response(null, { status: 400 });
    emitDiagnostic({
      event: "runtime.error",
      severity: "warn",
      message: "Browser content security policy violation",
      details: { source: "csp", directive },
    });
    return new Response(null, { status: 204 });
  } catch {
    return new Response(null, { status: 400 });
  } finally {
    reader.releaseLock();
  }
}
