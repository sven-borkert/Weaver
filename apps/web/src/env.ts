import { createEnv } from "@t3-oss/env-nextjs";
import {
  assertProductionAuthUrl,
  getOidcProvider,
  serverEnvShape,
} from "@weaver/config/server";
import { z } from "zod";

const clientEnvShape = {
  NEXT_PUBLIC_BASE_PATH: z
    .string()
    .regex(/^\/[^/\s]+(\/[^/\s]+)*$/)
    .optional(),
};

export const env = createEnv<typeof serverEnvShape, typeof clientEnvShape>({
  server: serverEnvShape,
  client: clientEnvShape,
  runtimeEnv: process.env as Record<
    keyof typeof serverEnvShape | "NEXT_PUBLIC_BASE_PATH",
    string | undefined
  >,
  skipValidation:
    process.env.NEXT_PHASE === "phase-production-build" &&
    Boolean(process.env.SKIP_ENV_VALIDATION),
  emptyStringAsUndefined: true,
});

if (process.env.NEXT_PHASE !== "phase-production-build") {
  assertProductionAuthUrl(env);
  getOidcProvider(env);
}
