import { vi, type Mock } from "vitest";
import type { SessionUser } from "~/server/auth";

type GetSessionUser = (headers: Headers) => Promise<SessionUser | null>;

declare global {
  var __weaverGetSessionUserMock: Mock<GetSessionUser> | undefined;
}

vi.mock("server-only", () => ({}));

// Process-wide singleton: see weaver-testing § Placement and harness rules.
const sessionUserMock = vi.hoisted(
  () =>
    (globalThis.__weaverGetSessionUserMock ??= vi.fn<GetSessionUser>(() =>
      Promise.resolve(null),
    )),
);

vi.mock("~/server/auth", () => ({
  auth: {},
  getSessionUser: sessionUserMock,
}));
