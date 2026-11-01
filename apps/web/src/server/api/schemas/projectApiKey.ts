import { z } from "zod";
import { projectApiTargetInput as coreProjectApiTargetInput } from "@weaver/core/projectApi/schemas";

export {
  createProjectApiKeyInput,
  projectApiKeyIdInput,
  projectApiProjectInput,
  updateProjectApiKeyInput,
} from "@weaver/core/projectApi/schemas";

// useInfiniteQuery adds `direction`, which the strict core schema rejects.
export const projectApiTargetInput = coreProjectApiTargetInput
  .extend({ direction: z.enum(["forward", "backward"]).optional() })
  .transform(({ direction: _direction, ...input }) => input);
