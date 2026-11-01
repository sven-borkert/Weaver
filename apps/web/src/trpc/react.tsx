"use client";

import { QueryClientProvider } from "@tanstack/react-query";
import { loggerLink } from "@trpc/client";
import { createTRPCReact } from "@trpc/react-query";
import { type inferRouterInputs, type inferRouterOutputs } from "@trpc/server";
import { createContext, useContext, useEffect, useState } from "react";
import { authClient } from "~/lib/authClient";
import SuperJSON from "superjson";

import type { AppRouter } from "~/server/api/root";
import { withBasePath } from "~/lib/basePath";
import { createConfiguredTRPCLink } from "./http-transport";
import { logTrpcOperation, shouldEnableTrpcLogger } from "./logger";
import { createQueryClient, retireQueryClient } from "./query-client";

const PrincipalContext = createContext<string | null>(null);
export const usePrincipalId = () => useContext(PrincipalContext);

export const api = createTRPCReact<AppRouter>();

/**
 * Inference helper for inputs.
 *
 * @example type HelloInput = RouterInputs['example']['hello']
 */
export type RouterInputs = inferRouterInputs<AppRouter>;

/**
 * Inference helper for outputs.
 *
 * @example type HelloOutput = RouterOutputs['example']['hello']
 */
export type RouterOutputs = inferRouterOutputs<AppRouter>;

export function TRPCReactProvider(props: {
  children: React.ReactNode;
  initialPrincipalId: string | null;
}) {
  const session = authClient.useSession();
  const [observedPrincipalId, setObservedPrincipalId] = useState(
    props.initialPrincipalId,
  );
  const sessionExpired =
    !session.isPending &&
    !session.error &&
    !session.data &&
    props.initialPrincipalId !== null;
  const principalId =
    session.isPending || session.error || sessionExpired
      ? observedPrincipalId
      : (session.data?.user.id ?? null);
  if (principalId !== observedPrincipalId) setObservedPrincipalId(principalId);
  const serverPrincipalChanged =
    props.initialPrincipalId !== null &&
    principalId !== props.initialPrincipalId;
  useEffect(() => {
    if (serverPrincipalChanged) window.location.reload();
  }, [serverPrincipalChanged]);
  if (serverPrincipalChanged) return null;

  return (
    <PrincipalContext.Provider value={principalId}>
      <PrincipalTRPCProvider key={principalId ?? "anonymous"}>
        {props.children}
        {sessionExpired ? (
          <div
            role="alert"
            className="border-line bg-surface text-text fixed right-4 bottom-4 z-50 max-w-sm rounded-lg border p-4 shadow-lg"
          >
            <p>
              Your session expired. Keep this tab open to preserve your draft.
            </p>
            <button
              type="button"
              className="text-brand-text mt-2 underline"
              onClick={() =>
                window.open(
                  withBasePath("/login"),
                  "_blank",
                  "noopener,noreferrer",
                )
              }
            >
              Sign in again in a new tab
            </button>
          </div>
        ) : null}
      </PrincipalTRPCProvider>
    </PrincipalContext.Provider>
  );
}

function PrincipalTRPCProvider(props: { children: React.ReactNode }) {
  const [queryClient] = useState(createQueryClient);
  useEffect(
    () => () => {
      retireQueryClient(queryClient);
    },
    [queryClient],
  );

  const [trpcClient] = useState(() =>
    api.createClient({
      links: [
        loggerLink({
          enabled: shouldEnableTrpcLogger,
          logger: logTrpcOperation,
        }),
        createConfiguredTRPCLink<AppRouter>({
          transformer: SuperJSON,
          url: getBaseUrl() + withBasePath("/api/trpc"),
          headers: () => {
            const headers = new Headers();
            headers.set("x-trpc-source", "nextjs-react");
            return headers;
          },
        }),
      ],
    }),
  );

  return (
    <QueryClientProvider client={queryClient}>
      <api.Provider client={trpcClient} queryClient={queryClient}>
        {props.children}
      </api.Provider>
    </QueryClientProvider>
  );
}

function getBaseUrl() {
  if (typeof window !== "undefined") return window.location.origin;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return `http://localhost:${process.env.PORT ?? 3000}`;
}
