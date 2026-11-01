# Publishing to Weaver with a project API key — guide for coding agents

This guide is for a coding agent that has to make an existing tool (a reporting
job, an audit script, a CI step) publish its results into a Weaver project. It
covers what to ask the human for, the request contract, the retry rules that
keep a publication from being written twice, and a reference client to adapt.

The human-oriented guide with curl examples is
[project-machine-api.md](project-machine-api.md). The full schema is in
[project-machine-api.openapi.json](project-machine-api.openapi.json). If this
guide and the OpenAPI file disagree, the OpenAPI file wins.

## 1. What you need from the human

A project API key is created in the Weaver UI, not through the API. Ask the
human to open **Project → Settings → Project API keys → Create**, select the
targets and actions your tool needs (see §3), and give you:

| Value              | Where it comes from                                                                                        | Typical env var          |
| ------------------ | ---------------------------------------------------------------------------------------------------------- | ------------------------ |
| Base URL           | Weaver's public URL including its path prefix, e.g. `https://weaver.example/weaver`                        | `WEAVER_BASE_URL`        |
| Project UUID       | Shown in the generated examples after the key is created                                                   | `WEAVER_PROJECT_ID`      |
| Secret             | Shown **once** after creation; sent as the bearer token                                                    | `WEAVER_PROJECT_API_KEY` |
| Target UUIDs       | Document, table and folder UUIDs, shown in the generated examples, or discoverable with `GET /grants` (§4) | tool config              |
| Table column UUIDs | In the generated append example, or from `GET /tables/{id}` when the key has Read on the table             | tool config              |

Never hard-code or log the secret. Read it from the environment or a secret
store. The key works for exactly one project and only on the
`/api/v1/projects/{projectId}` endpoints. It is not a user login and cannot use
the tRPC or MCP endpoints.

Keys expire (default 90 days, 1–365 or none) and are rate limited (default 100
requests per minute). A 401 after months of working usually means the key
expired or was revoked; the human fixes that in settings.

## 2. Mental model

- **Content lives in Git.** Each successful write is one commit. Weaver indexes
  it in the background; your tool does not wait for that.
- **Revision = ETag.** Every document and table has a revision: the 40-hex SHA
  of the last commit that touched _that_ resource. Responses carry it as a
  strong ETag, quoted: `ETag: "3f0c…"`. Edits to other resources do not change
  it.
- **Optimistic concurrency.** Every write to an existing resource (replace,
  append rows, patch rows, delete) must send `If-Match` with the exact ETag
  string, quotes included. If someone changed the resource meanwhile, you get
  412 and nothing is written. Creating a document or table needs no `If-Match`.
- **Idempotency.** Every write must send an `Idempotency-Key` (8–128 chars,
  `[A-Za-z0-9_.:-]`). Sending the identical request again with the same key
  returns the original receipt with `"replayed": true` instead of writing
  again. Sending a _different_ request with a used key returns 409
  `IDEMPOTENCY_KEY_REUSED`. Keys are scoped to the API key, across all
  endpoints, and remembered for 30 days.
- **Receipts, not content.** Writes return a receipt
  (`resourceId`, `path`, `revision`, `operationId`, `replayed`, `generatedIds`),
  never the stored content.
- **Authorship.** Commits and history show the key's name as the author.

## 3. Choosing grants

Grants are per target with four independent actions. Nothing is selected
automatically, and an action applies only to what it names.

| Your tool wants to…                         | Grant                                                                       |
| ------------------------------------------- | --------------------------------------------------------------------------- |
| Overwrite one fixed document ("latest run") | Update on that document                                                     |
| Create a new document per run               | Create on a document folder (or on the documents root)                      |
| Append result rows to a table               | Create on that table                                                        |
| Change cells of existing rows               | Update on that table (plus Read to find the rows, see §6.4)                 |
| Replace a whole table                       | Update, plus Create to add rows, plus Delete to remove rows/columns/options |
| Create a table per run                      | Create on a table folder (or on the tables root)                            |
| Read what it published earlier              | Read on the target                                                          |

Folder grants cover all subfolders and content added later. A key without Read
can still get a revision with `HEAD` on any target it may change, so a
write-only publisher never needs Read.

## 4. Endpoints

All paths are relative to `{BASE_URL}/api/v1/projects/{projectId}`. Every
request sends `Authorization: Bearer {secret}`. Write requests with a body send
`Content-Type: application/json` (optionally `; charset=utf-8`). Bodiless
methods (`DELETE`, `HEAD`, `GET`) must not send a body.

| Method   | Path                               | Action needed           | If-Match | Body                                         | Success |
| -------- | ---------------------------------- | ----------------------- | -------- | -------------------------------------------- | ------- |
| `GET`    | `/grants`                          | any                     | —        | —                                            | 200     |
| `GET`    | `/documents?limit=&cursor=`        | Read                    | —        | —                                            | 200     |
| `POST`   | `/documents`                       | Create                  | no       | `{title, folder, markdown}`                  | 201     |
| `HEAD`   | `/documents/{id}`                  | Read/Update/Delete      | —        | —                                            | 200     |
| `GET`    | `/documents/{id}`                  | Read                    | —        | —                                            | 200     |
| `PUT`    | `/documents/{id}`                  | Update                  | yes      | `{markdown, title?}`                         | 200     |
| `DELETE` | `/documents/{id}`                  | Delete                  | yes      | —                                            | 200     |
| `GET`    | `/tables?limit=&cursor=`           | Read                    | —        | —                                            | 200     |
| `POST`   | `/tables`                          | Create                  | no       | `{title, folder, columns, rows?}`            | 201     |
| `HEAD`   | `/tables/{id}`                     | any                     | —        | —                                            | 200     |
| `GET`    | `/tables/{id}`                     | Read                    | —        | —                                            | 200     |
| `PUT`    | `/tables/{id}`                     | Update (+Create/Delete) | yes      | `{title?, columns, rows}` (all IDs required) | 200     |
| `DELETE` | `/tables/{id}`                     | Delete                  | yes      | —                                            | 200     |
| `GET`    | `/tables/{id}/rows?limit=&cursor=` | Read                    | —        | —                                            | 200     |
| `POST`   | `/tables/{id}/rows`                | Create                  | yes      | `{rows: [{id?, cells}]}` (1–1,000 rows)      | 200     |
| `PATCH`  | `/tables/{id}/rows`                | Update                  | yes      | `{rows: [{rowId, set?, clear?}]}` (1–1,000)  | 200     |
| `DELETE` | `/tables/{id}/rows/{rowId}`        | Delete                  | yes      | —                                            | 200     |

`GET /grants` returns `{grants: [{kind, targetId, root, actions, available, path?, revision?}]}`
where `kind` is `document`, `documentFolder`, `table` or `tableFolder`. Use it
at startup to check that the key still has what the tool needs and fail with a
clear message otherwise.

`folder` in create bodies is `{"id": "<folder UUID>"}` or `{"root": true}`.
Folder paths are not accepted.

Lists return `{items, nextCursor}` (rows also return `revision`); default 50,
maximum 100 per page. Follow `nextCursor` until it is `null`. If content or the
key's grants change mid-listing you get 409 `CURSOR_STALE`; start again from
the first page.

### Strictness rules that will bite you

- **UUIDs must be lowercase canonical** (`^[a-f0-9]{8}-…-[a-f0-9]{12}$`), in
  paths and bodies. Uppercase UUIDs are rejected with 400.
- **Bodies are strict.** Unknown fields are rejected with 400. Send exactly the
  fields in the schema.
- **Query strings are strict.** Only `limit` and `cursor`, only on list
  endpoints, each at most once. Anything else is 400.
- **400 responses carry no detail** (`{"error":{"code":"BAD_REQUEST","message":"Invalid request",…}}`).
  Validate on your side before sending (§5) so you are not guessing.
- **Body limit** 5 MiB (413 above that).
- An optional `X-Request-Id` header (`[A-Za-z0-9_.:-]{1,64}`) is echoed back;
  log it with every error so the human can find the request in Weaver's audit.

## 5. Payload rules

### Documents

- `markdown` is the **body only**, at most 200,000 characters. Do not add a YAML
  front matter block or a top-level `# Title`: Weaver manages identity,
  metadata and the title heading itself. A body starting with
  `---\nid:`/`title:`/… or `<!-- weaver` is rejected.
- `title` is 1–200 characters. On `PUT` it is optional; omit it to keep the
  current title.
- Weaver normalizes Markdown the way its editor saves it: list markers become
  `-`, tables are re-aligned, footnotes are inlined, raw HTML and HTML comments
  are kept as visible escaped text. Generate plain CommonMark/GFM (headings,
  lists, tables, fenced code, links). `GET` returns the normalized form, so do
  not compare your input with a later `GET` byte for byte.
- Only Markdown documents are supported (no Python documents, images or
  attachments).

### Table cells

`cells` maps **column UUID → value**. Omitted columns stay empty. Values by
column type:

| Column type   | JSON value                                                                                                      |
| ------------- | --------------------------------------------------------------------------------------------------------------- |
| `text`        | string                                                                                                          |
| `longtext`    | string, at most 10,000 characters                                                                               |
| `number`      | finite JSON number (not a string)                                                                               |
| `boolean`     | `true` / `false`                                                                                                |
| `date`        | `"YYYY-MM-DD"` (a real calendar date)                                                                           |
| `datetime`    | ISO 8601 with a zone, e.g. `"2026-10-15T07:30:00Z"` or `"…+02:00"`; seconds optional, at most 3 fraction digits |
| `url`         | `http://` or `https://` URL without spaces, at most 2,048 characters                                            |
| `select`      | the **option UUID** (not its label)                                                                             |
| `multiselect` | non-empty array of distinct option UUIDs (at most 200)                                                          |
| `document`    | UUID of a document in the same project; the key needs Read on it                                                |

`false`, `0` and `""` are values. To empty a cell, list its column UUID in
`clear` of a `PATCH` row. `set` and `clear` must not share a column.

Limits: 100 columns, 200 options per select column, 10,000 rows and 5 MB per
table, 1,000 rows per append/patch request. Split larger appends into batches,
each with its own idempotency key and a fresh `If-Match` (the receipt's
`revision` from the previous batch, quoted, is the next `If-Match`).

When you append without row `id`s, Weaver allocates them and returns them in
`generatedIds.rowIds` in request order. Store them if you will update those
rows later.

## 6. Publishing patterns

### 6.1 Overwrite one "latest" document

1. `HEAD /documents/{id}` → ETag.
2. `PUT /documents/{id}` with `If-Match: <ETag>`, `Idempotency-Key`, `{markdown}`.

On 412 someone edited the document since your `HEAD`. If the tool owns the
document outright, take a fresh `HEAD` and send the same content again **with a
new idempotency key**; otherwise stop and report.

### 6.2 Create one document per run

`POST /documents` with `{title, folder, markdown}` and an idempotency key derived
from the run's identity, e.g. `audit-report-2026-10-15`. A rerun of the same
day's job with the same content then returns the existing receipt instead of
creating a duplicate, even if the tool lost its local state. A same-day rerun
with _different_ content gets 409 `IDEMPOTENCY_KEY_REUSED`: the first run of
the day wins. If every rerun should publish, add a content hash to the key. Titles do not need to be unique;
Weaver derives a unique path.

### 6.3 Append rows

1. `HEAD /tables/{id}` → ETag.
2. `POST /tables/{id}/rows` with `If-Match`, `Idempotency-Key`,
   `{"rows":[{"cells":{...}}]}`.

### 6.4 Update rows by your own key

The API has no "upsert by column value". Keep an external key column (for
example `Account`), read the rows once (`GET /tables/{id}/rows`, needs Read),
build a map from your key to row UUID, then `PATCH` the changed rows and
`POST` the new ones. Do both against the same revision chain: use the receipt
`revision` of one write as the `If-Match` of the next.

## 7. Handling responses

Errors look like `{"error":{"code":"…","message":"…","requestId":"…"}}`.

| Status                                     | Meaning                                                        | What the tool should do                                                                                                                 |
| ------------------------------------------ | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 200/201                                    | Done; `replayed: true` means an earlier attempt already did it | Treat both as success                                                                                                                   |
| 400                                        | Invalid request (schema, UUID format, cell value, header)      | Do not retry. Fix the request; the key is now spent, use a new one                                                                      |
| 401                                        | Missing, wrong, expired or revoked key                         | Do not retry. Tell the human to check the key                                                                                           |
| 403                                        | Key lacks the action for this target                           | Do not retry. Tell the human which grant is missing                                                                                     |
| 404                                        | Target does not exist or is outside the key's grants           | Do not retry. Check the UUID and grants                                                                                                 |
| 409 `IDEMPOTENCY_KEY_REUSED`               | Same key, different request                                    | Bug in key derivation; use a new key                                                                                                    |
| 409 `CURSOR_STALE`                         | Listing changed underneath you                                 | Restart the listing                                                                                                                     |
| 409 other                                  | The operation needs investigation                              | Stop and report the key and request ID; never work around it with a new key                                                             |
| 412                                        | Resource changed since your revision                           | Re-read the revision, decide again, retry with a **new** key                                                                            |
| 413                                        | Body over 5 MiB                                                | Split the request                                                                                                                       |
| 415                                        | Missing/wrong `Content-Type`                                   | Send `application/json`                                                                                                                 |
| 428                                        | `If-Match` missing on an existing resource                     | Send it                                                                                                                                 |
| 429                                        | Rate limited                                                   | Sleep `Retry-After` seconds, resend the **identical** request with the **same** key                                                     |
| 500/502/503/504, timeout, connection reset | Outcome unknown                                                | Resend the **identical** request with the **same** key, with backoff. If the write was saved, you get its receipt with `replayed: true` |

The rule behind the table: **a retry must be byte-for-byte the same request**
(method, path, body, `If-Match`) **with the same key**. That is why the
reference client below saves each request to disk before sending it, and
resends the saved copy after a crash instead of rebuilding it from data that
may have changed.

A 400, 403, 404 or 412 is remembered under its key: resending with the same key
returns the same error. After fixing the cause, use a new key (for example
append `.2`).

## 8. Reference client (Python, standard library only)

Copy this into the tool and adapt it. It implements the rules above: a
write-ahead journal per operation, identical resends, backoff on 429/5xx and
network errors, and spent-key protection.

```python
"""Weaver project API publisher. Standard library only; Python 3.9+."""
from __future__ import annotations

import json
import os
import random
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Callable, Optional

TRANSIENT_STATUSES = {500, 502, 503, 504}
SPENT_STATUSES = {400, 403, 404, 412}


class WeaverApiError(Exception):
    def __init__(self, status: int, code: str, request_id: Optional[str], retry_after: Optional[float] = None):
        super().__init__(f"Weaver API {status} {code} (request {request_id})")
        self.status = status
        self.code = code
        self.request_id = request_id
        self.retry_after = retry_after


class WeaverClient:
    def __init__(self, base_url: str, project_id: str, api_key: str,
                 state_dir: str = ".weaver-requests", timeout: float = 60, max_attempts: int = 6):
        self.root = f"{base_url.rstrip('/')}/api/v1/projects/{project_id}"
        self.api_key = api_key
        self.state_dir = Path(state_dir)
        self.timeout = timeout
        self.max_attempts = max_attempts

    # -- transport -----------------------------------------------------------
    def _call(self, method: str, path: str, body: Optional[bytes] = None,
              headers: Optional[dict] = None) -> tuple[int, Any, Any]:
        all_headers = {"Authorization": f"Bearer {self.api_key}", "Accept": "application/json", **(headers or {})}
        if body is not None:
            all_headers["Content-Type"] = "application/json"
        request = urllib.request.Request(self.root + path, data=body, method=method, headers=all_headers)
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                raw = response.read()
                return response.status, response.headers, json.loads(raw) if raw else None
        except urllib.error.HTTPError as error:
            try:
                payload = json.loads(error.read())["error"]
            except (ValueError, KeyError, TypeError):
                payload = {}
            retry_after = error.headers.get("Retry-After")
            raise WeaverApiError(error.code, payload.get("code", "UNKNOWN"),
                                 payload.get("requestId") or error.headers.get("X-Request-Id"),
                                 float(retry_after) if retry_after else None) from None

    def _with_retries(self, send: Callable[[], tuple[int, Any, Any]]) -> tuple[int, Any, Any]:
        for attempt in range(1, self.max_attempts + 1):
            try:
                return send()
            except WeaverApiError as error:
                if error.status == 429:
                    delay = error.retry_after or 60
                elif error.status in TRANSIENT_STATUSES:
                    delay = min(60, 2 ** attempt) + random.random()
                else:
                    raise
                if attempt == self.max_attempts:
                    raise
            except (urllib.error.URLError, TimeoutError, ConnectionError):
                if attempt == self.max_attempts:
                    raise
                delay = min(60, 2 ** attempt) + random.random()
            time.sleep(delay)
        raise AssertionError("unreachable")

    # -- reads ---------------------------------------------------------------
    def get(self, path: str) -> Any:
        return self._with_retries(lambda: self._call("GET", path))[2]

    def revision(self, collection: str, resource_id: str) -> str:
        """Quoted ETag of a document or table; collection is 'documents' or 'tables'."""
        _, headers, _ = self._with_retries(lambda: self._call("HEAD", f"/{collection}/{resource_id}"))
        return headers["ETag"]

    def list_all(self, path: str) -> list:
        items, cursor = [], None
        while True:
            page = self.get(path + "?limit=100" + (f"&cursor={urllib.parse.quote(cursor, safe='')}" if cursor else ""))
            items.extend(page["items"])
            cursor = page["nextCursor"]
            if cursor is None:
                return items

    # -- writes --------------------------------------------------------------
    def _journal(self, operation_id: str) -> Path:
        return self.state_dir / f"{operation_id}.json"

    def _save(self, path: Path, data: dict) -> None:
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        temporary = path.with_name(path.name + ".tmp")
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(data, handle)
        os.replace(temporary, path)

    def mutate(self, operation_id: str, method: str, path: str, payload: Optional[dict] = None,
               revision_of: Optional[tuple[str, str]] = None) -> dict:
        """Send one write at most once. A saved request for this key is resent unchanged."""
        journal = self._journal(operation_id)
        done = journal.with_name(journal.name + ".done")
        if done.exists():
            return json.loads(done.read_text(encoding="utf-8"))["receipt"]
        if journal.with_name(journal.name + ".spent").exists():
            raise ValueError(f"idempotency key {operation_id} was already rejected; use a new key")
        if journal.exists():
            saved = json.loads(journal.read_text(encoding="utf-8"))
            if (saved["method"], saved["path"]) != (method, path):
                raise ValueError(f"key {operation_id} is saved for {saved['method']} {saved['path']}")
        else:
            saved = {
                "method": method,
                "path": path,
                "body": None if payload is None else json.dumps(payload, ensure_ascii=False),
                "ifMatch": self.revision(*revision_of) if revision_of else None,
            }
            self._save(journal, saved)
        return self._send_saved(operation_id, saved)

    def _send_saved(self, operation_id: str, saved: dict) -> dict:
        journal = self._journal(operation_id)
        headers = {"Idempotency-Key": operation_id}
        if saved["ifMatch"]:
            headers["If-Match"] = saved["ifMatch"]
        body = saved["body"].encode("utf-8") if saved["body"] is not None else None
        try:
            _, _, receipt = self._with_retries(lambda: self._call(saved["method"], saved["path"], body, headers))
        except WeaverApiError as error:
            if error.status in SPENT_STATUSES or error.code == "IDEMPOTENCY_KEY_REUSED":
                journal.replace(journal.with_name(journal.name + ".spent"))
            raise
        self._save(journal.with_name(journal.name + ".done"), {**saved, "receipt": receipt})
        journal.unlink()
        return receipt

    def resume_pending(self) -> list[tuple[str, Any]]:
        """Resend requests a crashed run left behind. Call once at startup."""
        results = []
        for journal in sorted(self.state_dir.glob("*.json")):
            operation_id = journal.name[: -len(".json")]
            try:
                saved = json.loads(journal.read_text(encoding="utf-8"))
                results.append((operation_id, self._send_saved(operation_id, saved)))
            except WeaverApiError as error:
                if error.status not in SPENT_STATUSES and error.code != "IDEMPOTENCY_KEY_REUSED":
                    raise
                results.append((operation_id, error))
        return results

    # -- helpers -------------------------------------------------------------
    def replace_document(self, operation_id: str, document_id: str, markdown: str,
                         title: Optional[str] = None) -> dict:
        payload: dict = {"markdown": markdown}
        if title is not None:
            payload["title"] = title
        return self.mutate(operation_id, "PUT", f"/documents/{document_id}", payload,
                           revision_of=("documents", document_id))

    def create_document(self, operation_id: str, title: str, markdown: str,
                        folder_id: Optional[str] = None) -> dict:
        folder = {"id": folder_id} if folder_id else {"root": True}
        return self.mutate(operation_id, "POST", "/documents",
                           {"title": title, "folder": folder, "markdown": markdown})

    def append_rows(self, operation_id: str, table_id: str, rows: list[dict]) -> list[dict]:
        """rows: list of {column UUID: value}. Batches of 1,000; returns one receipt per batch."""
        receipts = []
        for index in range(0, len(rows), 1000):
            batch = rows[index:index + 1000]
            key = operation_id if len(rows) <= 1000 else f"{operation_id}.{index // 1000}"
            receipts.append(self.mutate(key, "POST", f"/tables/{table_id}/rows",
                                        {"rows": [{"cells": cells} for cells in batch]},
                                        revision_of=("tables", table_id)))
        return receipts

    def update_rows(self, operation_id: str, table_id: str, changes: list[dict]) -> dict:
        """changes: [{"rowId": UUID, "set": {column UUID: value}, "clear": [column UUID]}], at most 1,000."""
        return self.mutate(operation_id, "PATCH", f"/tables/{table_id}/rows", {"rows": changes},
                           revision_of=("tables", table_id))
```

### Using it in a reporting tool

```python
import datetime, hashlib, json, os

client = WeaverClient(os.environ["WEAVER_BASE_URL"], os.environ["WEAVER_PROJECT_ID"],
                      os.environ["WEAVER_PROJECT_API_KEY"])
client.resume_pending()  # finish whatever a crashed run left behind

day = datetime.date.today().isoformat()
markdown = render_report_markdown()          # your tool's output, body only
digest = hashlib.sha256(markdown.encode()).hexdigest()[:16]

# One new document per day; a same-day rerun returns the first receipt.
client.create_document(f"audit-report-{day}", f"Audit report {day}", markdown,
                       folder_id=REPORTS_FOLDER_ID)

# A fixed "latest" page; the content hash makes an identical rerun a no-op.
client.replace_document(f"audit-latest-{day}-{digest}", LATEST_DOCUMENT_ID, markdown)

# Result rows; the key covers exactly this batch of rows.
rows = [{ACCOUNT_COLUMN_ID: f.account, SEVERITY_COLUMN_ID: SEVERITY_OPTION_IDS[f.severity],
         CHECKED_AT_COLUMN_ID: f.checked_at.isoformat(timespec="seconds")} for f in findings]
if rows:
    rows_digest = hashlib.sha256(json.dumps(rows, sort_keys=True).encode()).hexdigest()[:16]
    client.append_rows(f"audit-rows-{day}-{rows_digest}", RESULTS_TABLE_ID, rows)
```

Notes on the client:

- Key derivation is the part to think about. Derive keys from what the write
  _means_ (`report + day`, `report + content hash`) so a rerun dedupes, and
  never reuse a key for different content: that is a 409.
- The journal (`.weaver-requests/`) contains report content but never the
  secret. Keep it on persistent storage next to the tool's state, mode `0700`.
  `<key>.json` is a request not yet confirmed, `<key>.json.done` a completed
  one with its receipt, `<key>.json.spent` a rejected key. Delete `.done` and
  `.spent` files after 30 days, when Weaver forgets the keys too.
- Completed requests are kept because `If-Match` is part of the remembered
  request: after a successful write the resource has a new revision, so a
  rebuilt request with the same key would differ and get 409
  `IDEMPOTENCY_KEY_REUSED`. With the `.done` file the client returns the stored
  receipt instead. If the state directory is lost, a rerun of a create (no
  `If-Match`) with identical content is still replayed by Weaver, while a rerun
  of an `If-Match` write with an old key gets 409; treat that as "this key was
  already used" and decide whether to publish again with a new key.
- On a 412 the client raises and marks the key spent. Handle it in the tool:
  for a document the tool owns, call the helper again with a new key (for
  example `f"{key}.2"`); otherwise report.
- `datetime` values must carry a zone: use timezone-aware datetimes
  (`datetime.now(timezone.utc)`), or `isoformat()` produces a value without a
  zone and the request fails with 400.

## 9. Checklist before you hand the integration back

- [ ] Secret only from the environment or secret store; never printed or logged.
- [ ] Startup check with `GET /grants` that fails clearly when a target or action is missing.
- [ ] Every UUID lowercase; cells keyed by column UUID, selects by option UUID.
- [ ] Every write has an idempotency key derived from the publication's meaning.
- [ ] Every write to an existing resource has `If-Match` from `HEAD` or the previous receipt.
- [ ] Retries resend the saved request unchanged; 429 honours `Retry-After`.
- [ ] 400/401/403/404/409/412 are surfaced with the `requestId`, not retried blindly.
- [ ] Markdown is body only, no front matter, no `# Title`, under 200,000 characters.
- [ ] Row batches of at most 1,000; tables stay under 10,000 rows and 5 MB.
- [ ] Tested once against a scratch document/table before pointing it at the real ones.
