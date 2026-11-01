import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { once } from "node:events";
import type { LookupAddress } from "node:dns";
import { expect, it, vi } from "vitest";
import { createPinnedFetch } from "./outboundFetch";

const resolve = (address: string) => async (): Promise<LookupAddress[]> => [
  { address, family: address.includes(":") ? 6 : 4 },
];

// Self-signed test-only certificate for 127.0.0.1, valid 2026-2036. Never used
// for anything but this local fixture server.
const SELF_SIGNED_CERT = `-----BEGIN CERTIFICATE-----
MIIDGjCCAgKgAwIBAgIUbeP9PMSdqeUKCwXhJycP6jBgZewwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJMTI3LjAuMC4xMB4XDTI2MDkzMDE0MDk1NloXDTM2MDky
NzE0MDk1NlowFDESMBAGA1UEAwwJMTI3LjAuMC4xMIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEAqsRCBApXQw5DQA41qRaABjkHDtEDeprLYtw8B38UxEas
NcswGF7a8yEHr/KB4cBBmF7bYsp9fpKdAMxu7uD6geyIH5q4AFcUCVDI7WbNzvm+
pPHu/nGBm+sEu83zQBT0hi7Wl0aahjxaysJcEWSDgRAPD5E0AHa3562ugc6bvY47
2tgu9fBLaqKhHkTIYeczalIdAjW9sgMYUJgbbgo0eROZ/wfrb8Cs9SWkCD5iYVrM
2eOY3zWnbZPbqZxOxbIaCb8WudAxoE4PSptconcNzhtpEx+MbU6388gJSfvywMIQ
lqci3mf5fQgxvUbb0p5Erz2K0SaoI1+BdwyFAtwMzwIDAQABo2QwYjAdBgNVHQ4E
FgQUvCg597FY242vqA8yQMwMUped9nQwHwYDVR0jBBgwFoAUvCg597FY242vqA8y
QMwMUped9nQwDwYDVR0TAQH/BAUwAwEB/zAPBgNVHREECDAGhwR/AAABMA0GCSqG
SIb3DQEBCwUAA4IBAQBnRXU014Ao5pCEzikMo1JGoiUwgmmMZyQePs0mAcSJXw7H
ZAmmFArMeHf5eao4uAugTKzohV2WqBnei7TWO+/vtZZReNhs9ezPvciytRG1Cclc
AwlkiiSPRtNKsPgbrFznZjNKe0DX55RGRrtcHBCF3/9vFYntRnX30o6NBepphZQC
NJ1iq91qOUSybDV4huCZ48nEPK/6QGhfSDbc+xGb73DbSE9Ll6iUVi1KntIGkECJ
68ZuhE7oqGCI+dEyVAtbVUOb/XG9/RhaFyxn+vXgs8QCI2FTqd155PE5pumUOIg0
U8JpkVPU4B6vgod9PnTnXJx0AREUn6R7qUmXy+lk
-----END CERTIFICATE-----`;
const SELF_SIGNED_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCqxEIECldDDkNA
DjWpFoAGOQcO0QN6msti3DwHfxTERqw1yzAYXtrzIQev8oHhwEGYXttiyn1+kp0A
zG7u4PqB7IgfmrgAVxQJUMjtZs3O+b6k8e7+cYGb6wS7zfNAFPSGLtaXRpqGPFrK
wlwRZIOBEA8PkTQAdrfnra6Bzpu9jjva2C718EtqoqEeRMhh5zNqUh0CNb2yAxhQ
mBtuCjR5E5n/B+tvwKz1JaQIPmJhWszZ45jfNadtk9upnE7FshoJvxa50DGgTg9K
m1yidw3OG2kTH4xtTrfzyAlJ+/LAwhCWpyLeZ/l9CDG9RtvSnkSvPYrRJqgjX4F3
DIUC3AzPAgMBAAECggEANBPvOBE5RINsgfPzbHImr/8jRmL6xyC/BxK4IechG6yb
5znknIINDtmTYRa5gnHh70h6annrZLbst6og6Kvm6cmLR+wk0kG8JA0lgbT47faf
K+l2Y9WU28qEIowv82qQmf1dxzuqc2ajn7M/ZbR8IFeX6Dz1mXCbLEX88qxiNZ/T
v+wAkocISRVa5kk22sqqC6HvFAx5rR+FMdENrJ+s5TQC/AAFygrtlbm1PpOSxfg4
AoIdFIfMsebWPfknBbO99cdM7igUUMWe23kbKftmwKdC6rvkW7C3rmpzy4CaSr2u
s0wfDLZamH4k7V6n1V1UPfHrGNtTIQ/jROaK8HNvmQKBgQDaENm40fFEB4/pgwm1
76/+Lcj82OEqIbzgANUgovNHQ+Gep9NCHqw4W/YPco/Bj2A2+CRVxU1ONC52X26Q
JKiNXg7acAOKvhDxVVcXbXn3Fr9TGNlAUdAs4g0roPUf8cmMEhEQvNkW8oqEe/8R
/8Dntqq/HWGi787BiBD+JdhaqQKBgQDIeQb9+3mG2Ce3msSngbbAi8BAV+iIWSzm
TMYoBLRr5KzE/KySfan9BXQerxI666XBC0cO6RhsQv1FuAiMY5WdygW5YMjPRXSQ
YgZ+E4TQAwbPt0MgP+H41MwpRtSaeL5IrRosvJ1MD4FxjB0m9iTfWmQYSBackAmH
8XhFsw4OtwKBgG0uVKRZ0S+bja1/42PJb1eXOvOF7y62F6gcIpmlnKLI1PUn1/lZ
/CZ3vLo9RMbH74d2NFMRZ0RJkh3IaEYZZJ7rQgqSXOOhiEAc128ubAuPwxlq7pNq
ow1l3OxEOZbV63CLNyonM5Zut3Xf03UClWYuqkzn/BOld+KkKsXk0u+JAoGAfwTP
/VS8p0eFwrt5Jnj1hgIGCb6pQtrdq/2w/+IbPtFg9l7yKM8eSYaPEHH0pwhvuWSf
3T6rjszTFL2KDQl73sIF5nMASPPE60Zwvqk3WWTRiAKhsWlIkBSkVvLd+hHO3tVu
5DGNqIeaiIsyXWFP84SeLxRd300T/OJuRhsxKPkCgYEApGsvZ6o3/3tQjnTAfUSS
LLFZ1/EPCHL3kpfYZHplqj7SNxc/1EGtuEN4tofnuzWTJbd0FP5w0n7fujk+H6wD
l3BfwD46aKIVP5DD+er2dXKAhMItmmWNor6ua2K2Z/XF2Iu3AGfBilzElKN9ErSk
0UU6l73CF12Mhnp3wBA3zLs=
-----END PRIVATE KEY-----`;

async function startSelfSignedServer() {
  const server = createHttpsServer(
    { cert: SELF_SIGNED_CERT, key: SELF_SIGNED_KEY },
    (_req, res) => res.end("insecure-ok"),
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing port");
  return {
    url: `https://127.0.0.1:${address.port}/`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

it.each([
  "127.0.0.1",
  "10.1.2.3",
  "169.254.169.254",
  "::1",
  "::ffff:127.0.0.1",
  "fc00::1",
])(
  "rejects private DNS target %s before sending credentials",
  async (address) => {
    const fetchImpl = vi.fn<typeof fetch>();
    const guarded = createPinnedFetch(fetchImpl, {
      production: true,
      resolve: resolve(address),
    });
    await expect(
      guarded("https://public.example/mcp", {
        headers: { authorization: "Bearer secret" },
      }),
    ).rejects.toThrow("outbound endpoint");
    expect(fetchImpl).not.toHaveBeenCalled();
  },
);
it("rejects plaintext public endpoints even when DNS is public", async () => {
  const guarded = createPinnedFetch(vi.fn(), {
    production: true,
    resolve: resolve("93.184.216.34"),
  });
  await expect(guarded("http://public.example/mcp")).rejects.toThrow(
    "outbound endpoint",
  );
});
it("rejects mixed public and private DNS answers", async () => {
  const guarded = createPinnedFetch(vi.fn(), {
    production: true,
    resolve: async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ],
  });
  await expect(guarded("https://public.example/mcp")).rejects.toThrow(
    "outbound endpoint",
  );
});
it("connects only to the validated address and requires an exact trusted origin", async () => {
  const server = createServer((_req, res) => res.end("pinned"));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing port");
  const origin = `http://does-not-resolve.invalid:${address.port}`;
  const lookup = vi.fn(resolve("127.0.0.1"));
  try {
    const guarded = createPinnedFetch(fetch, {
      production: true,
      allowedOrigins: [origin],
      resolve: lookup,
    });
    expect(await (await guarded(`${origin}/mcp`)).text()).toBe("pinned");
    expect(lookup).toHaveBeenCalledTimes(1);
    await expect(
      guarded(`http://other.invalid:${address.port}/mcp`),
    ).rejects.toThrow("outbound endpoint");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
it("does not automatically follow a redirect to an unvalidated destination", async () => {
  const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
    expect(init?.redirect).toBe("manual");
    return new Response(null, {
      status: 302,
      headers: { location: "http://169.254.169.254/" },
    });
  });
  const guarded = createPinnedFetch(fetchImpl, {
    production: true,
    resolve: resolve("93.184.216.34"),
  });
  expect((await guarded("https://public.example/mcp")).status).toBe(302);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});

it("rejects with a coded policy error", async () => {
  const guarded = createPinnedFetch(vi.fn<typeof fetch>(), {
    production: true,
    resolve: resolve("100.64.0.1"),
  });
  await expect(
    guarded("https://litellm.example/v1/models"),
  ).rejects.toMatchObject({
    name: "OutboundPolicyError",
    code: "OUTBOUND_NOT_ALLOWED",
    message: "outbound endpoint is not allowed",
  });
});

it("rejects a self-signed certificate by default and accepts it with rejectUnauthorized: false", async () => {
  const fixture = await startSelfSignedServer();
  try {
    // No `production: true` here deliberately: the resolved address is a
    // loopback address, so the outbound SSRF/range guard's non-production
    // "localDevelopment" bypass lets the request through to the TLS layer
    // without needing an allowed-origins entry. `production: true` would
    // make the guard itself reject the request before TLS is ever attempted.
    const strict = createPinnedFetch(fetch, {
      resolve: async () => [{ address: "127.0.0.1", family: 4 }],
    });
    await expect(strict(fixture.url)).rejects.toMatchObject({
      cause: { code: "DEPTH_ZERO_SELF_SIGNED_CERT" },
    });
    const insecure = createPinnedFetch(fetch, {
      resolve: async () => [{ address: "127.0.0.1", family: 4 }],
      rejectUnauthorized: false,
    });
    expect(await (await insecure(fixture.url)).text()).toBe("insecure-ok");
  } finally {
    await fixture.close();
  }
});
