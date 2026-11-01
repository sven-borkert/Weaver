import { CoreError } from "../errors";
import { hasCapability, type SecurityContext } from "../security/context";

export function assertLlmAdmin(actor: SecurityContext): void {
  if (!hasCapability(actor, "llm:admin")) {
    throw new CoreError(
      "FORBIDDEN",
      "LLM administration requires the llm:admin capability",
    );
  }
}
