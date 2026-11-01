import { expect, it } from "vitest";
import { gitRuntimeMessage } from "./GitRuntimeBanner";

it("stays silent for a supported Git", () => {
  expect(gitRuntimeMessage({ status: "ok", version: "2.43.0" })).toBeNull();
});

it("says Git is missing", () => {
  expect(gitRuntimeMessage({ status: "missing" })).toMatch(
    /Git is not installed/,
  );
});

it("names the installed and required versions", () => {
  expect(
    gitRuntimeMessage({
      status: "unsupported",
      version: "2.34.1",
      minimum: "2.36.0",
    }),
  ).toMatch(/Git 2\.34\.1.*Git 2\.36\.0 or newer/);
});
