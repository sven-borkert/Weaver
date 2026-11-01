import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

it("leaves the consent redirect to the form instead of navigating twice", async () => {
  const location = {
    href: "http://localhost:3000/consent",
    origin: "http://localhost:3000",
    search: "",
  };
  vi.stubGlobal("window", { location });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({ redirect: true, url: "http://127.0.0.1:4545/callback" }),
    ),
  );
  const { authClient } = await import("./authClient");
  const result = await authClient.oauth2.consent({ accept: true });
  expect(result.error).toBeNull();
  expect(result.data).toMatchObject({
    redirect: true,
    url: "http://127.0.0.1:4545/callback",
  });
  expect(location.href).toBe("http://localhost:3000/consent");
});
