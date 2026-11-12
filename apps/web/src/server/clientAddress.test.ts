import { expect, it } from "vitest";
import { requestClientAddress } from "./clientAddress";

it("uses only a valid explicitly trusted x-real-ip source", () => {
  const headers = new Headers({
    "x-real-ip": "192.0.2.1",
    "x-forwarded-for": "198.51.100.1",
  });
  expect(requestClientAddress(headers, false)).toBe("direct");
  expect(requestClientAddress(headers, true)).toBe("192.0.2.1");
  headers.set("x-real-ip", "spoofed, 192.0.2.1");
  expect(requestClientAddress(headers, true)).toBe("direct");
});
