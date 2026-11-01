import type { StoredGrant } from "@weaver/core/projectApi/types";
import type { CellValue, TableColumn } from "@weaver/core/tables/types";

export type MachineApiExamples = {
  updateMarkdown: string;
  createMarkdown: string;
  appendRows: string;
  python: string;
};

const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
// JSON string literals are valid Python string literals.
const pythonString = (value: string) => JSON.stringify(value);

const AUTH = `-H "Authorization: Bearer $WEAVER_PROJECT_API_KEY"`;
const OPERATION_ID = `OPERATION_ID="\${OPERATION_ID:-$(python3 -c 'import uuid; print(uuid.uuid4())')}"`;
const RETRY_NOTE =
  "# Retry with the same OPERATION_ID and saved .weaver-requests directory. Use a new ID for a new publication or after a 412.";

function prepareCurlRequest(
  url: string,
  payload: string[],
  revisionUrl: string | null,
  operation = OPERATION_ID,
) {
  return [
    "set -eu",
    "umask 077",
    operation,
    `printf 'Operation ID: %s\\n' "$OPERATION_ID" >&2`,
    `STATE_DIR=".weaver-requests/$OPERATION_ID"`,
    `mkdir -p "$STATE_DIR"`,
    `if [ ! -f "$STATE_DIR/ready" ]; then`,
    ...(revisionUrl
      ? [
          `HEADERS=$(curl --fail --silent --show-error --head ${AUTH} ${shellQuote(revisionUrl)})`,
          `ETAG=$(printf '%s\\n' "$HEADERS" | tr -d '\\r' | sed -n 's/^[Ee][Tt][Aa][Gg]: //p')`,
          `test -n "$ETAG"`,
          `printf '%s\\n' "$ETAG" > "$STATE_DIR/etag"`,
        ]
      : []),
    ...payload,
    `printf '%s\\n' ${shellQuote(url)} > "$STATE_DIR/url"`,
    `touch "$STATE_DIR/ready"`,
    "fi",
    ...(revisionUrl ? [`ETAG=$(cat "$STATE_DIR/etag")`] : []),
    `URL=$(cat "$STATE_DIR/url")`,
  ];
}

function sampleCell(
  column: TableColumn,
  readableDocumentId: string | undefined,
): CellValue {
  const option = column.options?.[0]?.id ?? "OPTION_UUID";
  switch (column.type) {
    case "number":
      return 1;
    case "boolean":
      return true;
    case "date":
      return "2026-01-31";
    case "datetime":
      return "2026-01-31T12:00:00Z";
    case "url":
      return "https://app.example/accounts/123";
    case "select":
      return option;
    case "multiselect":
      return [option];
    case "document":
      return readableDocumentId ?? "READABLE_DOCUMENT_UUID";
    case "text":
    case "longtext":
      return "Reviewed account";
  }
}

/** Copyable publishing examples; the secret always comes from the environment, never the page. */
export function buildMachineApiExamples(input: {
  baseUrl: string;
  projectId: string;
  grants: StoredGrant[];
  columns?: TableColumn[];
  reportTitle?: string;
}): MachineApiExamples {
  const base = `${input.baseUrl.replace(/\/+$/, "")}/api/v1/projects/${input.projectId}`;
  const grant = (
    kind: StoredGrant["kind"],
    action: StoredGrant["actions"][number],
  ) => input.grants.find((g) => g.kind === kind && g.actions.includes(action));
  const document = grant("document", "update");
  const folder = grant("documentFolder", "create");
  const table = grant("table", "create");
  const documentUrl = `${base}/documents/${document?.targetId ?? "DOCUMENT_UUID"}`;
  const tableUrl = `${base}/tables/${table?.targetId ?? "TABLE_UUID"}`;
  const reportTitle = input.reportTitle ?? "Daily audit";
  const folderRef = folder?.root
    ? `{"root": True}`
    : `{"id": ${pythonString(folder?.targetId ?? "FOLDER_UUID")}}`;

  const updateMarkdown = [
    ...prepareCurlRequest(
      documentUrl,
      [
        `python3 -c 'import json; print(json.dumps({"markdown": open("audit.md", encoding="utf-8").read()}))' > "$STATE_DIR/payload.json"`,
      ],
      documentUrl,
    ),
    `curl --fail-with-body -X PUT ${AUTH} -H 'Content-Type: application/json' -H "If-Match: $ETAG" -H "Idempotency-Key: $OPERATION_ID" --data-binary @"$STATE_DIR/payload.json" "$URL"`,
    RETRY_NOTE,
  ].join("\n");

  const createMarkdown = [
    "REPORT_DATE=$(date -u +%F)",
    ...prepareCurlRequest(
      `${base}/documents`,
      [
        `python3 - "$REPORT_DATE" > "$STATE_DIR/payload.json" <<'PY'`,
        "import json, sys",
        `print(json.dumps({"title": ${pythonString(`${reportTitle} `)} + sys.argv[1], "folder": ${folderRef}, "markdown": open("audit.md", encoding="utf-8").read()}))`,
        "PY",
      ],
      null,
      `OPERATION_ID="\${OPERATION_ID:-daily-audit-$REPORT_DATE}"`,
    ),
    `curl --fail-with-body -X POST ${AUTH} -H 'Content-Type: application/json' -H "Idempotency-Key: $OPERATION_ID" --data-binary @"$STATE_DIR/payload.json" "$URL"`,
    "# Keep the saved request and reuse its OPERATION_ID when retrying, including across midnight.",
  ].join("\n");

  const readable = input.grants.find(
    (g) => g.kind === "document" && g.actions.includes("read"),
  )?.targetId;
  const cells = Object.fromEntries(
    (input.columns?.length
      ? input.columns
      : [{ id: "COLUMN_UUID", name: "Account", type: "text" as const }]
    ).map((column) => [column.id, sampleCell(column, readable ?? undefined)]),
  );
  const appendRows = [
    ...prepareCurlRequest(
      `${tableUrl}/rows`,
      [
        `cat > "$STATE_DIR/payload.json" <<'JSON'`,
        JSON.stringify({ rows: [{ cells }] }, null, 2),
        "JSON",
      ],
      tableUrl,
    ),
    `curl --fail-with-body -X POST ${AUTH} -H 'Content-Type: application/json' -H "If-Match: $ETAG" -H "Idempotency-Key: $OPERATION_ID" --data-binary @"$STATE_DIR/payload.json" "$URL"`,
    RETRY_NOTE,
  ].join("\n");

  const python = [
    "import json, os, sys, tempfile, urllib.request, uuid",
    "from pathlib import Path",
    "",
    `URL = ${pythonString(documentUrl)}`,
    `HEADERS = {"Authorization": "Bearer " + os.environ["WEAVER_PROJECT_API_KEY"]}`,
    `operation_id = os.environ.get("OPERATION_ID") or str(uuid.uuid4())`,
    `print("Operation ID:", operation_id, file=sys.stderr)`,
    "os.umask(0o077)",
    `state_file = Path(".weaver-requests") / (operation_id + ".json")`,
    "state_file.parent.mkdir(parents=True, exist_ok=True)",
    "if state_file.exists():",
    `    state = json.loads(state_file.read_text(encoding="utf-8"))`,
    "else:",
    `    with urllib.request.urlopen(urllib.request.Request(URL, headers=HEADERS, method="HEAD")) as response:`,
    `        etag = response.headers["ETag"]`,
    `    with open("audit.md", encoding="utf-8") as report:`,
    `        body = json.dumps({"markdown": report.read()})`,
    `    state = {"url": URL, "etag": etag, "body": body}`,
    `    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=state_file.parent, delete=False) as saved:`,
    "        json.dump(state, saved)",
    "    os.replace(saved.name, state_file)",
    `etag = state["etag"]`,
    `headers = {**HEADERS, "Content-Type": "application/json", "If-Match": etag, "Idempotency-Key": operation_id}`,
    `request = urllib.request.Request(state["url"], data=state["body"].encode("utf-8"), headers=headers, method="PUT")`,
    "with urllib.request.urlopen(request) as response:",
    "    print(json.load(response))",
    RETRY_NOTE,
    "",
  ].join("\n");

  return { updateMarkdown, createMarkdown, appendRows, python };
}
