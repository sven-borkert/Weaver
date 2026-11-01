// Used by `pnpm dlx @better-auth/cli@latest generate --config packages/auth/scripts/schema-preview.ts --output <file>`
// to print the Prisma models Better Auth expects; compare against packages/db/prisma/schema.prisma.
// The OAuth provider seeds its resource row at init, so the fake database must
// answer every model/method call instead of being `{}`.
import { createWeaverAuth } from "../src/index";

const noopModel = new Proxy({}, { get: () => async () => null });
const fakeDb = new Proxy(
  {},
  {
    get: (_target, property) =>
      property === "$transaction" ? undefined : noopModel,
  },
);

export const auth = createWeaverAuth({
  db: fakeDb,
  secret: "schema-preview-secret-not-used-at-runtime",
  baseURL: "http://localhost:3000",
  mcp: {
    resource: "http://localhost:3000/api/mcp",
    loginPage: "/login",
    consentPage: "/consent",
  },
});
