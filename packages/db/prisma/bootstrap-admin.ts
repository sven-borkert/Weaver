import { parseServerEnv } from "@weaver/config/server";
import { bootstrapAdmin, createWeaverAuth } from "@weaver/auth";
import { createPrismaClient } from "../src/factory";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

const connectionString = required("DATABASE_URL");
const secret = required("AUTH_SECRET");
const email = required("WEAVER_BOOTSTRAP_ADMIN_EMAIL");
const password = required("WEAVER_BOOTSTRAP_ADMIN_PASSWORD");
if (password.length < 12) {
  throw new Error(
    "WEAVER_BOOTSTRAP_ADMIN_PASSWORD must be at least 12 characters",
  );
}
const trimmedName = process.env.WEAVER_BOOTSTRAP_ADMIN_NAME?.trim();
const name =
  trimmedName === undefined || trimmedName === ""
    ? "Administrator"
    : trimmedName;

const env = parseServerEnv(process.env);
const db = createPrismaClient({
  connectionString,
  max: env.DATABASE_POOL_MAX,
  statementTimeoutMs: env.DATABASE_STATEMENT_TIMEOUT_MS,
  log: ["error"],
});
const auth = createWeaverAuth({
  db,
  secret,
  baseURL: process.env.AUTH_URL ?? "http://localhost:3000",
});

bootstrapAdmin(auth, {
  email,
  password,
  name,
  recoverInterrupted: process.env.WEAVER_BOOTSTRAP_ADMIN_RECOVER === "true",
})
  .then((result) => {
    if ("skipped" in result) {
      console.log("Bootstrap skipped: users already exist.");
    } else {
      console.log("Bootstrap global Admin %s (%s)", email, result.id);
    }
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
