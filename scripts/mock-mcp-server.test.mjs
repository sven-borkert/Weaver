import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createMockMcpServer } from "../apps/web/tests/e2e/mock-mcp-server.mjs";

let server;
let base;
before(async () => {
  server = createMockMcpServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((resolve) => server.close(resolve)));
const post = (path, body) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const rpc = async (method, params) =>
  (await post("/mcp", { jsonrpc: "2.0", id: 1, method, params })).json();
const state = async () => (await fetch(`${base}/__fixture/state`)).json();

test("generic compatibility discovery never resets the counter; only fixture control resets state", async () => {
  await post("/__fixture/control", { action: "reset" });
  const init = await rpc("initialize", {});
  assert.equal(init.result.protocolVersion, "2024-11-05");
  assert.equal(init.result.serverInfo.name, "weaver-e2e-counter");
  assert.deepEqual(
    (await rpc("tools/list")).result.tools.map((tool) => tool.name),
    ["read_counter", "set_counter"],
  );
  assert.equal(
    (
      await post("/mcp", {
        jsonrpc: "2.0",
        method: "notifications/initialized",
      })
    ).status,
    202,
  );
  await rpc("tools/call", { name: "set_counter", arguments: { value: 7 } });
  await rpc("initialize", {});
  await rpc("tools/list");
  const read = await rpc("tools/call", { name: "read_counter", arguments: {} });
  assert.deepEqual(JSON.parse(read.result.content[0].text), { counter: 7 });
  assert.deepEqual(await state(), {
    counter: 7,
    reads: 1,
    writes: 1,
    disconnectNextWrite: false,
  });
  assert.equal(
    (await rpc("tools/call", { name: "reset", arguments: {} })).error.code,
    -32602,
  );
  assert.equal((await state()).counter, 7);
  await post("/__fixture/control", { action: "reset" });
  assert.deepEqual(await state(), {
    counter: 0,
    reads: 0,
    writes: 0,
    disconnectNextWrite: false,
  });
});

test("disconnect applies exactly one synthetic write before dropping its response", async () => {
  await post("/__fixture/control", { action: "reset" });
  await post("/__fixture/control", { action: "disconnect_next_write" });
  await assert.rejects(
    rpc("tools/call", { name: "set_counter", arguments: { value: 9 } }),
  );
  assert.deepEqual(await state(), {
    counter: 9,
    reads: 0,
    writes: 1,
    disconnectNextWrite: false,
  });
  await rpc("tools/call", { name: "read_counter", arguments: {} });
  assert.equal((await state()).writes, 1);
});

test("invalid requests and control actions cannot mutate the fixture", async () => {
  const before = await state();
  assert.equal((await post("/mcp", null)).status, 400);
  assert.equal(
    (await post("/__fixture/control", { action: "unknown" })).status,
    400,
  );
  assert.equal(
    (
      await rpc("tools/call", {
        name: "set_counter",
        arguments: { value: "9" },
      })
    ).error.code,
    -32602,
  );
  assert.deepEqual(await state(), before);
});
