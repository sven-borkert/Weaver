import { CoreError } from "../errors";
import { hasCapability, type UserSecurityContext } from "../security/context";

export function assertLlmAdmin(actor: UserSecurityContext): void {
  if (!hasCapability(actor, "llm:admin")) {
    throw new CoreError(
      "FORBIDDEN",
      "LLM administration requires the llm:admin capability",
    );
  }
}
