import { isIP } from "node:net";

export function requestClientAddress(
  headers: Headers,
  trustProxy: boolean,
): string {
  const address = trustProxy ? headers.get("x-real-ip") : null;
  return address && isIP(address) ? address : "direct";
}
