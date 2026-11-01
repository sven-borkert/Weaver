import assert from "node:assert/strict";
import test from "node:test";
import { parseDatabaseUrl } from "./database-url.mjs";

test("parses query strings and escaped database credentials", () => {
  assert.deepEqual(
    parseDatabaseUrl(
      "postgresql://postgres:p%40ss%3Aword@127.0.0.1:5432/weaver?schema=public",
    ),
    { name: "weaver", password: "p@ss:word", user: "postgres", port: "5432" },
  );
});
test("rejects a public placeholder", () => {
  assert.throws(
    () =>
      parseDatabaseUrl(
        "postgres://postgres:REPLACE_WITH_LOCAL_DB_PASSWORD@localhost/weaver",
      ),
    /Replace/,
  );
});
