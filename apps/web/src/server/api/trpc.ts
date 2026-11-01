import { getOidcProvider } from "@weaver/config/server";
import { env } from "~/env";
import { createPinnedFetch } from "@weaver/config/outboundFetch";
import { randomUUID } from "node:crypto";
import { publicErrorShape } from "./errorPrivacy";
import { initTRPC, TRPCError } from "@trpc/server";
import {
  createApiKeyIssuer,
  createPasswordChanger,
  createUserAdministrator,
} from "@weaver/auth";
import { withDiagnosticContext } from "@weaver/core/diagnostics/context";
import { captureError, emitDiagnostic } from "@weaver/core/diagnostics/writer";
import { isCoreError } from "@weaver/core/errors";
import {
  createSessionSecurityContext,
  type SecurityContext,
} from "@weaver/core/security/context";
import { loadEncryptionKeyRing } from "@weaver/core/security/encryption";
import superjson from "superjson";
import { ZodError } from "zod";

import { auth, getSessionUser, type SessionUser } from "~/server/auth";
import { db } from "@weaver/db";
import { toTRPCError } from "./coreError";

export const createTRPCContext = async (opts: {
  headers: Headers;
  resHeaders?: Headers;
}) => {
  const user = await getSessionUser(opts.headers);
  return {
    db,
    session: user ? { user } : null,
    security: user
      ? createSessionSecurityContext({
          userId: user.id,
          globalRole: user.role,
          sessionId: user.sessionId,
        })
      : null,
    // Keys are minted through Better Auth; core owns the policy around it.
    apiKeyIssuer: createApiKeyIssuer(auth),
    // Accounts are administered through Better Auth; core owns the policy.
    userAdministrator: createUserAdministrator(auth),
    // Self-service password change re-verifies the caller's own session.
    passwordChanger: createPasswordChanger(auth),
    encryptionKeys: loadEncryptionKeyRing(),
    llmFetch: createPinnedFetch(),
    oidcFetch: createPinnedFetch(),
    oidcFallback: getOidcProvider(env),
    ...opts,
  };
};

function fieldFromCause(cause: unknown): string | undefined {
  if (cause && typeof cause === "object" && "field" in cause) {
    const field = (cause as { field?: unknown }).field;
    return typeof field === "string" ? field : undefined;
  }
  return undefined;
}

function conflictsFromCause(cause: unknown): unknown {
  if (cause && typeof cause === "object" && "conflicts" in cause) {
    return (cause as { conflicts?: unknown }).conflicts ?? null;
  }
  return null;
}

function headCommitShaFromCause(cause: unknown): string | null {
  if (cause && typeof cause === "object" && "headCommitSha" in cause) {
    const headCommitSha = (cause as { headCommitSha?: unknown }).headCommitSha;
    return typeof headCommitSha === "string" ? headCommitSha : null;
  }
  return null;
}

const INTERNAL_CODES = new Set([
  "INTERNAL_SERVER_ERROR",
  "NOT_IMPLEMENTED",
  "BAD_GATEWAY",
  "SERVICE_UNAVAILABLE",
  "GATEWAY_TIMEOUT",
]);

function diagnosticReferenceOf(error: unknown): string | null {
  const value = (error as { diagnosticReference?: unknown } | null)
    ?.diagnosticReference;
  return typeof value === "string" ? value : null;
}

const t = initTRPC.context<typeof createTRPCContext>().create({
  transformer: superjson,
  errorFormatter({ shape, error }) {
    const safeShape = publicErrorShape(
      shape,
      process.env.NODE_ENV === "development",
      diagnosticReferenceOf(error),
    );
    const internal = shape.data.httpStatus >= 500;
    return {
      ...safeShape,
      data: {
        ...safeShape.data,
        zodError:
          !internal && error.cause instanceof ZodError
            ? error.cause.flatten()
            : null,
        field: internal ? undefined : fieldFromCause(error.cause),
        conflicts: internal ? null : conflictsFromCause(error.cause),
        headCommitSha: internal ? null : headCommitShaFromCause(error.cause),
      },
    };
  },
});

export const createCallerFactory = t.createCallerFactory;
export const createTRPCRouter = t.router;

/** Verbose-only: mutations and failed queries, never successful queries. */
const diagnosticsMiddleware = t.middleware(
  async ({ ctx, next, path, type }) => {
    const started = Date.now();
    const requestId = randomUUID();
    const result = await withDiagnosticContext(
      {
        requestId,
        userId: ctx.security?.userId,
        credentialId: ctx.security?.credentialId,
      },
      () => next(),
    );
    if (!result.ok && INTERNAL_CODES.has(result.error.code)) {
      const reference = captureError({
        event: "trpc.error",
        message: `${path} ${result.error.code}`,
        error: result.error.cause ?? result.error,
        durationMs: Date.now() - started,
        requestId,
        userId: ctx.security?.userId,
        credentialId: ctx.security?.credentialId,
        details: { path, type, errorCode: result.error.code },
      });
      Object.assign(result.error, { diagnosticReference: reference });
    } else if (ctx.security && (type === "mutation" || !result.ok)) {
      const errorCode = result.ok ? null : result.error.code;
      emitDiagnostic({
        event: type === "mutation" ? "trpc.mutation" : "trpc.query.failed",
        severity: result.ok ? "info" : "warn",
        verbose: true,
        message: `${path} ${result.ok ? "ok" : errorCode}`,
        durationMs: Date.now() - started,
        outcome: result.ok ? "ok" : "error",
        requestId,
        userId: ctx.security?.userId,
        credentialId: ctx.security?.credentialId,
        details: { path, type, errorCode },
      });
    }
    return result;
  },
);

export const publicProcedure = t.procedure.use(diagnosticsMiddleware);

// The only two procedures a mustChangePassword=true user may still call —
// account.me so the UI can render who's signed in, and the mutation itself.
// Miss one and the user is either exposed to app data or locked out with no
// recovery path (there is no email in this system).
const PASSWORD_CHANGE_GATE_ALLOWLIST: ReadonlySet<string> = new Set([
  "account.me",
  "account.changePassword",
]);

// Better Auth already loaded and validated the user row for this request.
const requireActiveUser = t.middleware(({ ctx, next, path }) => {
  if (!ctx.session?.user?.id || !ctx.security) {
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }
  if (
    ctx.session.user.mustChangePassword &&
    !PASSWORD_CHANGE_GATE_ALLOWLIST.has(path)
  ) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Password change required",
    });
  }
  const session: { user: SessionUser } = { user: ctx.session.user };
  const security: SecurityContext = ctx.security;
  return next({ ctx: { ...ctx, session, security } });
});

const mapCoreErrors = t.middleware(async ({ next }) => {
  const result = await next();
  if (!result.ok && isCoreError(result.error.cause)) {
    throw toTRPCError(result.error.cause);
  }
  return result;
});

export const authedProcedure = t.procedure
  .use(diagnosticsMiddleware)
  .use(mapCoreErrors)
  .use(requireActiveUser);

const enforceRole = (...roles: Array<"Admin" | "User">) =>
  t.middleware(({ ctx, next }) => {
    if (!ctx.security) throw new TRPCError({ code: "UNAUTHORIZED" });
    const security: SecurityContext = ctx.security;
    if (!roles.includes(security.globalRole)) {
      throw new TRPCError({ code: "FORBIDDEN" });
    }
    return next({ ctx: { ...ctx, security } });
  });

export const adminProcedure = t.procedure
  .use(diagnosticsMiddleware)
  .use(mapCoreErrors)
  .use(requireActiveUser)
  .use(enforceRole("Admin"));
