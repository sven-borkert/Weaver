import { NextRequest } from "next/server";
import { expect, it } from "vitest";
import { proxy, config } from "./proxy";

it("enforces a fresh script nonce and passes it to rendering", () => {
  const response = proxy(new NextRequest("https://weaver.example/login"));
  const csp = response.headers.get("content-security-policy");
  expect(csp).toContain("'nonce-");
  expect(
    csp?.split(";").find((part) => part.includes("script-src")),
  ).not.toContain("'unsafe-inline'");
  expect(
    response.headers.get("x-middleware-request-content-security-policy"),
  ).toBe(csp);
  expect(response.headers.get("x-middleware-request-x-nonce")).toBeTruthy();
  expect(
    proxy(new NextRequest("https://weaver.example/login")).headers.get(
      "content-security-policy",
    ),
  ).not.toBe(csp);
});

it("stamps request paths and covers every workspace and authentication route", () => {
  const matcher = new RegExp(`^${config.matcher[0]}$`);
  for (const path of [
    "/",
    "/home",
    "/projects/example",
    "/account/keys",
    "/admin/ai",
    "/assistant/conversation",
    "/login",
    "/consent",
  ]) {
    expect(matcher.test(path)).toBe(true);
    const response = proxy(
      new NextRequest(`https://weaver.example${path}?test=1`),
    );
    expect(
      response.headers.get("x-middleware-request-x-weaver-request-path"),
    ).toBe(`${path}?test=1`);
  }
});
