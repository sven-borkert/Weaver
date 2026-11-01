import { createServer } from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import type { TableColumn } from "@weaver/core/tables/types";
import { buildMachineApiExamples } from "./examples";

const documentId = "11111111-1111-4111-8111-111111111111";
const tableId = "22222222-2222-4222-8222-222222222222";
const folderId = "33333333-3333-4333-8333-333333333333";
const columns: TableColumn[] = [
  { id: "44444444-4444-4444-8444-444444444444", name: "Account", type: "text" },
  { id: "55555555-5555-4555-8555-555555555555", name: "Count", type: "number" },
  {
    id: "66666666-6666-4666-8666-666666666666",
    name: "Status",
    type: "select",
    options: [{ id: "77777777-7777-4777-8777-777777777777", label: "OK" }],
  },
];

describe("machine publishing examples", () => {
  it.each([
    "updateMarkdown",
    "createMarkdown",
    "appendRows",
    "python",
  ] as const)(
    "retries %s with the original revision and payload after a lost response",
    async (example) => {
      const requests: {
        method: string;
        etag?: string;
        operation?: string;
        body: string;
      }[] = [];
      let headCount = 0;
      let accepted: string | undefined;
      const server = createServer((req, res) => {
        void (async () => {
          if (req.method === "HEAD") {
            headCount += 1;
            res.setHeader("ETag", `"${(accepted ? "b" : "a").repeat(40)}"`);
            res.end();
            return;
          }
          let body = "";
          for await (const chunk of req) body += String(chunk);
          const request = {
            method: req.method!,
            etag: req.headers["if-match"],
            operation:
              typeof req.headers["idempotency-key"] === "string"
                ? req.headers["idempotency-key"]
                : undefined,
            body,
          };
          requests.push(request);
          const identity = JSON.stringify(request);
          const first = accepted === undefined;
          res.statusCode = first ? 500 : accepted === identity ? 200 : 409;
          accepted ??= identity;
          res.end(JSON.stringify({ replayed: !first }));
        })().catch(() => res.destroy());
      });
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const directory = await mkdtemp(join(tmpdir(), "weaver-example-"));
      try {
        const address = server.address() as { port: number };
        const script = buildMachineApiExamples({
          baseUrl: `http://127.0.0.1:${address.port}`,
          projectId: "project",
          grants: [
            {
              kind: "document",
              targetId: documentId,
              root: false,
              actions: ["update"],
            },
            {
              kind: "table",
              targetId: tableId,
              root: false,
              actions: ["create"],
            },
          ],
          columns,
        })[example];
        const file = join(
          directory,
          example === "python" ? "publish.py" : "publish.sh",
        );
        await writeFile(file, script);
        await writeFile(join(directory, "audit.md"), "Original daily report");
        const execute = () =>
          promisify(execFile)(
            example === "python" ? "python3" : "bash",
            [file],
            {
              cwd: directory,
              env: {
                ...process.env,
                OPERATION_ID: "daily-audit-test",
                WEAVER_PROJECT_API_KEY: "test-credential",
              },
              timeout: 5000,
            },
          );
        await expect(execute()).rejects.toThrow();
        await writeFile(
          join(directory, "audit.md"),
          "Changed after response loss",
        );
        const { stdout } = await execute();
        expect(stdout).toContain("replayed");
        expect(headCount).toBe(example === "createMarkdown" ? 0 : 1);
        expect(requests).toHaveLength(2);
        expect(requests[0]).toMatchObject({
          etag:
            example === "createMarkdown" ? undefined : `"${"a".repeat(40)}"`,
          operation: "daily-audit-test",
        });
        expect(requests[1]).toEqual(requests[0]);
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
  it("targets the configured base path with revision and retry headers", () => {
    const examples = buildMachineApiExamples({
      baseUrl: "https://weaver.example/weaver/",
      projectId: "project",
      grants: [
        {
          kind: "document",
          targetId: documentId,
          root: false,
          actions: ["update"],
        },
        { kind: "table", targetId: tableId, root: false, actions: ["create"] },
      ],
      columns,
    });
    expect(examples.updateMarkdown).toContain(
      `'https://weaver.example/weaver/api/v1/projects/project/documents/${documentId}'`,
    );
    expect(examples.updateMarkdown).toContain("--head");
    expect(examples.updateMarkdown).toContain('-H "If-Match: $ETAG"');
    expect(examples.updateMarkdown).toContain(
      '-H "Idempotency-Key: $OPERATION_ID"',
    );
    expect(examples.appendRows).toContain(
      `/api/v1/projects/project/tables/${tableId}/rows`,
    );
    expect(examples.appendRows).toContain('-H "If-Match: $ETAG"');
    expect(examples.python).toContain('"If-Match": etag');
    for (const text of Object.values(examples)) {
      expect(text).toContain("WEAVER_PROJECT_API_KEY");
      expect(text).not.toContain("wvr_project_");
    }
  });

  it("uses explicit column IDs with typed sample cells", () => {
    const { appendRows } = buildMachineApiExamples({
      baseUrl: "https://weaver.example",
      projectId: "project",
      grants: [
        { kind: "table", targetId: tableId, root: false, actions: ["create"] },
      ],
      columns,
    });
    const payload = appendRows.split("<<'JSON'\n")[1]!.split("\nJSON")[0]!;
    expect(JSON.parse(payload)).toEqual({
      rows: [
        {
          cells: {
            [columns[0]!.id]: "Reviewed account",
            [columns[1]!.id]: 1,
            [columns[2]!.id]: "77777777-7777-4777-8777-777777777777",
          },
        },
      ],
    });
    expect(
      buildMachineApiExamples({
        baseUrl: "https://weaver.example",
        projectId: "project",
        grants: [],
      }).appendRows,
    ).toContain("COLUMN_UUID");
  });

  it("creates dated reports with a deterministic daily key and escaped titles", () => {
    const title = 'Prüfung "Q3" — l’audit';
    const { createMarkdown } = buildMachineApiExamples({
      baseUrl: "https://weaver.example",
      projectId: "project",
      grants: [
        {
          kind: "documentFolder",
          targetId: folderId,
          root: false,
          actions: ["create"],
        },
      ],
      reportTitle: title,
    });
    expect(createMarkdown).toContain("OPERATION_ID:-daily-audit-$REPORT_DATE");
    expect(createMarkdown).toContain(`{"id": "${folderId}"}`);
    const literal = /"title": ("(?:[^"\\]|\\.)*")/.exec(createMarkdown)![1]!;
    expect(JSON.parse(literal)).toBe(`${title} `);
    expect(
      buildMachineApiExamples({
        baseUrl: "https://weaver.example",
        projectId: "project",
        grants: [
          {
            kind: "documentFolder",
            targetId: null,
            root: true,
            actions: ["create"],
          },
        ],
      }).createMarkdown,
    ).toContain(`"folder": {"root": True}`);
  });
});
