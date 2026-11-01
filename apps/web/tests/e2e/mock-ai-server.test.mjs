import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createMockAiServer } from "./mock-ai-server.mjs";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const DOCUMENT_ID = "22222222-2222-4222-8222-222222222222";
const SYSTEM = `You are Weaver's assistant.\nScope:\n- Demo (${PROJECT_ID})\nThe user is looking at document ${DOCUMENT_ID}; start there.`;

let server;
let baseUrl;

before(async () => {
  server = createMockAiServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((resolve) => server.close(resolve)));

async function chatWithSystem(system, messages, externalTools = []) {
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "e2e-extraction",
      stream: true,
      tools: [
        ...externalTools,
        {
          type: "function",
          function: { name: "read_document", parameters: {} },
        },
      ],
      messages: [{ role: "system", content: system }, ...messages],
    }),
  });
  assert.equal(response.headers.get("content-type"), "text/event-stream");
  const lines = (await response.text())
    .split("\n")
    .filter((l) => l.startsWith("data: "));
  assert.equal(lines.at(-1), "data: [DONE]");
  return lines.slice(0, -1).map((l) => JSON.parse(l.slice(6)));
}

const chat = (messages) => chatWithSystem(SYSTEM, messages);

const text = (chunks) =>
  chunks.map((c) => c.choices[0]?.delta.content ?? "").join("");
const toolCalls = (chunks) =>
  chunks.flatMap((c) => c.choices[0]?.delta.tool_calls ?? []);
// Mirrors how the real SDK determines finish reason: the last chunk whose
// choice carries one, ignoring trailing usage-only frames with `choices: []`.
const finishReason = (chunks) =>
  chunks.findLast((c) => c.choices[0]?.finish_reason != null)?.choices[0]
    .finish_reason;

describe("assistant persona", () => {
  it("streams a plain answer without tools", async () => {
    const chunks = await chat([
      { role: "user", content: "say something plain" },
    ]);
    assert.equal(toolCalls(chunks).length, 0);
    assert.match(text(chunks), /plain answer/i);
    assert.equal(finishReason(chunks), "stop");
  });

  it("falls back to a plain answer when scope has no project or document", async () => {
    const chunks = await chatWithSystem(
      "You are Weaver's assistant.\nScope: all projects.",
      [{ role: "user", content: "cite the runbook" }],
    );
    assert.equal(toolCalls(chunks).length, 0);
    assert.match(text(chunks), /\S/);
    assert.equal(finishReason(chunks), "stop");
  });

  it("reads the current document before citing it", async () => {
    const round1 = await chat([{ role: "user", content: "cite the runbook" }]);
    const calls = toolCalls(round1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].function.name, "read_document");
    assert.deepEqual(JSON.parse(calls[0].function.arguments), {
      projectId: PROJECT_ID,
      documentId: DOCUMENT_ID,
    });
    assert.equal(round1.at(-1).choices[0].finish_reason, "tool_calls");

    const round2 = await chat([
      { role: "user", content: "cite the runbook" },
      { role: "assistant", content: null, tool_calls: calls },
      {
        role: "tool",
        tool_call_id: calls[0].id,
        content: JSON.stringify({
          commitSha: "abc1234",
          markdown: "# Deploy\n\nSteps.",
        }),
      },
    ]);
    assert.equal(toolCalls(round2).length, 0);
    assert.match(text(round2), /According to the document/);
  });

  it("proposes an edit built from what it read", async () => {
    const round1 = await chat([
      { role: "user", content: "propose an addition" },
    ]);
    const [read] = toolCalls(round1);
    const round2 = await chat([
      { role: "user", content: "propose an addition" },
      { role: "assistant", content: null, tool_calls: [read] },
      {
        role: "tool",
        tool_call_id: read.id,
        content: JSON.stringify({
          commitSha: "abc1234",
          markdown: "# Deploy\n\nSteps.",
        }),
      },
    ]);
    const [propose] = toolCalls(round2);
    assert.equal(propose.function.name, "propose_document_edit");
    const args = JSON.parse(propose.function.arguments);
    assert.equal(args.baseCommitSha, "abc1234");
    assert.equal(args.documentId, DOCUMENT_ID);
    assert.match(
      args.markdown,
      /^# Deploy\n\nSteps\.\n\nAdded by the assistant\.$/,
    );
    assert.equal(typeof args.summary, "string");

    const round3 = await chat([
      { role: "user", content: "propose an addition" },
      { role: "assistant", content: null, tool_calls: [read] },
      { role: "tool", tool_call_id: read.id, content: "{}" },
      { role: "assistant", content: null, tool_calls: [propose] },
      {
        role: "tool",
        tool_call_id: propose.id,
        content: JSON.stringify({ proposalId: "p1", status: "pending" }),
      },
    ]);
    assert.equal(toolCalls(round3).length, 0);
    assert.match(text(round3), /proposed/i);
  });

  it("still answers extraction requests as JSON", async () => {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "e2e-extraction",
        messages: [
          {
            role: "user",
            content:
              "Chunk ID: c1\nContent:\nDeployment Pipeline moves builds to Production.",
          },
        ],
      }),
    });
    assert.equal(response.headers.get("content-type"), "application/json");
    const body = await response.json();
    assert.ok(JSON.parse(body.choices[0].message.content).entities.length >= 1);
  });

  it("answers a scheduled task run with a Markdown report", async () => {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "e2e-jobs",
        messages: [
          {
            role: "system",
            content:
              "You write one Markdown document on behalf of a scheduled task.",
          },
          {
            role: "user",
            content: "## Change digest\n\nSomething changed.",
          },
        ],
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.match(body.choices[0].message.content, /## Report/);
    assert.match(body.choices[0].message.content, /Digest received: yes/);
  });
});

describe("external synthetic personas", () => {
  const name = "ext_11111111111141118111111111111111";
  const tools = [
    {
      type: "function",
      function: { name, description: "Synthetic set_counter", parameters: {} },
    },
  ];
  it("calls a loaded external schema and does not reuse prior-turn results", async () => {
    const prompt = { role: "user", content: "e2e external set 4" };
    const first = await chatWithSystem(SYSTEM, [prompt], tools);
    const [call] = toolCalls(first);
    assert.equal(call.function.name, name);
    assert.deepEqual(JSON.parse(call.function.arguments), { value: 4 });
    const messages = [
      prompt,
      { role: "assistant", content: null, tool_calls: [call] },
      {
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify({ status: "unknown" }),
      },
    ];
    assert.match(
      text(await chatWithSystem(SYSTEM, messages, tools)),
      /External tool unknown/,
    );
    const next = await chatWithSystem(
      SYSTEM,
      [...messages, { role: "user", content: "e2e external set 5" }],
      tools,
    );
    assert.deepEqual(JSON.parse(toolCalls(next)[0].function.arguments), {
      value: 5,
    });
    assert.match(
      text(await chatWithSystem(SYSTEM, [prompt])),
      /No external tools are available/,
    );
  });
  it("finds and loads the external tool before calling it", async () => {
    const find = [
      {
        type: "function",
        function: {
          name: "find_external_tools",
          description: "Find tools",
          parameters: {},
        },
      },
    ];
    const prompt = { role: "user", content: "e2e external set 4" };
    const [query] = toolCalls(await chatWithSystem(SYSTEM, [prompt], find));
    assert.equal(query.function.name, "find_external_tools");
    assert.deepEqual(JSON.parse(query.function.arguments), {
      query: "set_counter",
    });
    const afterQuery = [
      prompt,
      { role: "assistant", content: null, tool_calls: [query] },
      {
        role: "tool",
        tool_call_id: query.id,
        content: JSON.stringify({
          matches: [{ name, tool: "set_counter", loaded: false }],
          totalMatches: 1,
        }),
      },
    ];
    const [load] = toolCalls(await chatWithSystem(SYSTEM, afterQuery, find));
    assert.deepEqual(JSON.parse(load.function.arguments), { load: [name] });
    const refused = [
      ...afterQuery,
      { role: "assistant", content: null, tool_calls: [load] },
      {
        role: "tool",
        tool_call_id: load.id,
        content: JSON.stringify({
          loaded: [],
          refused: [{ name, reason: "LIMIT_REACHED" }],
        }),
      },
    ];
    assert.match(
      text(await chatWithSystem(SYSTEM, refused, find)),
      /could not be loaded/,
    );
  });
  it("reports the actual synthetic task input counter", async () => {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messages: [
          { role: "system", content: "You write for a scheduled task." },
          {
            role: "user",
            content:
              '<external-input untrusted="true">\n' +
              JSON.stringify({
                content: [
                  { type: "text", text: JSON.stringify({ counter: 5 }) },
                ],
              }) +
              "\n</external-input>",
          },
        ],
      }),
    });
    const body = await response.json();
    assert.match(
      body.choices[0].message.content,
      /Synthetic external counter: 5/,
    );
  });
});
