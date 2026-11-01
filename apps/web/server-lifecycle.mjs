import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { version } = require("next/package.json");
if (version !== "16.3.2") {
  throw new Error(
    "Revalidate Weaver's shutdown adapter before upgrading Next.js",
  );
}
const NextServer = require("next/dist/server/next-server.js").default;
const originalClose = NextServer.prototype.close;
if (typeof originalClose !== "function") {
  throw new Error("Next.js shutdown adapter is incompatible");
}
// Next's launcher drains HTTP requests before invoking this private close hook.
NextServer.prototype.close = async function (...args) {
  try {
    await originalClose.apply(this, args);
  } finally {
    await globalThis[Symbol.for("weaver.web.cleanup")]?.();
  }
};
