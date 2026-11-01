# Project machine API

Project API keys let scripts publish Markdown documents and typed table results without a user account. Open **Project → Settings → Project API keys** as an Owner or Maintainer, choose targets and independent permissions, and copy the secret once. A key belongs to one project; removing, banning, or deleting its creator does not change its authority.

Integrating a tool with a coding agent? Point it at the [agent guide](project-api-agent-guide.md), which has the request contract, retry rules and a reference Python client.

Use `Authorization: Bearer $WEAVER_PROJECT_API_KEY` on `/api/v1/projects/{projectId}`. Include the deployment prefix, for example `https://weaver.example/weaver/api/v1/projects/...`. The API accepts project keys only. Cookies, personal API keys, OAuth credentials and scheduled-task contexts cannot manage or authenticate these keys.

Defaults are 90-day expiry and 100 requests per minute. Management supports 1–365 days or explicit no expiry, and 1–10,000 requests per minute. Revocation is permanent. A deleted project returns 404; restoring it permits keys that are otherwise still valid. Expired keys can be given a new expiry through settings.

## Grants

| Target            | Read               | Create                      | Update                       | Delete                    |
| ----------------- | ------------------ | --------------------------- | ---------------------------- | ------------------------- |
| Markdown document | Saved body         | —                           | Replace body/title           | Delete document           |
| Document folder   | Documents below it | Create documents below it   | Update documents below it    | Delete documents below it |
| Table             | Schema and rows    | Append rows                 | Replace table / update cells | Delete table or rows      |
| Table folder      | Tables below it    | Create tables / append rows | Update tables below it       | Delete tables / rows      |

Folder grants include all subfolders and future content. They follow folder UUIDs through moves and renames. Deleting and recreating a folder produces a different identity and does not inherit the old grant. Documents and tables have separate explicit root grants. Multiple selected targets combine their actions. A key needs at least one grant, every grant needs at least one action, and selecting a target never selects an action automatically. A grant whose target disappears stays visible as unavailable and grants nothing; it never widens to a folder or root.

Table replacement requires Update, Create if rows are added, and Delete if rows, columns or select options are removed. Clearing a cell or changing a column type requires Update. New or changed typed references require Read on their targets. Reads return stored Markdown/cells without resolving unauthorized reference titles.

`GET /grants` discovers only the key's selected targets, actions, current paths and availability. `HEAD /documents/{id}` works with an applicable Read/Update/Delete grant, and `HEAD /tables/{id}` with any applicable action. HEAD returns only the strong `ETag`, so a write-only script can obtain a revision without reading content. Table column UUIDs for append-only publishers can be copied from the examples in project settings; Read is not needed to append.

## Update a fixed Markdown document

Keep the bearer secret in `WEAVER_PROJECT_API_KEY`. The examples print an operation ID and save the original payload, destination and ETag under `.weaver-requests` before sending. To retry after a timeout or restart, set `OPERATION_ID` to that same value and keep the saved request files; changes to `audit.md` will not change a retry. Use a fresh operation ID for a new publication or after a 412. Saved requests contain report content, but no bearer secret; retain them only while retries are needed.

```sh
set -eu
umask 077
OPERATION_ID="${OPERATION_ID:-$(python3 -c 'import uuid; print(uuid.uuid4())')}"
printf 'Operation ID: %s\n' "$OPERATION_ID" >&2
STATE_DIR=".weaver-requests/$OPERATION_ID"
mkdir -p "$STATE_DIR"
if [ ! -f "$STATE_DIR/ready" ]; then
HEADERS=$(curl --fail --silent --show-error --head -H "Authorization: Bearer $WEAVER_PROJECT_API_KEY" 'https://weaver.example/weaver/api/v1/projects/PROJECT_UUID/documents/DOCUMENT_UUID')
ETAG=$(printf '%s\n' "$HEADERS" | tr -d '\r' | sed -n 's/^[Ee][Tt][Aa][Gg]: //p')
test -n "$ETAG"
printf '%s\n' "$ETAG" > "$STATE_DIR/etag"
python3 -c 'import json; print(json.dumps({"markdown": open("audit.md", encoding="utf-8").read()}))' > "$STATE_DIR/payload.json"
printf '%s\n' 'https://weaver.example/weaver/api/v1/projects/PROJECT_UUID/documents/DOCUMENT_UUID' > "$STATE_DIR/url"
touch "$STATE_DIR/ready"
fi
ETAG=$(cat "$STATE_DIR/etag")
URL=$(cat "$STATE_DIR/url")
curl --fail-with-body -X PUT -H "Authorization: Bearer $WEAVER_PROJECT_API_KEY" -H 'Content-Type: application/json' -H "If-Match: $ETAG" -H "Idempotency-Key: $OPERATION_ID" --data-binary @"$STATE_DIR/payload.json" "$URL"
# Retry with the same OPERATION_ID and saved .weaver-requests directory. Use a new ID for a new publication or after a 412.
```

PUT accepts `markdown` and optional `title`. Send the body, not a complete Weaver file: identity, metadata, authorship, review settings and the title heading are managed by Weaver. Normal fenced examples of metadata are permitted. Weaver stores Markdown through its editor pipeline, so formatting is normalized the way the editor saves it: list markers become `-`, tables are re-aligned, footnotes are inlined, and raw HTML or HTML comments are kept as visible escaped text rather than markup. GET returns the stored form. Markdown is limited to 200,000 characters; the existing 2 MB committed-file limit also applies.

## Create dated reports

Grant Create on a document folder. Use its UUID, or `{ "root": true }` when an explicit documents-root grant permits creation. A date-derived `Idempotency-Key` makes a rerun on the same day return the original receipt instead of a second report.

```sh
REPORT_DATE=$(date -u +%F)
set -eu
umask 077
OPERATION_ID="${OPERATION_ID:-daily-audit-$REPORT_DATE}"
printf 'Operation ID: %s\n' "$OPERATION_ID" >&2
STATE_DIR=".weaver-requests/$OPERATION_ID"
mkdir -p "$STATE_DIR"
if [ ! -f "$STATE_DIR/ready" ]; then
python3 - "$REPORT_DATE" > "$STATE_DIR/payload.json" <<'PY'
import json, sys
print(json.dumps({"title": "Daily audit " + sys.argv[1], "folder": {"id": "FOLDER_UUID"}, "markdown": open("audit.md", encoding="utf-8").read()}))
PY
printf '%s\n' 'https://weaver.example/weaver/api/v1/projects/PROJECT_UUID/documents' > "$STATE_DIR/url"
touch "$STATE_DIR/ready"
fi
URL=$(cat "$STATE_DIR/url")
curl --fail-with-body -X POST -H "Authorization: Bearer $WEAVER_PROJECT_API_KEY" -H 'Content-Type: application/json' -H "Idempotency-Key: $OPERATION_ID" --data-binary @"$STATE_DIR/payload.json" "$URL"
# Keep the saved request and reuse its OPERATION_ID when retrying, including across midnight.
```

Document and table creation return 201; every other write returns 200. Receipts are metadata only: resource UUID, path, revision, operation UUID, `replayed`, and generated column/row UUIDs where applicable. Creation does not require If-Match. Folder paths are accepted by session management for legacy identity assignment; machine creation accepts UUIDs or the explicit root marker only.

## Append audit results to a table

Grant Create on the table. Configure column UUIDs and values for their actual types. Omit row IDs to allocate them; the receipt returns the allocated UUIDs without existing rows or cells.

```sh
set -eu
umask 077
OPERATION_ID="${OPERATION_ID:-$(python3 -c 'import uuid; print(uuid.uuid4())')}"
printf 'Operation ID: %s\n' "$OPERATION_ID" >&2
STATE_DIR=".weaver-requests/$OPERATION_ID"
mkdir -p "$STATE_DIR"
if [ ! -f "$STATE_DIR/ready" ]; then
HEADERS=$(curl --fail --silent --show-error --head -H "Authorization: Bearer $WEAVER_PROJECT_API_KEY" 'https://weaver.example/weaver/api/v1/projects/PROJECT_UUID/tables/TABLE_UUID')
ETAG=$(printf '%s\n' "$HEADERS" | tr -d '\r' | sed -n 's/^[Ee][Tt][Aa][Gg]: //p')
test -n "$ETAG"
printf '%s\n' "$ETAG" > "$STATE_DIR/etag"
cat > "$STATE_DIR/payload.json" <<'JSON'
{
  "rows": [
    {
      "cells": {
        "COLUMN_UUID": "Reviewed account"
      }
    }
  ]
}
JSON
printf '%s\n' 'https://weaver.example/weaver/api/v1/projects/PROJECT_UUID/tables/TABLE_UUID/rows' > "$STATE_DIR/url"
touch "$STATE_DIR/ready"
fi
ETAG=$(cat "$STATE_DIR/etag")
URL=$(cat "$STATE_DIR/url")
curl --fail-with-body -X POST -H "Authorization: Bearer $WEAVER_PROJECT_API_KEY" -H 'Content-Type: application/json' -H "If-Match: $ETAG" -H "Idempotency-Key: $OPERATION_ID" --data-binary @"$STATE_DIR/payload.json" "$URL"
# Retry with the same OPERATION_ID and saved .weaver-requests directory. Use a new ID for a new publication or after a 412.
```

PATCH `/tables/{id}/rows` accepts `{"rows":[{"rowId":"UUID","set":{"COLUMN_UUID":false},"clear":["OTHER_COLUMN_UUID"]}]}`. `set` and `clear` cannot overlap. Values `false`, `0` and `""` are values, not deletion markers. DELETE `/tables/{id}/rows/{rowId}` removes a row. Full table PUT requires all column/row IDs; creation and append may omit IDs. Supply column IDs yourself when creating a table with populated cells. Tables retain their 10,000-row / 5 MB limit; row batches have at most 1,000 entries.

## Python publisher

This standard-library example replaces a fixed document. It saves its request before sending; keep the `.weaver-requests` directory and reuse the printed `OPERATION_ID` when retrying after a restart.

```python
import json, os, sys, tempfile, urllib.request, uuid
from pathlib import Path

URL = "https://weaver.example/weaver/api/v1/projects/PROJECT_UUID/documents/DOCUMENT_UUID"
HEADERS = {"Authorization": "Bearer " + os.environ["WEAVER_PROJECT_API_KEY"]}
operation_id = os.environ.get("OPERATION_ID") or str(uuid.uuid4())
print("Operation ID:", operation_id, file=sys.stderr)
os.umask(0o077)
state_file = Path(".weaver-requests") / (operation_id + ".json")
state_file.parent.mkdir(parents=True, exist_ok=True)
if state_file.exists():
    state = json.loads(state_file.read_text(encoding="utf-8"))
else:
    with urllib.request.urlopen(urllib.request.Request(URL, headers=HEADERS, method="HEAD")) as response:
        etag = response.headers["ETag"]
    with open("audit.md", encoding="utf-8") as report:
        body = json.dumps({"markdown": report.read()})
    state = {"url": URL, "etag": etag, "body": body}
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=state_file.parent, delete=False) as saved:
        json.dump(state, saved)
    os.replace(saved.name, state_file)
etag = state["etag"]
headers = {**HEADERS, "Content-Type": "application/json", "If-Match": etag, "Idempotency-Key": operation_id}
request = urllib.request.Request(state["url"], data=state["body"].encode("utf-8"), headers=headers, method="PUT")
with urllib.request.urlopen(request) as response:
    print(json.load(response))
# Retry with the same OPERATION_ID and saved .weaver-requests directory. Use a new ID for a new publication or after a 412.
```

## Revisions, retries and pagination

Every mutation requires an 8–128 character `Idempotency-Key` using letters, digits, `_`, `.`, `:`, or `-`. Its namespace is the credential across all endpoints. Use a new key for each distinct daily publication, and reuse it only with the exact method, normalized JSON body and If-Match of that publication. Changed requests return 409 `IDEMPOTENCY_KEY_REUSED`. Receipts are retained for 30 days; after pruning, the same key may represent a new operation.

Every existing-resource mutation, including row append, requires a single concrete strong If-Match from HEAD or GET. Missing revisions return 428, changed revisions 412, and weak/multiple/wildcard revisions 400. There is no automatic merge. On 412, obtain the current revision, decide the intended new change, and use a fresh operation key. On 429, wait for `Retry-After` and retry the unchanged request. A request rejected before its commit for a reason a retry would repeat (400, 403, 404, 412) keeps that outcome under its `Idempotency-Key`. A request that failed for a temporary reason before anything was committed (a client disconnect, a busy repository, an internal error) is not recorded, so retrying it with the same key runs it normally. On an ambiguous network or 500 error, retry the unchanged request with the same key: trusted operation provenance recovers an accepted commit without writing again. A 500 can mean the change was saved but its receipt was not confirmed; the retry returns that receipt with `replayed: true`. Revocation, grant removal and moving content outside the current grant also apply to replay. Write-only responses and errors never return existing content.

Document/table lists and table-row lists default to 50 entries, with a maximum of 100. Authorization precedes pagination. Cursors bind the key, policy, endpoint and committed project snapshot; a changed policy or HEAD returns 409 `CURSOR_STALE`, requiring a fresh first page. Authenticated responses are `Cache-Control: no-store` and carry `X-Request-Id`. Errors use `{"error":{"code":"...","message":"...","requestId":"..."}}`.

The [generated OpenAPI reference](project-machine-api.openapi.json) lists all endpoints, schemas, headers and statuses. This slice excludes Python documents, image uploads, arbitrary file paths, moves, folder mutations, history restore, MCP and assistant access.

## Operations

Worker `system.reconcile` prunes terminal receipts after 30 days, audits after 90 days and obsolete rate windows, in batches of at most 5,000 per table. Reserved operations survive cleanup and appear in project settings for investigation. Inspect their key/operation UUIDs and trusted Git trailers before recovery; never delete an unresolved reservation merely to force a retry.

Git commits include `Weaver-Project-Key-Id`, `Weaver-Operation-Id: project-api:<UUID>`, `Weaver-API-Request-Hash` and `Weaver-API-Operation`. Captured machine names remain in document/table projections, history and activity after key renaming or revocation. The secret is never stored in Git, audit records or relisted credentials.

`WEAVER_PROJECT_API_OPERATION_LOCK_POOL_MAX` defaults to 2 and accepts 1–128. It is separate from repository and application pools. Lock order is operation → project repository → short policy transaction; management and project liveness changes share the project lock. The feature adds migrations `20261013120000_project_machine_api` and `20261013120100_project_machine_operation_commit_check`, applied in that order by `pnpm db:migrate` (dev) and the guarded test/e2e migration commands before their suites. See [setup](../setup.md).
