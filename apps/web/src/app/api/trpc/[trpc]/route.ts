import { redactSecrets } from "@weaver/core/security/redactSecrets";
import { type NextRequest } from "next/server";

import { env } from "~/env";
import { handleTrpcFetchRequest } from "~/server/api/http-transport";
import { appRouter } from "~/server/api/root";
import { createTRPCContext } from "~/server/api/trpc";

/**
 * This wraps the `createTRPCContext` helper and provides the required context for the tRPC API when
 * handling a HTTP request (e.g. when you make requests from Client Components).
 */
const createContext = async (req: NextRequest, resHeaders: Headers) => {
  return createTRPCContext({
    headers: req.headers,
    resHeaders,
  });
};

const handler = (req: NextRequest) =>
  handleTrpcFetchRequest({
    endpoint: "/api/trpc",
    appOrigin: env.AUTH_URL,
    req,
    router: appRouter,
    createContext: ({ resHeaders }) => createContext(req, resHeaders),
    onError: ({ path, error }) => {
      if (
        error.code === "INTERNAL_SERVER_ERROR" ||
        (env.NODE_ENV === "development" && error.code !== "UNAUTHORIZED")
      ) {
        console.error(
          `tRPC failed on ${path ?? "<no-path>"}: ${redactSecrets(error.stack ?? error.message)}`,
        );
      }
    },
  });

export { handler as GET, handler as POST };
