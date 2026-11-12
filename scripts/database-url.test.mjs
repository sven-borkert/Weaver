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

test("rejects remote targets and host overrides for the local container", () => {
  for (const url of [
    "postgres://postgres:secret@remote.example/weaver",
    "postgres://postgres:secret@localhost/weaver?host=remote.example",
    "postgres://postgres:secret@localhost/weaver?hostaddr=192.0.2.1",
  ]) {
    assert.throws(() => parseDatabaseUrl(url), /loopback/);
  }
});
