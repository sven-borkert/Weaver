import { realpathSync } from "node:fs";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

const MAX_REQUEST_BODY_BYTES = 1024 * 1024;
const EMBEDDING_DIMENSIONS = 1536;

const deployment = {
  key: "deployment-pipeline",
  name: "Deployment Pipeline",
  type: "Process",
  aliases: ["Pipeline"],
  description: "Moves approved builds to production.",
  mentionText: "Deployment Pipeline",
  confidence: 0.95,
};

const production = {
  key: "production",
  name: "Production",
  type: "Environment",
  aliases: [],
  description: "The live environment.",
  mentionText: "Production",
  confidence: 0.94,
};

const relation = {
  sourceKey: "deployment-pipeline",
  targetKey: "production",
  type: "DEPLOYS_TO",
  description: "The pipeline deploys approved builds.",
  confidence: 0.93,
  validFrom: null,
  validTo: null,
};

const capacityNodes = Array.from({ length: 49 }, (_, index) => {
  const ordinal = String(index + 1).padStart(3, "0");
  return {
    key: `capacity-node-${ordinal}`,
    name: `Capacity Node ${ordinal}`,
    type: "System",
    aliases: [],
    description: `Deterministic graph capacity node ${ordinal}.`,
    mentionText: `Capacity Node ${ordinal}`,
    confidence: 0.92,
  };
});

const capacityProfiles = new Map([
  ["weaver-capacity:focus-primary", { family: "focus", types: ["A", "B"] }],
  ["weaver-capacity:focus-secondary", { family: "focus", types: ["C"] }],
  ["weaver-capacity:expand-primary", { family: "expand", types: ["A", "B"] }],
  ["weaver-capacity:expand-secondary", { family: "expand", types: ["C"] }],
]);

class RequestBodyTooLargeError extends Error {}

function sendJson(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let settled = false;

    request.on("data", (chunk) => {
      if (settled) return;
      bytes += chunk.byteLength;
      if (bytes > MAX_REQUEST_BODY_BYTES) {
        settled = true;
        chunks.length = 0;
        reject(new RequestBodyTooLargeError());
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (settled) return;
      settled = true;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new SyntaxError("Invalid JSON"));
      }
    });
    request.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

function vectorFor(text) {
  const characters = Array.from(text);
  return Array.from({ length: EMBEDDING_DIMENSIONS }, (_, index) => {
    const character = characters[index % Math.max(characters.length, 1)];
    const code = character?.codePointAt(0) ?? 1;
    return (((code + index) % 97) + 1) / 1000;
  });
}

function embeddingInputs(body) {
  if (!body || typeof body !== "object") return null;
  const input = body.input;
  if (typeof input === "string") return [input];
  if (
    !Array.isArray(input) ||
    !input.every((value) => typeof value === "string")
  ) {
    return null;
  }
  return input;
}

function extractionInput(body) {
  if (!body || typeof body !== "object" || !Array.isArray(body.messages)) {
    return null;
  }
  const message = body.messages.findLast(
    (candidate) =>
      candidate &&
      typeof candidate === "object" &&
      candidate.role === "user" &&
      typeof candidate.content === "string",
  );
  if (!message) return null;

  const chunkId = /^Chunk ID:[ \t]*(.+)$/m.exec(message.content)?.[1]?.trim();
  const content =
    /^Content:\r?\n([\s\S]*?)(?:\r?\n--- END UNTRUSTED DOCUMENT ---|$)/m.exec(
      message.content,
    )?.[1] ?? "";
  return { chunkId: chunkId || null, content };
}

function extractionFor(content) {
  const capacityExtraction = capacityExtractionFor(content);
  if (capacityExtraction) return capacityExtraction;

  const hasDeployment = /\bDeployment Pipeline\b/i.test(content);
  const hasProduction = /\bProduction\b/i.test(content);
  const entities = [];
  if (hasDeployment) entities.push(deployment);
  if (hasProduction) entities.push(production);
  return {
    entities,
    relations: hasDeployment && hasProduction ? [relation] : [],
  };
}

function capacityExtractionFor(content) {
  const profileEntry = [...capacityProfiles].find(([marker]) =>
    content.includes(marker),
  );
  if (!profileEntry) return null;
  if (
    !content.includes(deployment.name) ||
    !capacityNodes.every((entity) => content.includes(entity.name))
  ) {
    return { entities: [], relations: [] };
  }

  const [, profile] = profileEntry;
  const relations = [];
  if (profile.family === "focus") {
    for (const target of capacityNodes) {
      for (const suffix of profile.types) {
        relations.push(
          capacityRelation(
            deployment.key,
            target.key,
            `CAPACITY_LINK_${suffix}`,
            target.key === "capacity-node-001" ? 0.95 : 0.9,
          ),
        );
      }
    }
  } else {
    for (const target of capacityNodes.slice(1)) {
      for (const suffix of profile.types) {
        relations.push(
          capacityRelation(
            "capacity-node-001",
            target.key,
            `CAPACITY_FANOUT_${suffix}`,
            0.99,
          ),
        );
      }
    }
  }

  return { entities: [deployment, ...capacityNodes], relations };
}

function capacityRelation(sourceKey, targetKey, type, confidence) {
  return {
    sourceKey,
    targetKey,
    type,
    description: `${sourceKey} connects to ${targetKey}.`,
    confidence,
    validFrom: null,
    validTo: null,
  };
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

function assistantRequest(body) {
  return (
    body &&
    typeof body === "object" &&
    body.stream === true &&
    Array.isArray(body.tools) &&
    Array.isArray(body.messages)
  );
}

/** A scheduled task run: one non-streaming, tool-less completion whose system prompt names the mechanism. */
function taskRequest(body) {
  return (
    body &&
    typeof body === "object" &&
    body.stream !== true &&
    !Array.isArray(body.tools) &&
    Array.isArray(body.messages) &&
    body.messages.some(
      (m) =>
        m.role === "system" &&
        typeof m.content === "string" &&
        m.content.includes("scheduled task"),
    )
  );
}

/** The system prompt names the in-scope projects and the focused document; the persona reads both from it. */
function personaContext(messages) {
  const system = messages.find((m) => m.role === "system");
  const content = typeof system?.content === "string" ? system.content : "";
  const projectId = new RegExp(`\\((${UUID})\\)`).exec(content)?.[1] ?? null;
  const documentId =
    new RegExp(`looking at document (${UUID})`).exec(content)?.[1] ?? null;
  return { projectId, documentId };
}

function lastUserText(messages) {
  const last = [...messages].reverse().find((m) => m.role === "user");
  if (!last) return "";
  if (typeof last.content === "string") return last.content;
  if (Array.isArray(last.content))
    return last.content.map((part) => part.text ?? "").join(" ");
  return "";
}

function toolResults(messages) {
  const byName = new Map();
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    if (message.role !== "assistant" || !Array.isArray(message.tool_calls))
      continue;
    for (const call of message.tool_calls) {
      const result = messages.find(
        (m) => m.role === "tool" && m.tool_call_id === call.id,
      );
      if (!result) continue;
      let parsed = null;
      try {
        parsed = JSON.parse(result.content);
      } catch {
        parsed = null;
      }
      byName.set(call.function.name, parsed);
    }
  }
  return byName;
}

function sseStart(response) {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
}

function sseChunk(response, delta, finishReason = null) {
  response.write(
    `data: ${JSON.stringify({
      id: "chatcmpl-e2e",
      object: "chat.completion.chunk",
      created: 0,
      model: "e2e-extraction",
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    })}\n\n`,
  );
}

function sseEnd(response) {
  response.write("data: [DONE]\n\n");
  response.end();
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function streamText(response, sentence, { slow = false } = {}) {
  sseStart(response);
  if (slow) await sleep(4_000);
  sseChunk(response, { role: "assistant", content: "" });
  for (const word of sentence.split(" ")) {
    sseChunk(response, { content: `${word} ` });
    await sleep(slow ? 150 : 15);
  }
  sseChunk(response, {}, "stop");
  response.write(
    `data: ${JSON.stringify({
      id: "chatcmpl-e2e",
      object: "chat.completion.chunk",
      created: 0,
      model: "e2e-extraction",
      choices: [],
      usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
    })}\n\n`,
  );
  sseEnd(response);
}

let toolCallCounter = 0;
function streamToolCall(response, name, args) {
  toolCallCounter += 1;
  const id = `call_e2e_${toolCallCounter}`;
  sseStart(response);
  sseChunk(response, { role: "assistant", content: "" });
  sseChunk(response, {
    tool_calls: [
      {
        index: 0,
        id,
        type: "function",
        function: { name, arguments: JSON.stringify(args) },
      },
    ],
  });
  sseChunk(response, {}, "tool_calls");
  sseEnd(response);
}

async function handleAssistant(body, response) {
  const { projectId, documentId } = personaContext(body.messages);
  const ask = lastUserText(body.messages).toLowerCase();
  const results = toolResults(body.messages);
  const externalAsk = /e2e external (read|set (\d+))/.exec(ask);
  if (externalAsk) {
    const remoteName =
      externalAsk[1] === "read" ? "read_counter" : "set_counter";
    const callable = body.tools?.find(
      (entry) =>
        entry.function?.name?.startsWith("ext_") &&
        entry.function.description?.includes(remoteName),
    )?.function.name;
    const currentTurn = body.messages.slice(
      body.messages.findLastIndex((message) => message.role === "user"),
    );
    const turnResults = toolResults(currentTurn);
    if (!callable) {
      if (
        !body.tools?.some(
          (entry) => entry.function?.name === "find_external_tools",
        )
      ) {
        await streamText(response, "No external tools are available.");
        return;
      }
      const found = turnResults.get("find_external_tools");
      const match = found?.matches?.find((entry) => entry.tool === remoteName);
      if (match) {
        streamToolCall(response, "find_external_tools", { load: [match.name] });
        return;
      }
      if (found) {
        await streamText(response, "The external tool could not be loaded.");
        return;
      }
      streamToolCall(response, "find_external_tools", { query: remoteName });
      return;
    }
    if (!turnResults.has(callable)) {
      streamToolCall(
        response,
        callable,
        remoteName === "read_counter" ? {} : { value: Number(externalAsk[2]) },
      );
      return;
    }
    const status = turnResults.get(callable)?.status ?? "failed";
    await streamText(response, `External tool ${status}.`);
    return;
  }
  const listed = results.get("list_documents");
  const read = results.get("read_document");

  if (ask.includes("slow")) {
    await streamText(response, "This is a slow answer that took a while.", {
      slow: true,
    });
    return;
  }
  if (
    (ask.includes("cite") || ask.includes("propose")) &&
    projectId &&
    documentId
  ) {
    if (ask.includes("list documents") && !listed) {
      streamToolCall(response, "list_documents", { projectId });
      return;
    }
    if (!read) {
      streamToolCall(response, "read_document", { projectId, documentId });
      return;
    }
    if (ask.includes("propose") && !results.has("propose_document_edit")) {
      streamToolCall(response, "propose_document_edit", {
        projectId,
        documentId,
        baseCommitSha: read.commitSha ?? "0000000",
        markdown: `${read.markdown ?? ""}\n\nAdded by the assistant.`,
        summary: "Append a line noting the assistant's addition.",
      });
      return;
    }
    await streamText(
      response,
      ask.includes("propose")
        ? "I have proposed an edit; review it below."
        : "According to the document, the steps are as written there.",
    );
    return;
  }
  await streamText(response, "Here is a plain answer with no sources.");
}

/** The wiki agent's system prompt names it; the persona follows the ingest protocol in order. */
function wikiRequest(body) {
  return (
    assistantRequest(body) &&
    body.messages.some(
      (m) =>
        m.role === "system" &&
        typeof m.content === "string" &&
        m.content.includes("wiki agent of one Weaver project"),
    )
  );
}

function orderedToolCalls(messages) {
  const calls = [];
  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.tool_calls))
      continue;
    for (const call of message.tool_calls) {
      const reply = messages.find(
        (m) => m.role === "tool" && m.tool_call_id === call.id,
      );
      let result = null;
      let args = {};
      try {
        result = JSON.parse(reply?.content ?? "null");
        args = JSON.parse(call.function.arguments);
      } catch {
        result = null;
      }
      calls.push({ name: call.function.name, args, result });
    }
  }
  return calls;
}

function handleWiki(body, response) {
  const calls = orderedToolCalls(body.messages);
  const listed = calls.find((call) => call.name === "list_inputs")?.result;
  if (!listed) {
    streamToolCall(response, "list_inputs", {});
    return;
  }
  const completed = new Set(
    calls
      .filter((call) => call.name === "complete_input")
      .map((call) => call.args.id),
  );
  const next = listed.inputs.find((input) => !completed.has(input.id));
  if (!next) {
    streamToolCall(response, "finish_run", {
      summary: `Integrated ${completed.size} inputs.`,
    });
    return;
  }
  const forItem = calls.slice(
    calls.findLastIndex(
      (call) => call.name === "read_input" && call.args.id === next.id,
    ),
  );
  const opened = forItem.find((call) => call.name === "read_input");
  if (!opened?.result) {
    streamToolCall(response, "read_input", { id: next.id });
    return;
  }
  const sourceId = opened.result.sourceDocumentId;
  if (sourceId && !forItem.some((call) => call.name === "read_document")) {
    streamToolCall(response, "read_document", { documentId: sourceId });
    return;
  }
  if (!forItem.some((call) => call.name === "wiki_create_page")) {
    streamToolCall(response, "wiki_create_page", {
      folderPath: ["wiki"],
      title: `Summary ${next.id.slice(0, 8)}`,
      markdown: "A summary written by the mock wiki agent.",
      properties: { type: "summary", summary: "Mock summary" },
    });
    return;
  }
  streamToolCall(response, "complete_input", {
    id: next.id,
    outcome: "integrated",
    note: "Integrated by the mock agent.",
  });
}

export function createMockAiServer() {
  const retriedChunkIds = new Set();

  return createServer(async (request, response) => {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;

    if (request.method === "GET" && pathname === "/health") {
      sendJson(response, 200, { status: "ok" });
      return;
    }

    if (request.method === "GET" && pathname === "/models") {
      // OpenRouter-style extras let the admin UI show discovered limits.
      sendJson(response, 200, {
        data: [
          {
            id: "e2e-extraction",
            name: "E2E extraction",
            context_length: 32768,
            top_provider: { max_completion_tokens: 4096 },
            supported_parameters: ["tools", "response_format"],
          },
          { id: "e2e-embedding" },
        ],
      });
      return;
    }

    if (
      request.method !== "POST" ||
      (pathname !== "/embeddings" && pathname !== "/chat/completions")
    ) {
      sendJson(response, 404, { error: { message: "Not found" } });
      return;
    }

    let body;
    try {
      body = await readJsonBody(request);
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) {
        sendJson(response, 413, { error: { message: "Request too large" } });
        return;
      }
      sendJson(response, 400, { error: { message: "Invalid JSON request" } });
      return;
    }

    if (pathname === "/chat/completions" && wikiRequest(body)) {
      handleWiki(body, response);
      return;
    }

    if (pathname === "/chat/completions" && assistantRequest(body)) {
      await handleAssistant(body, response);
      return;
    }

    if (pathname === "/chat/completions" && taskRequest(body)) {
      const ask = lastUserText(body.messages);
      const sawDigest = ask.includes("## Change digest");
      const externalCounter = /"counter"\s*:\s*(\d+)/.exec(
        ask.replaceAll('\\"', '"'),
      )?.[1];
      sendJson(response, 200, {
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: `## Report\n\nGenerated for the e2e scheduled task.\n\n- Digest received: ${sawDigest ? "yes" : "no"}${externalCounter === undefined ? "" : `\n\nSynthetic external counter: ${externalCounter}`}`,
            },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
      });
      return;
    }

    if (pathname === "/embeddings") {
      const input = embeddingInputs(body);
      if (!input) {
        sendJson(response, 400, {
          error: { message: "Invalid embeddings request" },
        });
        return;
      }
      if (input.some((text) => text.trim() === "keyword-only")) {
        sendJson(response, 503, {
          error: { message: "Semantic service unavailable" },
        });
        return;
      }
      sendJson(response, 200, {
        data: input.map((text, index) => ({
          index,
          embedding: vectorFor(text),
        })),
        usage: { prompt_tokens: input.length, total_tokens: input.length },
      });
      return;
    }

    const extractionInputValue = extractionInput(body);
    if (!extractionInputValue) {
      sendJson(response, 400, {
        error: { message: "Invalid extraction request" },
      });
      return;
    }
    const { chunkId, content } = extractionInputValue;
    if (
      chunkId &&
      content.includes("retry-once") &&
      !retriedChunkIds.has(chunkId)
    ) {
      retriedChunkIds.add(chunkId);
      sendJson(response, 400, {
        error: { message: "Injected extraction failure" },
      });
      return;
    }

    const extraction = extractionFor(content);
    sendJson(response, 200, {
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: JSON.stringify(extraction),
          },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
  });
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return (
      import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
    );
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const server = createMockAiServer();
  const port = Number(process.env.WEAVER_E2E_AI_PORT ?? "4010");
  server.listen(port, "127.0.0.1");

  const close = () => server.close(() => process.exit(0));
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}
