import { describe, expect, it } from "vitest";
import { assertTestEnvironment } from "./testEnvironment";

describe("destructive test environment", () => {
  it("accepts only the exact test pair", () => {
    expect(
      assertTestEnvironment(
        {
          DATABASE_URL: "postgres://localhost/weaver_test",
          WEAVER_DATA_DIR: "./data-test",
        },
        "integration",
        "/tmp/weaver-guard",
      ),
    ).toBe("/tmp/weaver-guard/data-test");
  });
  it.each([
    ["weaver", "./data-test"],
    ["weaver_test", "./data"],
    ["weaver_e2e", "./data-test"],
    ["weaver_test", "../data-test"],
    ["weaver_test", ""],
  ])("refuses %s with %s", (database, data) => {
    expect(() =>
      assertTestEnvironment(
        {
          DATABASE_URL: `postgres://localhost/${database}`,
          WEAVER_DATA_DIR: data,
        },
        "integration",
        "/tmp/weaver-guard",
      ),
    ).toThrow("Test reset refused");
  });
});

it("rejects remote hosts before a destructive reset", () => {
  expect(() =>
    assertTestEnvironment(
      {
        DATABASE_URL: "postgres://remote.example/weaver_test",
        WEAVER_DATA_DIR: "./data-test",
      },
      "integration",
      "/tmp/weaver-guard",
    ),
  ).toThrow("Test reset refused");
});

it("rejects host query overrides before resetting", () => {
  expect(() =>
    assertTestEnvironment(
      {
        DATABASE_URL: "postgres://localhost/weaver_test?host=remote.example",
        WEAVER_DATA_DIR: "./data-test",
      },
      "integration",
      "/tmp/weaver-guard",
    ),
  ).toThrow("Test reset refused");
});
