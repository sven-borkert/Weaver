# Changelog

All notable changes to Weaver. Format: Keep a Changelog; versions match package.json.

## [Unreleased]

### Fixed

- The activity feed no longer fails with "Invalid dashboard result" when a released exam attempt, a finished notebook or a failing Git sync falls inside its window.

### Added

- A Wiki section appears in the sidebar, between Imports and Tasks, once the wiki is enabled for a project. Its Input page takes notes and files, shows the queue and what needs attention, and offers Process, Retry, Confirm and Remove to Editors; Viewers can read. Runs appear in the bell for whoever started them and in Project Activity.
- **The agent itself is not in this release.** Enabling the wiki and pressing Process prepares sources durably, then the run ends with a plain message that this version cannot run the wiki agent yet. Inputs return to the queue and reuse their sources once the agent ships.
- Wiki inputs become durable source pages and source tables. Notes are written directly; PDF, Word (docx), Excel (xlsx), CSV, Markdown and text files parse through the Imports pipeline without appearing in Imports. Spreadsheets become source tables under `tables/wiki-sources/`. Source pages enter keyword search and skip AI indexing; their index lights say "AI indexing skipped (source page)".
- A new scanner checks notes, file names, parsed drafts and every table cell for secrets. A hit holds the input under Needs attention until an Editor confirms that exact content, and reports only what it found and where.
- A file referenced by a live wiki input cannot be replaced or deleted (`SOURCE_PROTECTED`); it can still be renamed. Removing the input, or an Owner unlinking it, lifts the protection.

### Changed

- Workers gain a `wiki` role (`wiki.tick`, `wiki.run`), on by default and assigned to `agent-worker` in the Compose files. **Before upgrading:** operators who pinned `WEAVER_ENABLED_WORKER_ROLES` must add `wiki`, or a worker assigned that role refuses to start. Without a worker consuming the role, a queued wiki run cancels itself after 10 minutes with "no worker is consuming wiki runs".
- Disabling the wiki agent or revoking its identity now cancels queued and preparing wiki runs and returns their inputs to the queue.

## [0.1.232] - 2026-11-02

### Added

- Documents can now be given a type, summary and tags (and sources through the API and importers). Editors set them in the document menu's Properties dialog; the assistant and MCP `create_document`/`patch_document` tools and their `propose_` counterparts accept `properties` (type, summary, tags). An omitted field stays, `null` clears it, and the type `source` and the `reviewExempt` flag stay reserved for Weaver itself. A human who sets review settings on a page that Weaver exempted from review clears the exemption.
- The documents explorer shows Type and Summary columns and a Type filter once any page has them, and an Index view (`/projects/<id>/documents/index-view`, linked from the root folder) lists pages grouped by type with their summaries, led by the project's overview page when one is set.
- `list_documents` and the document list accept `type` and `tag` filters and `includeSummary`.
- Markdown imports map YAML `type`, `tags`, `summary` and `aliases` (into tags); a Weaver header's type, summary and tags carry over, but never its `reviewExempt` flag or sources. A ZIP Replace keeps the target's own properties unless the import names some. Exports and downloads keep the stored properties line.
- Sending a document to another Weaver carries its type, summary and tags (receivers advertise `capabilities.documentProperties`; older ones still receive the page without them).

### Changed

- The assistant now needs a model context window of about 89,300 tokens (was 88,100): 71,075 B of tool definitions (was 70,026 B).
- Rollout: upgrade every Weaver instance that shares documents (pull remotes, transfers, imports of exports) before anyone sets a property. The first property write puts a `properties:` line into the document header, which instances older than 0.1.226 cannot read, so it is a one-way door for downgrades.

## [0.1.231] - 2026-11-02

### Added

- Project wiki agent, first step: an Owner can enable a project's wiki through the new `wiki` settings API. Enabling creates the wiki agent identity, a `wiki/` folder with a `wiki/sources/` folder, a wiki guide page from Weaver's template (approved as it is) and an overview page. Maintainers review the exact guide text (hidden and bidirectional characters removed, changes since the last approval and lines that hand rules to somewhere else flagged) and approve it by digest; guides over 16,000 bytes are refused. Disabling keeps everything; revoking the agent disables the feature until it is enabled again with a new identity.
- Project settings has a Wiki agent card for Maintainers and Owners: state, model route readiness, guide approval with a "Review guide" dialog (exact text, what was removed, changes since the approved text, advisory flags), guide suggestions, and Owner controls to enable, disable, revoke, pick the guide page and set the 24-hour budget.
- The assistant and the MCP `wiki` toolset gain `get_wiki_guide` (the approved guide as reference data that cannot request tool calls), and the assistant gains `find_page`, `inspect_links` and `list_recent_changes`. The assistant now needs a model context window of about 88,100 tokens (was 83,600).
- Administration › AI has an optional "Project wiki agent" route (chat and tool use). Unassigning it stops every project's agent.

## [0.1.227] - 2026-11-02

### Security

- Accounts can no longer use an `@weaver.invalid` email address, through the admin form or OIDC sign-in. Weaver reserves the domain for machine commit authors.

## [0.1.226] - 2026-11-02

### Added

- Documents render LaTeX formulas: `$…$` inline and `$$…$$` blocks in the editor, reader, assistant text, exam prompts and PDF export, also in table headers and cells. Click a formula to edit its source, type `$x^2$`, or use Insert › Inline formula / Formula block. Files keep plain LaTeX, and formulas Weaver had already saved with extra escapes (`\\times`, `w\_1`) are repaired when read. Amounts such as `$5 and $10` stay text.
- GitHub Actions builds the Docker images and pushes them to GitHub Container Registry from `main` and tags, using the same build script and tags as GitLab CI.
- A README and a self-contained quick start: `docker-compose.quickstart.yml` builds every service from the checkout, needs no registry or reverse proxy, and `scripts/quickstart-env.sh` generates its secrets and first Admin. It serves HTTP on loopback only.

### Changed

- MCP: a new opt-in `wiki` toolset (`X-Weaver-Toolsets: wiki`) with `find_page`, `inspect_links` and `list_recent_changes` (commits Weaver cannot vouch for are reported as `external` without author or message text). The MCP instructions, the assistant and the document write tools now teach the tracked link form `[Title](weaver://document/<id>)`; the resource URI sentence is gone from the instructions.
- Documents can carry an optional `properties` header line (type, summary, tags, sources). Weaver reads and preserves it through every edit, move, review and restore but does not write it yet. Multi-instance setups: upgrade every instance before any property is written, as older versions cannot read the line.
- Commit messages can no longer contain lines that look like `Weaver-*` trailers, so change summaries cannot forge provenance.
- Deployment: `WEAVER_IMAGE_PREFIX` now defaults to `weaver` and `WEAVER_TLS_CERTRESOLVER` to `letsencrypt`. `weaver-upgrade` requires `WEAVER_GITLAB_API` and `WEAVER_GITLAB_PROJECT`, set in `web.env` or the environment.

## [0.1.216] - 2026-10-25

### Fixed

- ZIP exports reject unsafe paths; ZIP replacement checks the previewed revision and retains the upload for another preview after conflicts. Document restore recovers historical images, and create recovery identifies the document instead of an adjacent asset. Table history rejects commits outside published ancestry.
- Accepted Git writes survive attribution-ledger failures. Published scheduled reports retain recovery receipts, retry acknowledgement without regenerating content, and no longer count acknowledgement errors as provider failures. Schedule ticks skip queued or running tasks.
- OAuth resources reject disabled clients; introspection respects token and consent revocation. Consent acceptance rechecks the live session under the credential lifecycle lock. Project API rate windows cannot move backward.
- External MCP connections and enabled catalog schemas have per-owner limits, and execution tools are registered after loading. Assistant deadlines remain enforced through final validation.
- Background-work queries bound old import/notebook history, hide other owners' task error details, and exclude deleted documents from knowledge failure counts. Stale ready-state claims no longer prevent entity-vector repair.
- Archive readers bound actual decompression. Upload admission reserves space without unverified replacement credit; aborted downloads release their slots. Configuration-blocked imports expire under retention, and notebook queue outages do not turn committed uploads or renames into failures.
- Browser RPC logs redact payloads and exclude credential routers. Remote transfer links use the configured instance, API-key forms lock while saving, document links respect deployment base paths, and unsupported external images show a fallback.
- Added an atomic recovery procedure for partial knowledge-identity migration failures and a forward correction for verified vector-space fingerprints. Backups stop restarting writers and verify quiescence before dumping.
- Trainer exam lists use cursor pagination and grouped counts; attempt starts load only the definition. Attempt-history indexes match cursor ordering.
- Tag and non-default-branch pipelines cannot publish production or build-cache floating image aliases.

## [0.1.214] - 2026-10-21

### Changed

- The assistant now proposes new exams and exam edits for approval, like document and table changes, instead of saving them directly. The proposal card shows the whole exam, including question counts, max score and correct answers; Auto-approve applies them right away. Accepting needs the trainer role.

### Fixed

- Creating an exam through the assistant or MCP no longer fails when the model invents question or choice ids; Weaver always assigns them.
- The exam update tools explain that unchanged fields can be left out and that question ids from `get_exam` keep existing questions, so small edits no longer resend and recreate every question.

## [0.1.212] - 2026-10-21

### Changed

- Multiple-choice questions with several correct answers now give partial credit: each correct choice earns its share of the question's points and each wrong choice cancels one correct choice, never below zero.
- Answer choices are shuffled once when an attempt starts, so their order no longer reveals the correct answers; the order stays fixed for that attempt, including in review.

## [0.1.211] - 2026-10-21

### Fixed

- Pages no longer show a second, browser-level scrollbar next to the content scrollbar; hidden accessibility labels such as the exam editor's choice labels stay inside the scrolling content area.

## [0.1.210] - 2026-10-20

### Added

- Trainers can delete project exam attempts, and trainees can delete their own attempts, including ongoing attempts, with confirmation.

### Fixed

- Background work opens in a wider dialog, with paged items instead of scrollbars and only displayed results marked as seen.
- Exam editor text fields grow to fit their contents so the page owns vertical scrolling across browsers.
- Starting another attempt after deleting an older attempt no longer risks duplicate attempt numbers.

## [0.1.209] - 2026-10-20

### Changed

- Exam results now have a dedicated page: trainees see completed attempts in a table; trainers filter submitted, review and released results with explicit buttons to open each attempt.
- Exam questions show code examples in read-only dialogs across taking, preview, grading and result views. Editor and AI creation guidance require referenced code to be included in the question prompt.
- Automatic grading explanations include up to 100 characters from each answer choice instead of 40.

## [0.1.208] - 2026-10-20

### Fixed

- Returning to an ongoing exam restores saved answers immediately instead of showing outdated selections from the browser cache.

## [0.1.207] - 2026-10-20

### Fixed

- Exams containing free-text questions save correctly, including after reordering questions.
- Project member role controls have accessible names that distinguish them from training roles.

## [0.1.206] - 2026-10-20

### Fixed

- Importing a Markdown file with a numbered list item that has no text on its line (for example `5.` followed by a code block) no longer fails with "Could not import"; the item is kept as an empty entry.

## [0.1.205] - 2026-10-20

### Added

- Project Training settings: Off, Trainer or Trainee per member, alongside existing content roles.
- Exams with multiple-choice and free-text questions, correct answers, weights, passing thresholds, drafts, publishing and archiving.
- Timed trainee attempts with saved answers, reload recovery, unlimited retries and server-side expiry.
- Trainer review and release of explained grade proposals, with released results and correct answers in the trainee's notification bell.
- Seven trainer tools in the MCP `exams` toolset and scoped assistant trainer runs; agent grades await browser release.
- Demo trainer and trainee accounts, exam regression coverage and the `weaver-exams` project skill.

## [0.1.204] - 2026-10-19

### Changed

- Documents and Tables select multiple objects without checkboxes: Ctrl+click (Cmd+click on macOS) toggles an object, Shift+click adds the range since the last toggled one, and Space, Ctrl+A and Escape do the same from the keyboard. The selection bar offers Select all and explains the gestures while nothing is selected.

## [0.1.203] - 2026-10-19

### Added

- Drag folders into other folders or onto Up to move them in Documents and Tables, with protection against moving a folder into itself or its descendants.
- Select multiple objects with checkboxes or Select all in list and icon views, then move, delete, or drag them together. Bulk deletion keeps the existing empty-folder requirement; failed objects remain selected for retry.
- Mark selected documents as reviewed with a preview of eligible documents, including for assigned Viewer reviewers. Review and table deletion confirmations retain revision checks.

## [0.1.202] - 2026-10-18

### Changed

- The MCP server now lists a curated core toolset by default (about 26 KB of tool definitions instead of 128 KB): project, folder and document listing and reading, hybrid search, entities, tables, file overviews, and creating and patching documents. Existing clients see fewer tools until they send the `X-Weaver-Toolsets` header (`all` restores the full list).
- Tools of connected apps (`ext_…`) are listed only with the `external` toolset; they stay reachable through the meta-tools.

### Added

- `X-Weaver-Toolsets` header to list named toolsets (`documents`, `tables`, `files`, `graph`, `write`, `connections`, `admin`, `external`, `all`); core is always included and the credential's capabilities still decide what is allowed.
- `search_tools`, `describe_tool` and `call_tool`: find any permitted tool by task, read its input schema and run it without changing the client configuration. Calls through `call_tool` keep the inner tool's validation, guards and audit trail.
- Setup help on Account › API keys explains toolsets and shows the header for each client.

## [0.1.201] - 2026-10-18

### Added

- Administration Settings groups AI, Remote Instances and OIDC configuration in one tabbed page. OIDC settings support encrypted credentials, discovery testing and activation without a restart.

## [0.1.199] - 2026-10-17

### Added

- Optional OIDC sign-in with first-login account creation and verified-email linking, configurable for Authentik or another OIDC provider. Password login remains available; Weaver controls roles and shared-project access.
- Authentik setup instructions and a project-local `weaver-oidc` skill for maintaining the integration.

## [0.1.198] - 2026-10-15

### Added

- A project API guide for coding agents (`docs/api/project-api-agent-guide.md`): what to ask for, the request contract and strictness rules, cell formats per column type, publishing patterns, an error-handling table and a tested reference Python client with crash-safe retries.

## [0.1.197] - 2026-10-15

### Fixed

- Long document, table or folder names in the "Create project API key" permission picker are truncated again instead of pushing the dialog's content off its right edge.

## [0.1.196] - 2026-10-15

### Fixed

- The "Create project API key" dialog no longer fails with "Could not load targets."; the permission picker lists documents, tables and folders again.

## [0.1.195] - 2026-10-14

### Fixed

- Project API retries after an interrupted Git commit now repair document/table database records and schedule indexing before confirming success, while preserving subsequent edits or deletions.
- Project API table mutations check access before validating stored rows, so errors cannot reveal whether an ungranted table exists.
- Generated curl and Python publishing examples save the original payload and revision for retries with the same operation ID, including after a script restart.

## [0.1.194] - 2026-10-14

### Added

- Project API keys let scripts publish to a project without a user account. Maintainers and Owners create them under Project › Settings › Project API keys and choose exactly which documents, tables or folders each key may read, create, update or delete; folder permissions cover subfolders and content added later. Keys default to a 90-day expiry and 100 requests per minute, can be edited or revoked, and keep working when their creator leaves the project.
- The new key's secret is shown once, with copyable curl and Python examples for updating a fixed audit document, creating a dated report and appending table rows.
- A versioned REST API under `/api/v1/projects/{projectId}` serves these keys. Every write needs the current revision (`If-Match`) and an `Idempotency-Key`, so a retried request never publishes a report twice. Changes appear in history under the key's name.
- Every project API request is audited with metadata only (never secrets, Markdown or cell values). Write receipts are kept for 30 days and audit events for 90 days. Writes whose outcome could not be confirmed are listed in the key settings for investigation and are never retried automatically.
- An API usage guide (`docs/api/project-machine-api.md`) with curl and Python examples and a generated OpenAPI 3.1 reference.

## [0.1.193] - 2026-10-12

### Added

- Python files (`.py`) can be dropped into the documents area. They are stored as runnable scripts with Weaver's metadata in a comment block, get the same created/updated stamps, review schedule and knowledge indexing as Markdown documents, open in a code editor with syntax highlighting and line numbers (read-only for Viewers), and show the Python logo in the explorer. Binary and other non-text files are refused.

### Changed

- The explorer drop zone accepts `.md`, `.py` and `.zip` files; ZIP imports accept `.py` entries.
- Downloading a Python document returns it under its title (`deploy_prod.py`) with a `text/x-python` type. PDF export and "Send to another Weaver" are not available for Python files.
- Markdown imports now also refuse files containing control characters.
- Image uploads into a Python document are refused, and the cross-reference picker shows each document's kind icon.
- If the code editor fails to load, the saved Python file is shown read-only with a hint to reload.

## [0.1.191] - 2026-10-10

### Added

- Code blocks in documents show a copy icon in their top-right corner on hover or keyboard focus (always on touch screens). It copies the block's text, including unsaved edits, and confirms with a check mark.

## [0.1.190] - 2026-10-10

### Added

- "Mark all as reviewed" in a documents folder's actions menu, and beside the project root, marks every document in that folder and its subfolders that you are a reviewer of as reviewed in one step. The dialog first shows how many documents will be marked and how many are assigned to other reviewers and stay unchanged.

## [0.1.189] - 2026-10-09

### Changed

- The document page collects Explore graph, Mark as reviewed, Review settings, Export as PDF, Download as ZIP and Send to another Weaver in a "⋯" menu at the top right, so the title has the full width of the header.

## [0.1.188] - 2026-10-09

### Fixed

- Documents created or fully rewritten through MCP or the assistant no longer show their title twice when the submitted Markdown starts with the title as a heading.

## [0.1.187] - 2026-10-09

### Fixed

- The explorer's review icon describes a never-reviewed document as "Not reviewed yet · Review due now", matching the document header, instead of "Review due soon".

## [0.1.186] - 2026-10-09

### Added

- Document and table pages have a copy button beside the breadcrumbs. It copies the item's location (project, folder, name, project ID and document or table ID) as plain text, ready to paste into an MCP prompt.
- Documents in the explorer show a review icon: a check when reviewed and not due within 30 days, an amber clock when due within 30 days or never reviewed, and a red alert when overdue.

## [0.1.185] - 2026-10-09

### Added

- Account › API keys includes copyable MCP setup instructions for Claude Code, Codex, OpenCode, Claude Desktop and ChatGPT Desktop, using this instance's configured server URL and linking client documentation.

### Fixed

- Creating a user with a generated password keeps the password visible in the create dialog with a Copy button until Done, avoiding a handoff between dialogs. Dismissing the reveal clears the password; creation fields are disabled while saving.

## [0.1.184] - 2026-10-09

### Added

- Assistant and MCP can read TXT/Markdown source ranges and sections, original CSV rows/columns, YAML queries and nested JSON/YAML shapes. Signed continuations preserve long Unicode lines and wide structures within the complete 16,000-byte output budget; old YAML uploads work without reuploading.
- Structure inspection provides exact pointers and usable query paths, paged depth-first shapes, explicit array sampling and optional bounded scalar samples. JSONPath inputs now accept up to 8,192 UTF-8 bytes; oversized addresses return guidance to inspect a shorter ancestor.
- CSV reads preserve string values, indexed duplicate/empty headers and source record lines, with explicit cell omissions and truncation. Literal search reaches the whole text or CSV source; raw line reads recover oversized CSV cells and YAML that safe structured parsing rejects.
- Internal: YAML normalization shares the JSON query model, resolves string mapping-key aliases and preserves dates as strings, with bounded depth/aliases/expanded nodes and fixed errors for unsupported YAML features.

### Fixed

- Markdown outlines recognize headings inside lists and blockquotes, exclude fenced code and HTML blocks/comments, and preserve exact original section ranges. Closing hashes correctly produce empty titles.
- Markdown source reads reject a section combined with an explicit start or end line instead of silently discarding the line selector; section-only continuation remains supported.

## [0.1.183] - 2026-10-09

### Added

- Document folder menus and the document root offer a reviewer picker with inheritance details, preview counts and guarded recursive Apply. Changed selections refresh the preview; stale writes keep the dialog open for review and retry. Clearing a folder default leaves existing documents unchanged.
- Owners and Maintainers can preview and assign reviewers to a document folder or the document root in one guarded commit, replacing descendant reviewers and defaults. A separate action restores parent inheritance without changing existing documents; oversized batches fail before any writes.
- New documents use the nearest folder or document-root reviewer defaults across UI, assistant/MCP, accepted imports and remote transfers. Imported documents with unknown reviewers use destination defaults; existing review settings survive replacement, moves and recovery.
- Document folder metadata can store reviewer defaults, including a separate project document-root setting. Folder rename and move preserve these defaults alongside appearance and author stamps.

### Fixed

- Folder and single-document reviewer changes reject composed documents above 2,000,000 UTF-8 bytes before writing, identify the affected file, and preserve the entire batch when any document exceeds the limit.
- Recursive reviewer dialogs refresh preflight when revisiting a cached selection. After a committed write with failed refresh, recovery retries document/review caches while keeping further writes disabled; the reload hint remains until recovery completes.
- Folder reviewer changes reject malformed stored defaults before writing. Default reads preserve configured empty selections and unresolved references separately from effective reviewers, allowing unchanged selections to remain unchanged.
- Backfilling missing folder author stamps preserves existing appearance and reviewer defaults.

## [0.1.182] - 2026-10-08

### Added

- ZIP downloads/imports and remote document/table transfers preserve colors, icons and empty-folder appearance, carrying only referenced image assets. Plain Markdown imports warn when icon bytes are missing; older remote instances reject image-bearing transfers before content is sent.
- Documents, tables and folders have a shared Appearance picker with background presets/custom colors, builtin icons, emoji, image previews and independent resets. Explorer names, menus and badges remain readable on custom backgrounds; missing icon images use the default item icon.
- Documents and Tables icon views offer Standard and Compact sizes, remembering the choice in this browser while retaining names, keyboard navigation and drag/drop.
- Appearance metadata APIs let Editors set document, table and folder colors and icons, including PNG/JPEG/WebP uploads committed atomically with metadata. Viewer reads remain membership-gated, and content saves, review updates, restore and recovery retain appearance.

### Fixed

- Tables with repaired image icons can be sent to another instance immediately, including when the repair leaves the table revision unchanged. Decorative icons leave dragging to their explorer item.

## [0.1.181] - 2026-10-08

### Fixed

- Reviews: returning to Recently reviewed after a review or settings change refreshes the list immediately. Existing never-reviewed documents with future-dated review metadata are due now after migration.
- Word files: pictures in a table's first row are returned on the first table-read page, including tables with only that row. Explicit body-text outline settings no longer create false chapters through inherited styles or heading inference.

## [0.1.180] - 2026-10-08

### Added

- Images in documents can be resized: select an image in the editor and drag one of its corner handles, or pick 25 %, 50 %, 75 % or 100 % of the text width. The size is saved with the document and shown in the reader and in PDF exports; "Reset size" returns the image to its original size. Images without a chosen size are stored as before.

## [0.1.179] - 2026-10-08

### Added

- Reviews: a "Recently reviewed" list shows, for each document in your projects that has been reviewed, who reviewed it and when, newest first, together with its next review date. It includes reviews by anyone, not only your own.

### Changed

- Reviews has its own section in the sidebar instead of sitting under the project name, because it spans all projects. The page with the documents due for your review is now under "Open".

## [0.1.178] - 2026-10-08

### Changed

- Documents that have never been reviewed are now due for review right away instead of one interval after they were added. This covers new documents, imports and documents arriving from a Git remote; existing never-reviewed documents become due with this update.

## [0.1.177] - 2026-10-08

### Added

- Word files without heading styles now get an outline: chapters are taken
  from outline levels or, failing that, inferred from font size and bold
  titles, and marked as inferred.
- `read_word_blocks` reads a Word file from any block, so a search hit can be
  read in place; search matches name their chapter.
- Pictures in Word files are returned as image references that a document
  write copies into the document, as with OneNote notebooks.

## [0.1.176] - 2026-10-07

### Added

- Documents: every document has reviewers, a review interval and a record of its last review, shown in the document header. Reviewers mark a document as reviewed there; Owners and Maintainers change a document's reviewers and interval under "Review settings…". Marking reviewed or changing the settings does not change the document's updated date or author and creates no AI change summary; saving content does not count as a review.
- Reviews: a Reviews page lists the documents that are due for your review across all projects. It appears in the sidebar for everyone who is a reviewer somewhere, with the number of due documents.
- Project settings: a "Document review" card where Owners set the default reviewers and interval for new documents (initially the Owners, every 12 months) and manage reviewer groups. Other roles see it read-only.
- Existing documents get the project's default reviewers and interval in a background pass after the upgrade. Each project is updated in passes of up to 500 documents, with one `chore: add document review metadata` commit per pass (a project that also needs creator and last-editor details gets one `chore: upgrade document headers` commit instead). Their first review is due one interval later. Imported documents keep the reviewers and review interval they carry (reviewers that are not in the project are dropped, and the project's reviewers are used if none remain) and their review period starts at the import, so an imported document is never already reviewed; documents without review data get the project defaults; a recovered deleted document keeps its review data.
- Assistant and MCP: `read_document` and `list_documents` include the review fields (reviewers, interval, last review, due date). There are no tools that mark reviews.

### Changed

- Upgrade note: after the upgrade every existing document shows the upgrade time as its last edit in activity views, because the background pass rewrites each document's header.
- Upgrade note: stop every Weaver process (web, worker and MCP) before upgrading and start them all on the new version. Older processes cannot read the new document header and would show documents as unreadable, so the upgrade cannot be done one process at a time.
- Upgrade note: pull every project that has a Git remote before upgrading. Otherwise remote edits that were not pulled yet can show up as a duplicate of the document on the next pull.

## [0.1.175] - 2026-10-07

### Fixed

- Documents: "Export as PDF" and "Download as ZIP" in the document header have the same height as the "Explore graph" button beside them; they were noticeably taller.

## [0.1.174] - 2026-10-06

### Added

- Documents download as a ZIP that carries their images: "Download as ZIP (with images)" in the documents explorer's item menu and "Download as ZIP" in the document header. The ZIP holds the saved version as `<name>.md` with its `<name>.assets` directory beside it.
- Dropping a `.zip` on the Documents explorer imports it after a review. The dialog lists the documents and their images, names every file it leaves out and why, and offers to keep the ZIP's folder structure (missing folders are created) or to import everything flat into the current folder. A document that already exists here — the same Weaver id, or the same title in the target folder — is skipped unless it is set to "Import as copy" or "Replace"; Replace writes a new version of the existing document with the ZIP's text and images. Both a single-document ZIP and a folder download can be imported this way.

## [0.1.173] - 2026-10-06

### Added

- Background work: a failing Git sync appears in the Background work tray and on Account › Background work as "Git push failed" or "Git pull failed", with the reason and a link to the project's settings. Owners and Maintainers of the project see it and get the unseen marker on the bell; the entry disappears once the sync works again.
- Folders record who created them and when, and who last renamed or moved them. The values are stored in the folder's `.folder.json` (`created`, `createdBy`, `updated`, `updatedBy`), sync to a Git remote, and fill the Created, Created by, Updated and Updated by columns for folder rows in Documents; Tables shows the update columns. Existing folders get their values from Git history in the first background maintenance pass after the upgrade (one `chore: add folder metadata` commit per project, pushed to a configured Git remote).

## [0.1.172] - 2026-10-06

### Fixed

- Git sync: a failed push or pull is now recorded as an error in Administration › Diagnostics with its cause, for example a remote on a private address that `WEAVER_GIT_ALLOWED_SSH_TARGETS` does not list, or the SSH error text. Before, the attempt only set the status in the project's Git remote settings and nothing appeared in the event log. The settings message for an unreachable remote now says that a rejected SSH key is a possible cause and points to the diagnostics log.

## [0.1.171] - 2026-10-06

### Security

- Administration › Users: the password in the Create user dialog is masked and must be entered twice. A generated password stays masked in the form and is shown once after the user is created; a password typed by the administrator is no longer displayed.

## [0.1.170] - 2026-10-05

### Changed

- Design: the colours follow the blue version of the Weaver design kit. A cobalt accent on cool-white surfaces replaces the teal and ivory in the light theme, the dark theme is navy with a light-blue accent, and the sidebar is navy in both themes. The sign-in artwork, the favicon and the PDF export colours changed to match.

## [0.1.169] - 2026-10-05

### Changed

- Design: Weaver has a new look from the Weaver design kit. Ivory and stone neutrals with a teal accent replace the warm neutrals and blue in both the light and the dark theme, cards and dialogs have slightly tighter corners, and a W mark replaces the `>_` logo and favicon. Text sizes, control heights and panel widths are unchanged.
- Navigation: the project switcher moved from the breadcrumb to the top of the sidebar, where it shows the current project; in the collapsed sidebar it is an icon button. Breadcrumbs on project pages now start with a link to the project, and Administration, Account and Assistant pages start with their own section.
- Sign-in and the app consent page show a card over paper-and-thread artwork and stay light in the dark theme; small phones get a plain background.
- PDF export uses the new text, border and link colours.

## [0.1.168] - 2026-10-05

### Security

- Deployment: the `tools` image, which runs the migrations, no longer contains the agent instruction files (`CLAUDE.md`, `.claude/`, `.codex/`), the internal documentation under `docs/`, the deployment files or the web application's source and build output. It now holds the workspace packages only. The build checks every image for these paths before it is pushed.
- Deployment: images are pushed without build provenance attestations, which recorded the address of the internal Git repository.

## [0.1.167] - 2026-10-05

### Changed

- Deployment: images are pulled from a new container registry address. The Compose default image prefix, the env examples and the deploy docs use the new address. An installation that sets `WEAVER_IMAGE_PREFIX` or has a stored `docker login` for the old host needs both changed.

## [0.1.166] - 2026-10-03

### Added

- Tasks: choose the target document. A task can write into an existing document or create one under a title and folder you set; a target that is deleted later is created again. On each run it either replaces the content or, new, updates the document: the model is given the current document and revises it.
- Tasks: lists and the task page show the account a task runs as, with its e-mail address, since that account's project access and MCP connections apply.

### Changed

- Tasks: the create/edit dialog is a wide window with tabs for General (name, schedule), Instructions (a large editor), Focus (projects or a folder), Tools (MCP inputs and the connections available) and Output.

## [0.1.165] - 2026-10-03

### Added

- Assistant: restrict a conversation to a folder. The scope selector lists the document and table folders of the project; the assistant then works inside the chosen folder and creates new content there. It is a focus, not a lock: the assistant can still read other content of the project when you ask for it.
- Assistant: a session line shows the model in use and the conversation's totals (replies, tool calls, tokens in and out), and every reply shows its own model, tool calls, tokens and duration.
- Assistant: a full-screen button next to the close button enlarges the window to the whole browser window and back; the choice is remembered in this browser.

### Changed

- Assistant: **New** and **Conversations** are buttons in the conversation header instead of entries in the three-dot menu.
- Assistant: the explanation under **Auto-approve** moved into a tooltip, and the window header is more compact.

## [0.1.164] - 2026-10-03

### Fixed

- When a conversation continues, the assistant now sees its earlier tool calls as real tool calls instead of one long narrated text. Before, some models copied that narration and answered by describing tool work — including invented errors and results — without calling any tool.

## [0.1.163] - 2026-10-03

### Fixed

- The assistant is told not to claim it read, checked, created or changed something unless it actually called the tool in that reply, and earlier replies that created nothing are marked as such when the conversation continues. Before, a reply could say a document had been written although nothing was created, and later replies repeated the claim.

## [0.1.162] - 2026-10-03

### Changed

- The assistant can work through long tasks without stopping: one message may now take up to 200 tool steps (was 12) and run for up to two hours (was ten minutes), including the time it waits for your approvals.

## [0.1.161] - 2026-10-03

### Fixed

- The **Create key** and **Edit key** dialogs under Account › API keys scroll when they are taller than the window, so their buttons stay reachable on small screens.

## [0.1.160] - 2026-10-03

### Changed

- MCP connections no longer have an **Ask before** setting. Enabled tools are always available. In the assistant, read tools run on their own and write tools ask for approval, unless **Auto-approve** is ticked in the conversation: then write tools run without asking as well. Scheduled tasks can use the enabled read tools of any of your connections.

## [0.1.159] - 2026-10-03

### Changed

- The tool list of an MCP connection shows only the tools the server currently offers. Tools that disappeared at the last discovery no longer appear in the list, the tool count, or the bulk actions; choose **Unavailable** in the state filter to see them.

## [0.1.158] - 2026-10-02

### Changed

- The assistant can use every tool you enabled under **Account › MCP connections** without choosing tools per message. It searches your connections' tools, loads only the ones it needs (up to 20 per message) and then calls them, so large connections do not fill the model's context. The tool picker in the assistant composer is gone. Approval policies still apply, but on a connection set to **Never ask** the assistant can now run enabled write tools in any conversation without asking; choose **Ask before write tools** if you want to confirm each write.
- If a conversation's earlier messages used a different project scope, or the model's context window is too small, the assistant answers without external tools and says why.

## [0.1.157] - 2026-10-02

### Fixed

- MCP connections of every user, not only administrators, may reach the private or HTTP origins listed in `WEAVER_OUTBOUND_ALLOWED_ORIGINS`; all other endpoints must still be public HTTPS.

## [0.1.156] - 2026-10-02

### Changed

- MCP connections to other apps are now personal. Every user adds their own under **Account › MCP connections** with their own token, so the other app sees them, not a shared service account. Saving discovers the tools; **Enable all read tools** switches on everything the server marks read-only, and each tool's Read/Write can be changed. Tools you enable are available to your assistant, to MCP clients using your API key or OAuth grant with "Use your MCP connections", and to your scheduled tasks.
- Each connection asks before **write tools** (new default), before **every call**, or **never**. This applies to the assistant; MCP clients confirm on their side, and scheduled tasks can use any connection that does not ask before every call.
- Existing connections now belong to the administrator who created them; connections without a recorded creator were deleted. Scheduled-task inputs owned by someone else were removed.
- Connections owned by administrators may reach the private or HTTP origins listed in `WEAVER_OUTBOUND_ALLOWED_ORIGINS`; everyone else's connections reach public HTTPS endpoints only.

### Added

- A new API-key permission and OAuth scope, "Manage your MCP connections" (`external:manage`), lets MCP clients create, change, discover and delete your connections and enable their tools with `list_external_connections`, `create_external_connection`, `review_external_tools` and the related tools.

### Removed

- Administration › Connections and project grants for connections. The old address redirects to Account › MCP connections. `set_external_project_grants` is gone, and external tools no longer take a `weaverProjectId` argument.

## [0.1.155] - 2026-10-01

### Added

- Administration › Projects lists every project in the instance, including ones you are not a member of, with owners, member count, documents, tables and creation date. Opening a project shows its members, and administrators can add other users, change their role or remove them there. Project content still requires membership, and administrators still cannot change their own membership.

## [0.1.154] - 2026-10-01

### Added

- Administration › Connections shows each connection's tools as a table. Ticking On or changing Read/Write saves immediately, search matches names and descriptions, filters cover state, effect, and enabled, and **Enable all matching** / **Disable all matching** apply to every tool the filter finds. Saving approves the tool's current definition.
- Administrators' MCP clients can configure external MCP connections completely: `list_external_connections`, `get_external_connection`, `create_external_connection`, `update_external_connection`, `delete_external_connection`, `discover_external_connection`, `list_external_tools`, `get_external_tool`, `review_external_tools` (up to 500 tools atomically; returns the reviewed count and a size-bounded tool list), and `set_external_project_grants`. Tokens are write-only.

## [0.1.153] - 2026-10-01

### Added

- Documents can be saved as files. Drag a document from the documents list onto the desktop (Chrome, Edge and other Chromium browsers), or choose **Download** in its menu in any browser. The file is the document's Markdown exactly as Weaver stores it, without its images.
- Folders can be downloaded as a ZIP archive: **Download as ZIP** in a folder's menu, or the button above the list for the folder you are in, which at the top level downloads all documents of the project. The archive holds the documents and their images in the same folder structure, so image links keep working. Viewers can download too.

- Documents can be exported as PDF from the document header (Export as PDF). The PDF is produced on the server with the same look as the viewer, A4 with page numbers, images and Mermaid diagrams included; it always exports the saved version. When the server has no Chromium the button explains why.
- The assistant and MCP clients can import images into documents: screenshots from a OneNote notebook in Files, and PNG, JPEG, WebP or GIF image files from Files. `read_onenote` shows each page image as an image link that a document keeps when it is written, and Weaver copies the image into the document. Assistant proposals say how many images they add.
- Every document records when it was created and last updated, and by whom. The document header shows "Created … by … · Updated … by …", and the documents list has Created, Created by, Updated and Updated by columns. The fields are stored in the document's Markdown file, so they travel with Git push and pull.
- MCP clients and the assistant can set these fields, for example to give an imported document its original creation date and author. Dates cannot be in the future, an author is either a project member or a free-text name for someone outside Weaver, and the change history still shows who really made the change. Assistant proposals show the dates and authors they would set.
- Existing documents get their creator and last editor from their Git history once, in a single "upgrade document headers" commit per project made by background maintenance.

- Drag the edge of the left sidebar or of the right Context rail (documents and tables) to resize it. Arrow keys on the focused edge resize it in steps, a double-click restores the default width, and the widths are remembered in this browser.
- Documents have a **Contents** tab, now the first and default tab of the Context rail. It lists the document's headings, including unsaved ones while you edit. Clicking a heading jumps to that section (from the Markdown source view too), and the section you are reading is highlighted as you scroll. On phones, choosing a heading closes the Context drawer.
- Every document's Context rail has an **Index** tab showing how that document is indexed: keyword status and chunk count, the embedding dimensions and mode, how many chunks are embedded, the graph entities and relations extracted from it (each entity opens the graph), processing attempts and failures, and a rebuild's progress. Maintainers and Owners also see the embedding and extraction model names.
- Project settings › Knowledge index shows the embedding model, dimensions, mode, and vector type of the active and building generations.

- The workspace shows a warning bar when the server has no Git or a Git older than 2.36, which Weaver needs to read documents and tables. It explains why documents and tables fail to load and disappears once Git is upgraded, without a restart.
- Uploading a OneNote notebook (`.onepkg` or `.one`) to Files prepares it for the assistant straight away, instead of on the first read. Notebooks already in Files are prepared by the next background maintenance pass.
- The Files page shows each OneNote notebook's preparation status: waiting, preparing, ready with its page and section counts, or failed with the reason. The list refreshes while a notebook is being prepared.
- OneNote notebook preparation appears in Background work (the tray and Account › Background work) for the person who uploaded the file, and as Project work for Maintainers, with a link to the file.
- Send a document or table to another Weaver instance. An administrator registers the other instance under Administration › Remote instances (both administrators register each other); you connect your account under Account › Remote instances by signing in and consenting on the other instance; then "Send to another Weaver…" on a document or table copies its saved version (images included, cross-references as plain text) into a project and folder you pick there, created as you, without history.
- External MCP connections can accept any certificate, skipping TLS chain, expiry, and hostname validation for that connection only. Off by default; shown on the connection's detail page when on.
- MCP clients can use connected apps. An API key with the new "Use external MCP connections" permission (or an OAuth client granted the `external:use` scope) sees each enabled tool of an automatic external connection as its own MCP tool, named `ext_<connection>__<tool>`, in the projects the connection is granted to. Each call names its Weaver project with `weaverProjectId`, runs with the connection's service account, and is recorded under your user and key. Tools on connections that ask before each call are not available this way.

### Removed

- The deployed stack no longer joins the shared `ollama-shared` Docker network, and `WEAVER_OLLAMA_NETWORK` is gone. The deployment embeds through OpenRouter and runs no Ollama.

### Changed

- A commit that leaves a document's indexed text unchanged, such as a move, the one-time header upgrade, or a metadata-only change, no longer extracts the document again or re-embeds it. The existing graph and vectors are carried to the new revision.
- The one-time header upgrade makes one "chore: upgrade document headers" commit per project and pushes it to a configured Git remote. An editor that was open across the upgrade sees "Document changed since you loaded it" on its next save, once; reloading the document continues the edit.
- Document files read well in other Markdown viewers: the metadata sits in a hidden `<!-- weaver … -->` comment instead of a YAML block, and the title is the file's first `# ` heading. Existing documents are converted once by background maintenance; older versions in the history still open.
- Importing a Markdown file whose first line is a `# ` heading uses that heading as the document title instead of keeping it in the text.

- Files accepts uploads up to 512 MiB (was 256 MiB), the largest OneNote notebook Weaver can read. `WEAVER_ARTIFACT_MAX_FILE_BYTES` now defaults to and allows up to 536870912.
- OneNote sections whose content is not stored in the exported notebook, usually cloud sections OneNote had not downloaded before the export, are now reported as "section has no saved content; open it in OneNote and export the notebook again" instead of "section could not be parsed", and counted separately as empty sections. Existing notebooks are prepared again once.

### Fixed

- Importing a Markdown file that contains `weaver-image:` references (for example `read_onenote` output saved to a file) copies the images into the new document, as an assistant or MCP write does.
- Assistant proposals check their image references without reading the images; the bytes are copied once, when the proposal is accepted.
- Document files store `&` as a plain `&` instead of `&amp;`, so the raw Markdown reads naturally in other editors; only an `&` that would otherwise start an HTML entity (like `&copy;`) is still escaped. Titles follow the same rule. Existing documents change on their next save.
- OneNote notebooks keep far more of their images: pictures OneNote stores in a format browsers cannot show now use the displayable copy OneNote keeps beside them (in a test notebook 992 images instead of 89). Images that are not in the exported file at all are reported as such instead of as "unsupported format". Notebooks are prepared again once.
- Markdown written by the assistant or MCP clients with an image next to text or directly after another image no longer fails with "Invalid content for node paragraph"; the image becomes its own block.
- Creating a document or table in a folder that does not exist, or creating, moving or renaming a folder under a missing parent, now says which folder field names a missing folder and how to fix it, instead of the generic "not found or not accessible". The assistant and MCP tools are told to reuse existing folders and to create new ones only when asked.
- Deleting a OneNote notebook from Files now removes its prepared copy immediately, and replacing or renaming it removes the outdated copy, instead of leaving files behind until the next maintenance pass. Maintenance also removes the empty folders it used to leave.
- Turning off "Matryoshka / resizable" for an embedding model under Administration › AI now asks the provider for the model's native size and fills it in, instead of keeping the reduced size that the model does not return in native mode.
- Export as PDF works in production builds and the Docker images. The button was always disabled there ("PDF export is unavailable on this server") because the web image lacked a file the PDF renderer needs to start, and an export then failed with "PDF export failed" because the diagram library could not be read. The image build now checks both.
- An external MCP connection's detail page no longer reports a duplicate-key console error on load: the project grants form and the edit dialog were reset on the same key when navigating between connections.
- External MCP discovery failures show why they failed — the outbound policy blocking the endpoint, a refused or reset connection, an unreachable or unresolvable host, a timeout, or a rejected TLS certificate — instead of the generic "Failed (TRANSPORT_ERROR)". Failures that don't match a known network error still show that generic code.
- Far fewer external MCP tools show as "Schema unavailable: UNSUPPORTED_SCHEMA". Schemas may now use the `uuid`, `email` and `uri` formats, `pattern` and `patternProperties` regexes, `$ref` pointers to any part of the same schema (such as `#/properties/...`), and union types such as `"type": ["string", "number"]`. Regexes are checked with a linear-time engine, so a hostile pattern cannot stall Weaver; patterns that need backreferences or lookarounds are still unsupported. Run "Test and discover" on a connection to reclassify its tools.
- After "Test and discover", tool cards you have not edited show the newly discovered definition straight away instead of asking you to click "Review latest definition" on each one. Only a card with unsaved classification or enable changes keeps your draft and shows that prompt.

## [0.1.132] - 2026-09-26

### Added

- Administration › AI accepts any knowledge embedding size from 1 to 4,000 dimensions on the routed embedding model. Saving a new size re-embeds every project and keeps the existing knowledge graph, so no document is extracted again.
- Changing the routed embedding model's size, mode, provider model, or upstream provider asks for confirmation and first checks the model with one sample, refusing a size the model cannot return.

### Changed

- Switching to another embedding model keeps the knowledge graph and only re-embeds.
- Background work names these builds "Knowledge index re-embedding", and project settings show "Graph kept from the previous index" while one runs.

### Fixed

- The Routes table under Administration › AI lines up again: its columns share one header row, so the thinking-effort select no longer sits lower than the model select.

## [0.1.130] - 2026-09-26

### Added

- Knowledge index rebuilds you start, by pressing Rebuild or by changing the embedding model, appear in your bell tray and under Account › Background work › My work, with an unread marker when they finish.

### Changed

- Background work names knowledge rebuilds by their cause (embedding model changed, requested, Weaver upgrade) and shows ongoing document updates as "Knowledge index: updating N documents".
- Removing an embedding model's compatibility under Administration › AI now asks for confirmation when it would rebuild the knowledge index, and says how many projects are affected.

## [0.1.129] - 2026-09-26

### Added

- Administration › AI can verify an embedding model as compatible with another, for example the same model served by Ollama and by OpenRouter. After a successful check, switching between them keeps the existing knowledge vectors instead of reindexing.
- Switching a knowledge model under Administration › AI now asks for confirmation and says whether existing vectors are kept or how many projects will be reindexed.

## [0.1.128] - 2026-09-26

### Changed

- Switching the knowledge extraction model, or a Weaver release that changes the extraction prompt, no longer blocks document edits or rebuilds the knowledge index. New and edited documents use the current model; project settings show how many documents an older model extracted, and Rebuild re-extracts them all.
- Changing the knowledge embedding model starts reindexing right away instead of after up to 15 minutes, and Administration › AI reports how many projects are being reindexed.

### Fixed

- Documents waiting for a knowledge rebuild show as pending instead of failed.

## [0.1.127] - 2026-09-26

### Fixed

- Deployment: after a successful upgrade, `weaver-upgrade` removes older image sets from the host and keeps only the new release and the previous one for rollback. Before, every release left about 7 GB of images behind, and they filled the `apps` disk.

## [0.1.126] - 2026-09-25

### Added

- Administration › AI supports OpenRouter as a provider type with its API URL filled in. After entering an API key and choosing a model, an Admin can pin that model to an available upstream provider or leave routing automatic.

### Changed

- Thinking effort is configured separately for each AI route. The same model can now serve routes with different settings, including thinking off where the provider supports it. Existing routes keep their former model setting when upgraded.

## [0.1.125] - 2026-09-25

### Fixed

- The sidebar brand area now lines up with the page header and shares its background and divider in both expanded and collapsed views.

## [0.1.124] - 2026-09-25

### Changed

- Weaver uses a new design system: warm neutral surfaces, a blue accent (cyan in dark mode), Hanken Grotesk and JetBrains Mono, softer corners, and warm shadows. Text sizes and spacing stay as compact as before.
- A `>_` mark sits before "Weaver" at the top of the sidebar (and alone in the collapsed rail) and is the new favicon.

### Removed

- The account block at the bottom of the sidebar. The account menu in the top-right corner has the same entries.

## [0.1.123] - 2026-09-25

### Fixed

- Task list checkboxes sit beside their text in the editor instead of on a separate line above it.

## [0.1.122] - 2026-09-25

### Changed

- The document toolbar is compact and stays on one line: headings share a Text style menu, insert commands share an Insert menu, table editing moves into a Table options menu, and commands that do not fit move into a "More formatting options" menu instead of a horizontal scrollbar.

### Fixed

- Choosing a callout type now wraps the selected text (or the current block) in a callout instead of deleting the selection. Callouts show a colored Note, Tip, Important, Warning, or Caution label, the type of an existing callout can be changed, and "Remove callout" unwraps it.
- Callouts with several paragraphs or other blocks keep them separate when saved, including whitespace-only paragraphs.

## [0.1.121] - 2026-09-25

### Fixed

- Bulleted, numbered, and task lists no longer show a paragraph gap between items.
- Saved Markdown keeps arrows and comparison signs readable (`->`, `<-`, `a > b`) instead of writing `&gt;`/`&lt;`. A `>` that would start a quote is written as `\>`; `<` before a tag-like name and angle brackets in URLs stay encoded.

## [0.1.120] - 2026-09-22

### Fixed

- Moving unchanged documents or their folders now reuses completed embeddings and knowledge-graph results, updates source locations, and avoids repeated AI indexing. Changed content and incomplete indexes still receive normal processing.

## [0.1.119] - 2026-09-22

### Fixed

- Git sync now uses the merge base for diverged pulls, preserves conflicting content in fresh copies, and leaves the merged result for review before pushing. Repository locks, remote history, ignored files, SSH key cleanup, and destination checks are hardened.
- Documents recover missing projections after committed creates; history reads are bounded and validate identity. Images handle conditional requests and international filenames correctly.
- Knowledge jobs stop repeatedly deleting tombstones, release unrelated project writes, preserve compatible semantic search during rebuilds, recover transient routing and resolution races, and retire stale facts after terminal failures. Lexical candidate queries use indexed search vectors.
- Tables preserve text identifiers and encodings during CSV import, sort and filter typed values correctly, preserve positions during merges, and let users export a conflicting draft before reloading.
- Authentication retains sign-in rate limits without a trusted proxy, revokes credentials on deactivation/password changes, rejects unvalidated profile updates, and prevents API-key restrictions disappearing with deleted projects. Assistant runs and approvals revalidate the initiating session and account.
- Scheduled tasks enforce paused state and owner-only private details. Assistant accounting excludes unstarted calls, retains available failure usage, escapes external input framing, and clears stale retry proposals. Model token limits must be positive.
- Uploads reserve shared project capacity before writing and cap simultaneous uploads per user. OneNote caches respect quota; artifact HEAD requests no longer consume download slots; renames validate content types; OCR rejects oversized image dimensions before decoding. Upload and download failures return accurate HTTP statuses.
- Session expiry preserves open editor drafts and offers sign-in again. Pages enforce a nonce-based Content Security Policy with bounded reporting, recover through error boundaries, refresh project navigation after mutations, and protect API-key policy editing while project data is unavailable. Sensitive requests never enter the debug logger.
- Upgrades pull a pinned revision and verify it plus worker readiness before succeeding. Backups and reloads serialize, PostgreSQL survives application reloads, containers cache pnpm for offline startup, and connection pools leave database headroom. CI protects immutable image tags and executes the web lifecycle startup check.
- Worker schedules are removed only when their role is disabled deployment-wide; reconciliation has sufficient expiry time. Startup diagnostics capture secret failures, MCP shuts down its publisher, and database provisioning reconciles credentials without placing passwords in command arguments.

### Changed

- Internal Git SSH destinations now require an exact `WEAVER_GIT_ALLOWED_SSH_TARGETS` host:port exception. Set it for existing private Git servers before restarting; see `docs/setup.md`.

## [0.1.118] - 2026-09-22

### Changed

- Deployment: GitLab CI now builds the four Weaver images (`tools`, `web`, `worker`, `mcp`) and pushes them to the project's container registry on every push to `main` (`latest`, short sha and version tags) and on tags. A host pulls finished images instead of building from a checkout; `docker-compose.yml` names the registry images, `docker-compose.build.yml` keeps the local builds, and `deploy/examples/docker-compose.yml` is a generic single-host setup. The `apps` runbook gains `weaver-upgrade`, which fetches the deploy files for a ref and reloads the stack.

## [0.1.115] - 2026-09-22

### Changed

- Assistant and MCP: a saturated file reader now answers `TOO_MANY_REQUESTS` ("too many file reads are in progress; try again shortly") instead of a generic `INTERNAL` failure, so the caller knows to retry.
- File tools: `query_json_artifact` pages with a signed `nextCursor` (pass it back as `cursor`; `offset` only starts a fresh read) and fails `STALE_BASE` when the file was replaced between pages. `nextOffset` is still reported.
- Files: downloads now stream from disk instead of loading the whole file into server memory, answer unchanged-file (304) requests without reading the file, and are limited to four simultaneous downloads per user (a fifth gets 429 with a retry hint).

### Fixed

- Assistant and MCP: tool results are capped at 16,000 UTF-8 bytes instead of characters, so a page of Chinese, Japanese or Korean file content no longer fails a run with "Assistant context limit reached by tool results" on windows around 100,000 tokens. The documented minimum context window is now about 67,000 tokens.
- File tools: `get_artifact_overview` clamps chapter titles, table captions, sheet names and JSON keys to 200 bytes (flagged `titleTruncated`, `captionTruncated`, `nameTruncated`, `keyTruncated`), so one very long heading no longer hides every entry after it.
- Documents: table cells containing `|` or several paragraphs no longer corrupt the document on save, and hard breaks inside cells round-trip. Several paragraphs in one cell are saved as one paragraph with line breaks.
- Documents: paragraph text that starts like a heading, list item or horizontal rule (`# `, `- `, `1. `, `---`) stays text on save instead of turning into that block. Leading indentation of four or more spaces is reduced to three.
- Documents: pasting a table with merged cells no longer leaves an unsavable draft. Cells are split on paste, and a failed save now states the reason.
- Documents: callout markers written in lowercase (`> [!note]`) are recognised and normalised.
- Documents and Tables: dropping a search result on "Move up one level" moves it up from its own folder, not from the folder being viewed.
- Tables: a cell edit in progress survives a window-focus refresh.
- Documents: opening a document through a `?version=` link to its current version no longer switches to the diff view after the next save.
- Git sync: pulling a remote that holds a document or table with the same slug as a local-only one in another folder keeps both; the local one is re-slugged.
- File tools: `read_word_chapter` and `read_word_table` now page large chapters and tables reliably. The reader returns one window per call instead of the whole chapter or table, so content that used to fail with "too large or complex to read" is readable page by page.
- File tools: `get_artifact_overview` on a Word or JSON file with tens of thousands of headings, tables or keys no longer fails; the lists are capped at 5,000 entries and flagged as truncated.
- File tools: `query_json_artifact` no longer returns an empty page without continuation when a single match is larger than 128 KiB; the match comes back clamped and the next offset advances.
- File readers: a file that exhausts the reader's memory is reported as "too large" to the caller, and as a warning in diagnostics, instead of as a server error.
- OneNote: reading a prepared notebook no longer waits behind uploads, renames or deletes in the same project.
- OneNote: after a failed preparation, a rebuild is refused for 10 minutes and the response says when a retry is allowed; a missing or damaged cache can still be rebuilt immediately.
- OneNote: notebook read caches now count against the project's storage quota.
- OneNote: housekeeping no longer stops at the first notebook that fails to re-dispatch; the remaining notebooks and the snapshot sweep still run.
- MCP: `read_onenote` is no longer advertised as read-only, since it can enqueue preparation.
- Memory monitor (macOS): a child process that has already exited is no longer mistaken for one that ran out of memory.
- Files: replacing a file that was deleted at the same moment now reports a conflict to retry instead of a server error, and file operations serialize correctly regardless of the letter case of the project id in the URL.
- Files: names using full-width dots or slashes (for example `．hidden` or `a＼b.pdf`) are rejected like their ASCII forms.
- Files: typing or pasting a search term longer than 200 characters no longer blanks the list.
- Files: screen readers now hear upload progress at 25 % milestones and when the files have been sent.
- MCP: an unrecognised bearer credential no longer gets its own pre-authentication rate-limit bucket. A distributed flood of distinct fake tokens could fill the limiter's key capacity and reject a legitimate API key's first request with 429. Unverified credentials are now bounded by the source-address bucket only; header-less requests keep their per-address bucket.
- Assistant and MCP: `propose_content_lifecycle` now refuses at proposal time when a folder the change requires does not exist (moving an item into a missing folder, creating a folder under a missing parent, moving/renaming/deleting a missing folder, moving a folder into a missing parent), naming the field, instead of producing a proposal that fails only at acceptance.
- Knowledge index: a job cancelled while an extraction correction or an embedding call was completing now records that call's token usage as `stale_discarded` instead of dropping it from AI usage.

## [0.1.114] - 2026-09-21

### Changed

- Documents and Tables: while a document or table is dragged inside a folder, the Up button turns into a highlighted "Move up one level" drop target. Dropping the item there moves it to the parent folder. The button already accepted drops but gave no hint.

## [0.1.113] - 2026-09-21

### Fixed

- Documents and Tables: files can be dropped anywhere on the page to import them. The drop zone previously ended below the last listed item, so drops on the empty lower part of the page were ignored.

## [0.1.112] - 2026-09-21

### Fixed

- Assistant and MCP: missing or damaged OneNote caches now provide explicit `read_onenote` instructions to rebuild with `retry: true`, including when an individual cached page disappears. Queued/running preparation asks the agent to wait; failed rebuilding asks it to report the failure instead of retrying repeatedly.

## [0.1.111] - 2026-09-21

### Added

- Assistant and MCP: read uploaded OneNote `.onepkg` archives and `.one` sections with `read_onenote`. List sections and pages, search text, and read individual pages with table text and image/attachment descriptions. Large notebooks prepare in the background and reuse a read cache. Extraction warnings identify unsupported or unrecovered content; existing document tools can turn the results into Weaver documents. No import workflow is required.

### Changed

- Files: the default upload/read limit is now 256 MiB, configured independently of Imports, so larger notebook archives can be stored.

## [0.1.110] - 2026-09-21

### Fixed

- Assistant: a proposed new document or table that named a folder which does not exist could be created but never approved — approving it failed with "folder does not exist". The assistant is now told at once that the folder is missing, and can pick an existing folder, use the project root, or propose creating the folder first. A pending proposal from before this fix still has to be rejected.

## [0.1.109] - 2026-09-21

### Added

- Assistant and MCP: the assistant and connected MCP clients can now find project files and read inside Word, Excel, PDF and JSON files (outline, chapters, tables, sheets, pages, JSON queries). Files are read-only for the assistant; scanned PDFs without text and legacy .doc/.xls files are not supported.

### Changed

- The assistant's tool definitions grew: the model routed to the assistant now needs a declared context window of about 67,000 tokens for a run to start at all (amended 2026-09-22: the earlier "65,000" fits only an empty message), and roughly 100,000 or more to actually read files — each tool result may take up to 16,000 bytes of the budget, and the file tools are built to fill that page. Below the first number every run fails at submission ("Assistant context limit reached"); between the two, a run starts but one file page can exhaust it ("Assistant context limit reached by tool results"). The context window is declared per model under Administration › LLM connections.

## [0.1.108] - 2026-09-20

### Changed

- Internal: file readers for Word, Excel, PDF and JSON (`@weaver/artifact-readers`) in preparation for assistant access to project files. No visible change.

## [0.1.107] - 2026-09-20

### Added

- Files: every project has a Files page for original files of any type. Editors upload several files at once by drag-and-drop (up to 20 per upload, 50 MB each by default), rename and delete them; every member can download. Uploading a name that already exists asks before replacing it — there is no version history, and a deleted file cannot be restored. Files share the project's upload storage quota with Imports.

## [0.1.106] - 2026-09-19

### Changed

- Knowledge index: when the extraction model returns a response that fails validation (a misspelled or extra property, broken JSON, a relation that ends before it starts), Weaver now shows the model the exact validation issues once and uses its corrected answer, instead of failing the document's graph layer until someone retries it. A response that is still invalid after the correction fails as before, with both rejections in the diagnostic details. A successful correction is logged as a `knowledge.extraction.corrected` warning, and both provider calls are counted in AI usage.

## [0.1.105] - 2026-09-19

Fixes for all 41 findings of the 2026-09-19 full application review.

### Added

- Documents: a document link with `?version=<commit>` opens the document compared against that saved version.

### Changed

- Deployment: the nightly backup now stops web, both workers and the MCP server (PostgreSQL stays up) while it dumps the database and archives the data folder, then restarts exactly the services that were running, also when it fails partway. Expect a short outage around 02:40 and during the pre-upgrade backup. Every Git repository is checked with `git fsck`, any `tar` error aborts the run, and the archive is listed before it is published; a repository that fails the check still gets backed up but fails the unit and keeps older backups from being pruned. Install the updated `weaver-backup` script and unit on the host.

### Fixed

- Knowledge search: an entity whose description changes because a supporting document was deleted or edited no longer drops out of semantic entity search until the next rebuild. Its embedding is rebuilt from the stored entity, without re-running extraction, right after the change or on the next reconciliation.
- Scheduled tasks: the commit links in a task's run history now open the report as that run wrote it, in the project it was written to. They previously opened today's report, and stopped working after the task's output project was changed. Runs recorded in a project you can no longer open show the commit without a link.
- Assistant and MCP: text pages from `read_document`, `navigate_document` and `read_table_cell` are sized by their serialized length, so pages dense in quotes, backslashes or line breaks keep their structured result and continuation cursor instead of collapsing into a truncated blob.
- Assistant and MCP: `navigate_document` section and find results now carry citations, so answers based on navigation get citation cards and MCP calls return a resource link.
- AI usage: provider calls that had already completed when a knowledge job was cancelled or ran out of time are now recorded (as discarded work) instead of being dropped from usage accounting.
- Imports: accepting a draft now only commits the version you reviewed. If someone else saved different choices (for example another column type) after you opened the review, saving or accepting reports the conflict and reloads the draft instead of silently accepting their version.
- Imports: a table draft is measured at the size it will occupy once accepted, using the current column types. Tables that could never be accepted (for example 100 columns × 1,000 rows) are rejected at upload with a message stating the stored size against the 5 MB limit, instead of reaching Ready and then failing on Accept.
- Imports: CSV rows with more cells than the header no longer lose the extra values silently. They are kept in generated `Column N` columns, as Excel imports already did, and the draft carries one note saying how many rows were affected and where the first one is.
- Sign out now asks before discarding an unsaved document or table draft, and a confirmed sign-out no longer raises a second browser "leave page" prompt.
- Documents: the Rename dialog keeps a typed title when the document is refreshed in the background or a refresh fails, and saves against the latest version. Project Settings no longer replaces its forms with "Project not found" on a temporary refresh error.
- Account › API keys: a key restricted to a project you can no longer access shows that restriction as a removable "Unavailable project", so the key can be edited and saved again. Removing the last restriction states that the key will then reach all your projects.
- Folders: renaming a folder through the assistant or MCP now updates the folder's display name and commits capitalization-only renames; before, the name shown in the explorer never changed. Renaming a folder to its identical name is a no-op instead of an error.
- Documents: moving a document into a folder that already holds a stray `<name>.assets` directory now gives the document a free name instead of nesting its images inside that directory and breaking them.
- Git remotes: pulling no longer renames a colliding local document or table onto a name already used in another folder, which made the index rebuild drop one of the two items.
- Git remotes: large files in a pulled branch are skipped without being loaded into memory, and the Git read now has a timeout.
- Imports: automatic clean-up of old import batches can no longer delete a failed file that is being retried at the same moment.
- Scheduled tasks: a document or table larger than the remaining context budget is now included in shortened form instead of being dropped, which produced reports written over "No content in scope". Content shortened at its source (long documents, table samples, diffs) is now reported as truncated on the run.
- Scheduled tasks: the 20-per-owner and 50-per-project limits are now enforced atomically, so concurrent task creation can no longer exceed them, and an owner who is already at the limit can move a task to another output project.
- Project › Activity: scheduled reports are filtered by project before the five-item limit, so newer reports in other projects no longer hide a project's own reports behind "No scheduled reports yet."
- Graph: Expand now adds the selected entity's unseen neighbours. It previously requested only the remaining canvas capacity, which the server answered with already-visible neighbours, so nothing appeared.
- Workers and the MCP server no longer report a clean exit after a failed shutdown: when draining, closing the health endpoint or disconnecting the database fails, the process logs a sanitised `shutdown-failure` and exits 1 while the remaining cleanup still runs.
- Documents: saving no longer corrupts valid content. Code blocks and inline code containing backticks, inline code mixed with bold, italic or link formatting, image alt text, titles and paths, and link URLs and titles with brackets, quotes, spaces or parentheses now survive the Markdown round trip. Merged table cells, which Markdown tables cannot represent, are rejected on save, and the Merge cells and Split cell actions were removed.
- Tables: changing a column's type when no cell value changes (for example an empty column) now marks the table as unsaved; before, Save stayed disabled and the change could be lost on navigation.
- Tables: editing a date & time cell to a date in the other daylight-saving season now stores the time you entered; before, it kept the old cell's UTC offset and the value showed an hour off.
- Tables: comparing a version in history now reports changed column or row order instead of saying the version matches the current table.
- Administration › Diagnostics: when an event's details or body cannot be loaded, the dialog now says so and offers Retry or Back to event details instead of showing a loading placeholder forever.
- Imports: OCR now keeps its 8,192 output-token cap when the routed model has no configured output limit, instead of falling back to the provider's default.

### Security

- Documents, tables, folders and images: content writes can no longer follow a symbolic link out of the project repository. Pulling a remote branch that contains symbolic links or submodules is now refused with a clear error in Project Settings instead of checking them out.
- Document images: pinned image URLs (`?at=<commit>`) are no longer cached as immutable for a year. Every image response is now revalidated after the access check, so a removed member or another account in the same browser can no longer load them from cache.
- MCP server: requests with an unrecognised credential are now rate limited per source address before the body is read or the credential is checked. Rotating invalid Authorization values no longer bypasses the anonymous limit or crowds out new legitimate clients.
- External MCP connections no longer send a kept bearer token to a different endpoint origin. Changing the origin of a bearer connection now requires re-entering the token (or switching authentication to None); same-origin path and query edits keep it, and the connection dialog reports this on the token field before saving.
- External MCP tools whose JSON Schemas would be unboundedly expensive to validate are now listed as unavailable instead of being able to stall the web or worker process: reference fan-out above 20,000 expanded nodes, same-instance reference cycles, definitions that recurse into their cycle more than once, references outside `#`, `#/$defs` and `#/definitions`, and `uniqueItems` on non-scalar items. A previously available tool using one of these constructs becomes unavailable. Compiled validators are cached, so tool calls no longer recompile the schema.
- Accounts: a password change that was still in progress can no longer undo an administrator's password reset. Resets and changes for the same user now run one after the other, and the unused public `/api/auth/change-password` endpoint is closed; changing your password in Account settings works as before.
- Accounts: one password policy of 12 to 128 characters now applies everywhere, including the authentication provider itself, which previously accepted 8-character passwords on its own endpoint and rejected the 129 to 200 characters the forms allowed.
- API keys: revoking or editing a key while one of its requests is being authenticated can no longer give that request access to projects outside the key's restriction; the key's permissions and project restriction are now read together, and a key that has just been revoked is rejected.

## [0.1.104] - 2026-09-19

### Added

- Documents and tables: folders now have a display name. The folder is still stored under its slug (for example `implementation-plans`), while "Implementation Plans" is kept in a `.folder.json` file inside the folder and shown in the explorer, the page title, breadcrumbs and folder pickers. Renaming a folder updates the display name and only moves the folder when its slug changes.
- Documents and tables: drag a document or table onto a folder, or onto the Up button, to move it there.

### Changed

- Creating a folder keeps you on the current level instead of opening the new folder, so you can drag items into it first.

## [0.1.103] - 2026-09-19

### Added

- Administration › LLM: chat models have a Reasoning setting (Provider default, Off, Low, Medium, High). It is sent as the reasoning effort with every call to that model, including knowledge extraction, document summaries, the assistant, tasks and import analysis, so a thinking model can be turned off where speed matters. Also available on the `create_llm_model`/`update_llm_model` MCP tools as `reasoningMode`.

## [0.1.102] - 2026-09-19

### Added

- Account › API keys: an Edit action per key changes its name, capabilities, project restriction and rate limit in place; the key and its expiry stay the same and changes apply to the next request.

## [0.1.101] - 2026-09-19

### Fixed

- Knowledge index: a document whose embeddings succeeded but whose graph extraction failed no longer degrades the project's Semantic readiness; each layer now reports only its own failures, matching the per-document index lights.
- Knowledge index: when an AI provider returns an extraction the schema rejects, the failure summary and the `knowledge.document.failed` diagnostic now say which fields were rejected (stage, issue paths and codes, entity/relation counts, finish reason) instead of only "AI provider returned invalid extraction".

## [0.1.100] - 2026-09-19

### Added

- Tables: new column types — date & time (stored with its time zone, shown in your local time), multi-select, URL (clickable), and long text (multi-line with a markdown preview). Filters, sorting, aggregates, the assistant tools and CSV import understand them.

## [0.1.99] - 2026-09-18

### Added

- Tables: drop .csv or .tsv files onto the tables explorer to create tables; column types are inferred (number, date, yes/no), everything else is text.

### Changed

- Tables now use the same explorer as Documents: folders as rows or tiles, list and icon views, search and sort, no folder sidebar. The table editor keeps its context rail.

## [0.1.98] - 2026-09-18

### Added

- Project › Settings › Git remote: "Pull existing content" merges the remote branch into the project, keeping every local document and table (colliding names get a numbered suffix), rebuilds the indexes and pushes the merged history.

### Changed

- Enabling automatic pushes, uploading a key, or saving content now pushes within seconds instead of waiting for the minute check.

## [0.1.97] - 2026-09-18

### Added

- Failed assistant answers keep their error details after a reload, and the conversation list marks conversations whose last run failed.
- Background work shows the stored error text for failed tasks, imports, assistant runs and knowledge builds.
- Administration › Diagnostics has a Retention card: finished import batches (30 days), idle assistant conversations (90 days, 0 keeps them), task runs (30 days) and AI usage (90 days) are pruned on the reconcile pass. Admin MCP tools `get_retention_settings` / `set_retention_settings`.

### Changed

- On upgrade, the first reconcile pass deletes assistant conversations idle for more than 90 days and finished import batches older than 30 days. Adjust the Retention card in Administration › Diagnostics first to keep them; `0` keeps conversations forever.

## [0.1.96] - 2026-09-18

### Added

- Every document in the Documents explorer shows three lights for keyword, semantic and graph indexing, with the failure reason in a tooltip.
- Drop `.md` files onto the Documents explorer to import them into the current folder.

## [0.1.95] - 2026-09-18

### Added

- Every user has a personal workspace project, created automatically; it cannot be deleted.
- Project › Activity collects active work, latest activity, pinned content and scheduled report shortcuts.

### Changed

- Documents is the first project section. The Home page and the project Overview are gone; `/`, `/home` and the project root open the last opened project's Documents.
- The sidebar keeps the open project's sections on Administration, Account and Assistant pages.
- New projects are created from the header project switcher.

### Fixed

- Changing your own password keeps you signed in: the rotated session cookie now reaches the browser.

## [0.1.94] - 2026-09-17

### Added

- The sidebar footer shows the running build: version, local build timestamp,
  and the deployed commit in its tooltip. Every deployment stamps a fresh build
  time.

## [0.1.93] - 2026-09-17

### Added

- Diagnostics now shows durable processing states for knowledge, imports, assistant
  runs and scheduled tasks, alongside queue deliveries and correlated events.
- Processing history cleanup retains usage for 90 days, terminal task runs and
  assistant attempts for 30 days, and queue history and terminal assistant events
  for 7 days. It preserves active work, task baselines, and user content.
- Diagnostics record how each document was embedded (requests, characters,
  duration) and warn when search falls back to keyword results.
- Added a deployment runbook, systemd units, and daily database and Git data backups
  under `deploy/`.
- `/api/health` now also reports the build time and deployed commit.
- Administration › Diagnostics shows document change summaries: status counts,
  filters, failure reasons, attempts, error classes, and links to the related
  events. The MCP tool `list_document_change_summaries` exposes the same
  metadata.

### Changed

- Standard diagnostics capture processing lifecycle events by default. Existing
  Errors-only settings move to Standard; explicit Off and Verbose choices remain.
- Cleanup runs independently of logging level and worker roles, with bounded
  batches and visible errors for individual housekeeping operations.
- Knowledge embeddings adapt their request size to the measured speed of the
  embedding model, so slow local models (such as Ollama on CPU) index documents
  without timing out while fast providers keep batching.
- LLM connections accept request timeouts of up to two minutes.
- Search waits at most five seconds for semantic matching and otherwise shows
  keyword results, instead of hanging while documents are being indexed.
- A document whose AI enrichment runs longer than 23 hours now fails with
  "AI enrichment exceeded its time budget" and is retried, instead of running
  past its job lease.
- Sign-in cookies are now named `weaver.*` and limited to the app's base path,
  so other applications on the same hostname never receive or overwrite them.
  Everyone needs to sign in again once after this update.
- Docker Compose reads its hostname, base path (now `/weaver` by default),
  Traefik network and certificate resolver from the deployment's `web.env`,
  pins the pgvector image, and routes only Weaver's own OAuth discovery paths.
- Document history checks for a pending summary every 5 seconds for 2 minutes,
  then every 30 seconds, and stops after 15 minutes.
- Failed and skipped change summary records are removed 30 days after they
  finish; generated summaries stay in document history.

### Fixed

- Indexing recovers interrupted work promptly and prevents superseded workers
  from publishing. Configuration loss ends blocked shadow generations safely.
- Entity resolution handles ambiguous aliases and updates descriptions from live
  source evidence. Unchanged chunks retain embeddings, and heading-only content
  remains searchable. Transient Git errors remain retryable.
- Truncated task reports and OCR output are rejected. A usage-storage outage no
  longer discards successful ingestion results or repeats the provider call.
- LLM probes support OpenAI reasoning models, embedding usage is priced correctly,
  discovery deadlines produce controlled failures, model edits serialize, and
  keyless local endpoints can be changed from the connection dialog.
- Assistant runs no longer fail immediately with DeepSeek's native API
  ("Invalid schema for function 'resolve_citation'"). Every assistant tool now
  describes its input as a plain object.
- Markdown imports containing bold, italic, struck-through, or linked inline
  code now pass document validation while preserving their formatting.
- Change summaries now work for saves that rename and heavily rewrite a document
  at once, and a failed usage write is logged instead of silently dropped.

## [0.1.86] - 2026-09-16

### Changed

- Saving a document no longer waits for the AI change comment. The save commits
  immediately; the summary is generated in the background with retries and
  appears in document history. History shows "Summarizing…" while a summary is
  pending and "Summary unavailable" if generation fails.

### Fixed

- Diagnostic events raised by the web app (tRPC errors and mutations, provider
  requests, enqueue failures) are now stored. Previously only web runtime
  start/stop events were recorded.
- Change comment generation errors, timeouts, and retries are now recorded as
  diagnostic events and AI usage instead of silently falling back.

## [0.1.85] - 2026-09-14

### Changed

- Routine Git sync, task tick, and assistant reconciliation start/completion
  events now use debug severity. Diagnostics defaults to Info and above, with
  Debug and All severities available explicitly. Existing informational check
  events are reclassified; warnings and failures remain visible.

## [0.1.84] - 2026-09-14

### Changed

- The document toolbar now switches directly between WYSIWYG and editable raw
  Markdown. Removed the source box, explanatory text, and extra buttons. Both
  modes share drafts, Save, Discard, and conflict protection; Viewers stay
  read-only. Raw input remains intact across mode switches and validates before
  saving or returning to WYSIWYG.

## [0.1.83] - 2026-09-14

### Changed

- Markdown source now appears directly in the document page. Switch back with
  the toolbar, the formatted-view button, or Ctrl/Cmd+Alt+S. Copy, Save, Discard,
  and Context remain available, and returning preserves the document position.

## [0.1.82] - 2026-09-14

### Changed

- The document toolbar stays in the page header, aligned left beside Context.
  Tools scroll horizontally on narrow screens and remain available while reading
  down the document. Removed Show/Hide toolbar and its keyboard shortcut; Source
  and Ctrl/Cmd+Alt+S remain available.

## [0.1.81] - 2026-09-14

### Changed

- Documents again show the full formatting and insertion toolbar. Hide/Show
  toolbar or Ctrl/Cmd+Alt+E toggles it while direct editing and Save/Discard remain
  available. Toolbar controls wrap and scroll on phones.

### Added

- Source opens read-only Markdown for the current document body, including unsaved
  edits, with a copy button. Use the toolbar or Ctrl/Cmd+Alt+S; Viewers also have
  source access. Opening and closing source preserves the draft and editor selection.

## [0.1.80] - 2026-09-14

### Added

- Administration › AI offers an optional Document change summaries route. It
  generates a short history comment from changed excerpts; unavailable or slow
  models silently fall back to a standard comment after at most two seconds.

### Changed

- Documents open directly for editing on desktop and phone for Editor+ members.
  Select text to format it, open block actions at the cursor, and open Mermaid
  source only when needed. Save appears when changes exist and saves directly;
  Discard restores the saved version after confirmation. Viewer members retain
  read-only documents, references, history, and graph navigation.

## [0.1.79] - 2026-09-14

### Fixed

- Verbose assistant diagnostic bodies require current access to every project
  contributing to the prompt, including earlier conversation scopes. Unknown
  provenance suppresses body capture; legacy run bodies cannot be disclosed.
- Creating a project from the header asks before leaving an editor with unsaved
  document or table changes. Declining keeps the editor and the newly created project.
- Spreadsheet import preserves numbers that would otherwise lose precision as
  text, and rejects explicit number conversion when it would change the value.
- Deleted-content history resumes within a commit so pagination includes every
  deleted document and table, including when several share one deletion commit.
- Import recovery waits for the ingestion queue leases independently of temporary
  upload cleanup, so a short cleanup TTL cannot revoke healthy OCR work.
- CSV and Excel header normalization keeps generated column names unique and
  within the length limit, including suffix and truncation collisions.

## [0.1.78] - 2026-09-13

### Added

- Every server-side failure is now stored in the diagnostic log with a bounded,
  redacted error summary, at the new default level `errors`, for the configured
  retention period. Failed assistant runs, scheduled task runs, knowledge
  indexing, imports, and internal request errors show the cause in plain
  language and end with a short reference such as `(ref a3f9c2e1)`.
- Administration › Diagnostics gained an event browser with filters, paging,
  a detail view with bodies, and `?ref=` deep links; admins see run failure
  references as links. The MCP admin tools look events up by reference.

### Changed

- Signing in (or opening `/`) now lands on the Documents view of the project you
  last opened; Home moved to `/home`.
- Projects are chosen from a switcher in the header where the project name used
  to be; the sidebar lists only the current project's sections.
- Documents browse like a file explorer: folders and documents of the current
  folder as a list or as icons, single click to open, Up/Backspace to go up,
  arrow keys and Enter, right-click item menus, and a search that looks below
  the current folder. The collapsible document tree is gone; the breadcrumb
  path shows the folder trail, and each folder crumb opens a menu of its
  contents.

### Fixed

- `/home` is covered by the request-path proxy again, so the forced password
  change still applies there and signing in from `/home` returns to it.
- Switching projects from the header asks before discarding unsaved document or
  table edits, like every other navigation.
- The project switcher's filter box receives focus when the menu opens, and
  Arrow Down/Up move from it into the filtered list.
- Right-clicking inside a document's rename, move, or delete dialog no longer
  reopens the row's actions menu or suppresses the browser's own menu.
- A provider endpoint refused by the outbound policy (for example a private
  host missing from `WEAVER_OUTBOUND_ALLOWED_ORIGINS`) is now reported as
  "endpoint not allowed by the outbound policy" instead of "assistant run
  failed".
- Multi-line commit messages keep their line breaks again; the control-character
  filter introduced on 2026-09-11 had folded the body into the subject line, so
  history showed the whole message as one title.
- An external tool approval that appeared moments before its run ended no
  longer vanishes from the conversation; the settled view refetches the run's
  approvals, so an invalidated or expired card stays visible without a reload.

## [0.1.75] - 2026-09-12

### Fixed

- A minimum or maximum over a table's date column no longer depends on the
  server's timezone: a date written without a zone suffix is read as UTC, so
  the same question cites the same value on every host.
- A very long group key in a table aggregate is now returned cut to 2,000
  characters and flagged as such, rather than in full. Grouping, ordering and
  every total still use the whole cell, so two long keys that begin alike stay
  separate groups with separate answers.

## [0.1.74] - 2026-09-12

### Added

- The assistant and MCP clients can compute table aggregates without reading
  every row: counts, non-empty counts, sums, averages, minima, maxima and
  distinct counts over all rows matching a typed filter, at one pinned
  revision, optionally grouped by up to two columns (`aggregate_table`). Totals
  always cover the whole matching set — only the list of groups is paged — and
  each result reports how many rows contributed, so an empty result is never
  mistaken for a zero. Every answer cites the table at the revision it was
  computed from and records the query that produced it.

## [0.1.73] - 2026-09-12

### Added

- The assistant and MCP clients can organize a project: create, rename, move
  and delete empty folders, move a document or table between folders, and
  delete one (`list_content_folders`, `propose_content_lifecycle` /
  `apply_content_lifecycle`). Folder deletion is never recursive, roots cannot
  be changed, and every action is refused if the revision it was planned
  against has moved. An organization change proposed by the assistant always
  awaits review, even with auto-approve enabled; its approval card names the
  source, the destination and how much rides along, and says so when a folder
  that is not empty will be refused.

### Fixed

- A deleted document or table whose folder was deleted as well can now be
  recovered; the folder comes back in the same commit instead of the recovery
  being refused.
- Retrying a delete, move or folder change whose commit succeeded but whose
  acknowledgement was lost now returns the original result instead of
  reporting the target missing, colliding with itself, or naming the path the
  moved item left behind.

## [0.1.72] - 2026-09-12

### Added

- The assistant and MCP clients can read a document's or table's version
  history, compare two revisions, list deleted documents and tables, and
  restore either an earlier version or a deleted item with its original
  identity (`content_history`, `propose_content_restore` / `restore_content`).
  Deleted items are found from committed history, so items removed through the
  web UI are recoverable too.

### Changed

- A restore proposed by the assistant always awaits review, even in a
  conversation with auto-approve enabled, because it replaces live content
  from a historical revision.

### Fixed

- Recovering a deleted document or table now replays its own earlier commit
  when the acknowledgement was lost, instead of refusing a recovery that
  succeeded or committing the same identity into a second file.
- A recovery is refused when the identity is already committed but its
  database row went missing, and the row is repaired, instead of the item
  staying listed as recoverable and being recovered again.
- Recovering a document whose image cannot be read from the source revision
  now fails naming the image instead of committing a document whose picture
  link points at a file that was never written.
- `content_history` in `mode=deleted` no longer drops items that did not fit
  the page: the cursor it returns resumes at the first item it left out.
- A table restore proposal links to the table and refreshes the open table
  page; it used to link to a document route that does not exist.

## [0.1.71] - 2026-09-11

### Fixed

- A `table.change` proposal now shows the same generated column, select-option
  and row ids that acceptance commits, instead of minting new ones on approval.
- A `document.patch` whose result would exceed the 200,000-character document
  limit is refused at proposal and write time with `PAYLOAD_TOO_LARGE` instead
  of committing a document too large to diff against its own history.
- A table change whose final column shape is invalid (a select column without
  options, options left on a non-select column, too many columns) is now
  refused while previewing rather than failing with a raw error on acceptance.
- A `document.patch` and a `table.change` that would change nothing are
  refused instead of producing an empty-diff proposal or a no-op commit.
- A title-only document patch now shows the rename on its approval card, and a
  patch preview shows the canonical text the commit stores.
- The approval card labels `document.patch` and `table.change` proposals
  instead of showing the raw operation kind.
- Replaying a `patch_document` MCP write whose acknowledgement was lost now
  returns the document id instead of a null `resourceId`.

## [0.1.70] - 2026-09-11

### Added

- The assistant and MCP clients can change a document by exact text or by
  section (`propose_document_patch` / `patch_document`) instead of resubmitting
  the whole body, and navigate one with `navigate_document` (outline, section,
  literal search) at a pinned revision.
- A table's title, columns, select options and rows can change together in one
  revision (`propose_table_change` / `change_table`), including a column type
  change with its cell conversions.

### Changed

- The assistant no longer offers `propose_table_schema_change` and
  `propose_table_rows`; `propose_table_change` replaces both, and the two
  retired tool definitions are deleted entirely rather than merely hidden.
  MCP clients keep `update_table_schema` and `update_table_rows` unchanged,
  and the persisted `table.schema` / `table.rows` operation variants remain
  parseable, so proposals pending from before the retirement stay valid and
  acceptable.
- Six content tools that previously showed a raw tool name in the assistant
  activity feed (`navigate_document`, `list_table_columns`,
  `list_table_column_options`, `read_table_cell`, `propose_document_patch`,
  `propose_table_change`) now show readable labels.

## [0.1.69] - 2026-09-11

### Added

- Documents accept image uploads by paste, drop, or the toolbar file picker.
  Images are committed into the project repository next to the document as
  `<slug>.assets/<file>` and referenced with plain relative Markdown links, so
  clones render them in any Markdown editor. Renaming, moving, deleting, and
  restoring a document carry its images along. New setting
  `WEAVER_DOCUMENT_IMAGE_MAX_BYTES` (default 10 MiB).

## [0.1.68] - 2026-09-11

### Fixed

- Knowledge rebuilds finish after terminal indexing/provider failures, bound
  retries, prune obsolete index data and keep semantic search independent of
  graph extraction failures.
- Hardened authentication, admin membership updates, tRPC request limits,
  OAuth consent display, live event sessions, and production configuration.
- Git history resists control-character spoofing; document/table restore and
  table deletion reject stale heads, and content validation rejects malformed
  titles, references and oversized/deep trees before expensive parsing.
- Assistant failures retain consumed token usage. Automatic edits are confined
  to the pinned/single project, proposal previews require current access, and
  scheduled tasks recover safely from worker loss and lost project access.
- Upload requests and storage are bounded, native parsers run with resource
  limits, abandoned upload heartbeats stop, and active imports resist deletion.
- Outbound LLM, Docling and MCP requests validate and pin DNS addresses;
  private services require an explicit trusted-origin setting. Changing an LLM
  destination requires a replacement credential.
- Document backlinks load in bounded pages; assistant models require a known
  context window, and task details respect owner and Viewer permissions.
- Added worker readiness checks, missing database indexes and shared upload
  counters; PostgreSQL connections consistently use UTC. Container dependency
  layers include the external MCP workspace package.

## [0.1.67] - 2026-09-10

### Added

- Assistant and MCP content reads are pinned to one project snapshot and report
  `snapshotCommitSha` and `baseCommitSha`; `atCommitSha` reads earlier snapshots
  and signed `nextCursor` values continue at the same snapshot.
- New read tools `list_table_columns`, `list_table_column_options`, and
  `read_table_cell` retrieve wide schemas, long option lists, and long cell
  text completely.
- MCP document and table resources accept `/revisions/{commitSha}` and expose
  revision metadata.

### Changed

- `get_table` reports `optionCount` per select column instead of full option
  lists, and row pages list strings over 2,000 characters under `oversizedCells`.
- `query_table_rows` rejects bare row-id cursors with `INVALID_CURSOR` instead
  of restarting from the first row.
- Tool errors may carry a structured `reason` (`INVALID_CURSOR`,
  `SNAPSHOT_UNAVAILABLE`) alongside the code.
- The live MCP document and table resources (`weaver://projects/{p}/documents/{d}`,
  `weaver://projects/{p}/tables/{t}`) now read the same pinned, read-only Git
  snapshot as the revision-addressable resources instead of the
  self-repairing projection read; a project whose projection has drifted from
  Git now answers with a resource-not-found error instead of triggering a
  repair and serving the recovered content.

### Fixed

- When an LLM route has no recorded context window, the assistant now assumes
  128k tokens instead of 32k, so the full registered tool surface fits the
  prompt budget instead of failing every run.

## [0.1.66] - 2026-09-09

### Fixed

- Project Settings uses a distinct Git remote card key, removing the duplicate
  React key warning while preserving state resets when switching projects.

## [0.1.65] - 2026-09-09

### Added

- Project Owners can configure one SSH Git remote and branch in Project Settings,
  upload or replace an encrypted private key, inspect its name and fingerprint,
  and delete it without any private-key download endpoint.
- Automatic pushes send committed project content and history, with visible
  status, manual retry, first-use SSH host pinning and durable retries after
  1, 5, 15, then 60 minutes. Deleting a key pauses future pushes; remote history
  is never overwritten with a force push.

## [0.1.64] - 2026-09-09

### Added

- A per-conversation Auto-approve checkbox applies new document and table changes,
  including while the assistant dialog is closed. It defaults off and preserves
  external MCP approval rules. Applied changes remain visible if a run stops;
  automatic retries cannot repeat those writes.

- Collapse the document navigation sidebar to give its width to the document;
  reopen it from the Documents bar with the previous width and tree state intact.
  The browser remembers whether navigation is collapsed.

- Resize the document navigation sidebar by dragging its right edge or using
  arrow keys. The browser remembers the width; double-click resets it.

### Changed

- Open the assistant in a large centered dialog on every screen size. Closing
  the dialog leaves active runs working in the background and preserves their
  completion indicator for when the user returns.

- Match the right document context sidebar to the left navigation's panel controls
  and compact reopen bar, preserving Links/History state while collapsed.

### Fixed

- Prevent Firefox from restoring stale button states on reload and causing Home
  hydration warnings for the assistant and activity refresh controls.

## [0.1.58] - 2026-09-09

### Added

- Project and Account task editors configure ordered external report inputs with
  JSON arguments and explicit period bindings. Unavailable inputs stay visible for
  repair, and task details show safe per-input run outcomes.

- Assistant external tool picker shows approval policies and holds changed scope or
  access selections for review. Persisted approval cards offer full argument review,
  and external source summaries remain separate from document citations.

- Administration includes paged external MCP connections, explicit discovery and
  tool review, read/write classification, per-tool enabling, and project grants.
  Connection credentials remain write-only and automatic policy covers enabled
  reads and writes without an additional prompt.

- Scheduled reports support up to five required external read inputs with fixed
  period bindings, automatic-policy checks, bounded untrusted context and escaped
  source provenance. Failed inputs retain run summaries and preserve the prior report.

- Assistant runs support scoped external tool selections, persisted approval waits,
  external source summaries, and visible tool status. Later answers preserve
  external-context privacy and the full project lineage of replayed history.

- External MCP administration services support disabled-by-default connections,
  encrypted bearer credentials, bounded catalog discovery, explicit tool review,
  and project grants. Changed or removed tools become disabled pending review.

- External tool authorization rechecks live execution ownership, project permissions,
  reviewed configuration, and conversation history scope before use.

- External tool calls support exact-argument approvals and durable once-only dispatch,
  with live permission checks, denial reuse, and safe handling of unknown outcomes.

### Fixed

- External call activity restores after completion, interruption and reload, with
  connection identity, running status and a persistent unknown/no-replay warning.
  Safe error categories remain actionable in assistant and task history; lifecycle
  diagnostics record committed approval, discovery and execution outcomes.
- External connection breadcrumbs identify only the final page as current, and
  task history safely handles unrecognized error-code keys.

- Assistant attempts never automatically replay after an external call was
  dispatched. Interrupted external calls retain an unknown outcome; approval
  arguments are cleared on cancellation, expiry, and settlement.
- External provider scopes can suppress verbose body capture while preserving
  request metadata and independent token usage.

## [0.1.53] - 2026-09-09

### Added

- Home shows recent documents and tables, latest changes and job results,
  scheduled-report shortcuts, and a compact project list. Activity filters include
  changes by others and results; opening dashboards preserves unread job receipts.
- Home and project overviews can start a fresh assistant conversation with the
  appropriate scope and a focused composer.
- Project overviews with document/table counts, recent activity, active work,
  and shared content shortcuts. Maintainers can pin up to 12 documents or tables;
  members see only content they can access. Overview links preserve the correct
  audience when opening background-work history.

## [0.1.52] - 2026-09-08

### Added

- Background work visibility (Phase 6B): a topbar bell and tray show personal
  work in progress and recent results, with unread completion indicators that
  persist across sessions. Account › Background work adds project, type and state
  filters, paginated history, and links to task runs, imports, assistant conversations
  and knowledge settings. Project maintainers can inspect shared project work;
  assistant results remain private to their owner and require access to every
  project in the run's scope.

### Fixed

- Background-work tray navigation respects unsaved document and table edits.

## [0.1.51] - 2026-09-08

### Added

- Read-only MCP diagnostics for scheduled tasks: list task definitions in creation
  order, inspect instructions, scope, schedule and state, and read run history,
  context, errors, tokens, worker leases and output revisions. Admin access still
  requires project membership; large detail records support lossless JSON paging.

## [0.1.50] - 2026-09-08

### Added

- Scheduled AI tasks (Phase 6A): a project member describes a task in
  natural language, gives it a scope, an output folder, and a preset
  schedule with a timezone, and Weaver runs it unattended on the model routed
  to the new **Scheduled tasks** purpose. Each successful run replaces one
  living report document, committed as the owner with task and run
  provenance, so its history holds every past report. Project › Tasks lists
  the tasks writing into a project with run now, pause, resume, edit, and
  delete; the task page shows the run history; Account › Tasks lists your
  own; a task-maintained document carries a banner. Runs are skipped while
  the owner is deactivated or must change their password, never overlap,
  skip missed slots, and pause the task after five consecutive failures. A
  task scoped to several projects gives each project an equal share of the
  model's context budget, and every run records what each project
  contributed. Run now reports that background jobs are disabled instead of
  leaving behind a queued run no worker will ever pick up.

### Changed

- The agent worker gains the `tasks` role (compose: `knowledge,assistant,tasks`)
  and `WEAVER_TASK_TICK_CRON`.

## [0.1.49] - 2026-09-08

### Fixed

- Account › API keys: the one-time secret of a newly created key stayed
  readable from the browser's query cache for up to five minutes after the
  dialog closed. The create mutation now evicts its result immediately and
  resets when the dialog closes, as the password dialogs already do.

## [0.1.48] - 2026-09-08

### Changed

- Administration › Users › Reset password now revokes the user's personal API
  keys and OAuth grants (consents, refresh families, access tokens) together
  with their sessions, in the same transaction that flags the account for a
  password change. They do not come back once the user changes the password:
  a reset is containment for a suspected-compromised account, not a
  suspension. The dialog says so.

### Fixed

- Forced password change: a flagged user could still obtain an OAuth token
  through a client with a prior consent (Better Auth issued the code without
  the gated consent page ever rendering), replay a signed consent acceptance
  directly, or keep using API keys and tokens issued before an admin reset.
  The shared Better Auth hook now rejects every cookie-authenticated route
  while the flag is set except sign-in, session lookup, sign-out, password
  change, and an OAuth authorization or consent denial, and the OAuth
  provider routes a flagged user's authorization to the consent page ahead
  of its existing-consent shortcut, where it is denied cleanly.

## [0.1.47] - 2026-09-08

### Fixed

- OAuth consent: a user flagged to change their password could still approve
  an in-flight authorization from `/consent` — including `content:write` —
  because the page sat outside the forced-password-change gate and MCP
  requests never pass through it. The consent page now checks the flag before
  rendering the form and denies the authorization the way its own "Deny"
  button would, so a client requesting a _first_ consent gets a proper
  `access_denied` redirect instead of a token or a hang. A client with a
  prior consent for the same scopes still completes authorization without
  ever reaching this page — Better Auth issues the code straight away for an
  existing consent — so that path stays open until a follow-up closes it.

## [0.1.46] - 2026-09-08

### Added

- Administration › Users: a global Admin can create user accounts, change a
  user's global role, deactivate and reactivate accounts, reset passwords,
  revoke a user's sessions everywhere, and edit a user's project memberships —
  including restoring access to a project whose last Owner has left, though an
  Admin can never grant, change, or remove their own project membership.
  Creating a user or resetting a
  password shows the new password once; the account must change it at its
  next sign-in. Deactivation is a full kill switch: it ends existing sessions
  immediately and blocks the user's API keys and OAuth tokens on their next
  use. User deletion is deliberately not offered — removing someone's access
  means deactivating them, which is reversible and keeps their audit history
  intact.
- Account › Password: every user can change their own password at any time,
  and an account forced to change its password (newly created or reset by an
  Admin) is redirected here until it does.

## [0.1.44] - 2026-09-07

### Added

- External systems can push files into a project's Imports through
  `POST /api/ingestion/external` with a personal API key that carries the new
  **Submit files to Imports from external systems** capability
  (`ingest:external`). The key's owner must be an Editor of the target
  project; submissions arrive as **External** batches, go through the same
  parsing, analysis, linking, and review as uploads, and are never accepted
  automatically. One file per request, as multipart form data or as JSON with
  base64 content (JSON decoded content capped at 10 MiB or the file cap,
  whichever is smaller). `WEAVER_INGESTION_EXTERNAL_RATE_LIMIT_PER_MINUTE`
  (default 60) bounds submissions per key in one process instance.

### Changed

- The API keys page can grant the external feed capability and labels it
  **Import**.

## [0.1.43] - 2026-09-07

Covers Phases 1 through 5C (versions 0.1.1 to 0.1.43).

### Changed

- Import files now pass through **Extracting** and **Linking** after parsing
  before they are **Ready for review**. Retry and reconciliation republish only
  the failed or stalled stage, revoke stale workers when requeueing, and stop
  after the cumulative attempt limit.
- Interrupted import acceptance stays protected when unrelated commit summaries
  mention its operation identifier or recovery history cannot be fully checked.
- CSV uploads now become table drafts instead of Markdown documents; legacy .doc/.xls uploads fail with a hint to save as .docx/.xlsx.
- Every import now reaches a terminal state: a file whose processing keeps failing ends **failed** with "processing did not finish after 24 attempts" instead of being retried indefinitely, a long scan that exhausts the OCR time budget completes its draft with a warning naming the reason, and a PDF page that cannot be rasterized is skipped with a warning instead of failing the whole file.
- Weaver's favicon now shows an interwoven W in the cobalt brand palette, making browser tabs easier to recognize.
- MCP accepts stateless 2025-era Streamable HTTP clients, including Codex clients using `initialize`, alongside protocol `2026-07-28`. Authentication and per-request access checks apply to both.

- Account › API keys marks a key's **Admin** capability as dormant (outlined, dashed, with an "inactive while you are not an Admin" tooltip) while its owner is not a global Admin, matching the capability's fail-closed behaviour at request time.
- `pnpm start` now runs the web app, the agent worker, and the MCP server from the production build, matching `pnpm dev`; running only the web app left every durable knowledge job queued, so the index stayed "Building" and Rebuild had no visible effect. `pnpm start:web`, `pnpm start:worker`, and `pnpm start:mcp` start a single runtime.
- Document prose now uses the full reader and editor canvas width like tables, code blocks, and diagrams; the canvas no longer caps at 72rem and keeps 24px side margins. The Documents and Tables list screens and the version diff views drop the same 72rem cap, and the list's Title column absorbs the extra width instead of the Actions column.
- Under a base path, the OAuth issuer and every advertised auth endpoint now carry the base path, so discovery and token audiences match the URLs clients can reach; the compose deployment routes `/knowledge/api/mcp` to the new `mcp-server` container. The one-time authority cutover rotates every existing consent generation and revokes every existing OAuth access and refresh token, so previously connected clients must authorize again after the upgrade.
- Accepting a proposal and applying a direct MCP write now go through the same apply path, so both produce identical commits, revision checks, and recovery.
- Knowledge indexing and semantic search now use the routes configured in Administration › AI instead of `WEAVER_AI_*` environment variables (removed). Generations record the route they were built with, and AI usage rows carry the connection id.
- Authentication moved from Auth.js JWT credentials to Better Auth email/password database sessions; public sign-up is disabled and sign-out revokes the server-side session. Better Auth's organization mutation endpoints and its entire admin plugin HTTP surface (including impersonation and user management) are disabled and must stay so until a later phase opens specific routes. Better Auth's default sign-in rate limiting (production-only, 3 requests/10s per IP) is now configurable via `rateLimitEnabled` / `WEAVER_AUTH_RATE_LIMIT_ENABLED` (disabled for e2e), and the login form shows a distinct "Too many sign-in attempts" message instead of "Invalid credentials" when a 429 is returned.
- Project membership is now backed by Better Auth organizations (one organization per project); global Admins must be project members to read or edit project content, and the same role-grant rules apply to everyone.
- The dashboard and project settings pages now fill the available content width instead of centering in narrower 64rem/48rem columns.
- Knowledge jobs now run in a separate agent-worker runtime while the web app only publishes durable work, and project Git mutations use PostgreSQL advisory locks with commit-consistent readers across processes.
- Server environment parsing is shared and hardened: blank values count as unset, `SKIP_ENV_VALIDATION` skips validation everywhere, `DATABASE_POOL_MAX` and `DATABASE_STATEMENT_TIMEOUT_MS` accept up to 1000 and 24 hours, `WEAVER_WORKER_HEALTH_PORT` is validated (default 3101), and a relative `WEAVER_DATA_DIR` resolves against the workspace root so web and worker always share one Git store.
- The worker health endpoint reports `503 starting` until job workers are registered, so orchestrators no longer treat a hung startup as healthy.
- Repository lock waits now block server-side (`lock_timeout` + `pg_advisory_lock`) instead of polling, committed readers take a shared lock so concurrent readers no longer serialize behind each other, and `WEAVER_GIT_LOCK_POLL_MS` was removed.
- History attribution reads commit trailers through git's own trailer parser, so save messages ending in trailer-like paragraphs keep their author and operation metadata.
- `pnpm e2e` builds and starts the production web app again instead of the dev server, restoring `next build`/prerender coverage.
- The worker Docker image installs production dependencies only (~300 MB smaller) and regenerates the Prisma client layer independently of unrelated source edits.
- Knowledge status (a Maintainer-gated read) now requires `content:read` instead of `content:write`, so read-only credentials held by Maintainers can see it.
- Personal API keys without a custom rate limit now retain Better Auth's 10,000-request/minute default instead of becoming unlimited; fail-closed disabled keys are shown as disabled.

### Added

- Imports now propose a title, an existing folder, spreadsheet column types, and
  up to ten related documents. Editors review each draft at
  `/projects/<id>/imports/<fileId>` before **Accept** creates a document or table
  in one attributed Git commit, or **Reject** retains the original without a
  write. Document drafts can keep proposed links; table suggestions are
  navigable read-only references because tables cannot persist them. Acceptance
  recovery, edits, and deletion serialize on the file claim, validation errors
  remain visible, and accepted resources link from the batch list. Without an
  ingestion model route, analysis keeps the parsed title with a warning and the
  file still reaches review.
- Imports parse Word (.docx), Excel (.xlsx), CSV, PDF, PNG, JPEG, and WebP files: Word and PDF become document drafts, spreadsheets become table drafts, and scanned pages or images are transcribed by the model routed to the new **Import parsing** purpose (blocked with a pointer to Administration › AI until a vision-capable model is routed).
- Administration › AI gains a **Vision** model capability and a **Document parsing** card for an optional docling-serve endpoint with a connection test.
- `WEAVER_WORKER_ROLES` selects which job consumers a worker registers; the compose deployment runs a separate `ingestion-worker` (`WEAVER_INGESTION_MAX_OCR_PAGES` caps vision calls per file).
- MCP admin keys (`system:admin`) can debug imports with three new read tools: `list_ingestion_batches` (derived status plus per-status file counts), `list_ingestion_files` (all statuses, failure metadata, filterable by batch or status), and `get_ingestion_file` (file detail plus the review draft, with draft markdown clamped to the 16k tool output budget and `markdownTruncated`/`warningsTruncated` flags), subject to scoped Maintainer access like the knowledge inspection tools.
- Admin MCP control tools add `create_llm_connection`, `update_llm_connection`, `delete_llm_connection`, `test_llm_connection`, `create_llm_model`, `update_llm_model`, `delete_llm_model`, `import_llm_models`, `test_llm_model`, `set_llm_route`, `rebuild_knowledge_index`, `retry_failed_knowledge`, and `enqueue_reconcile`. Connection credentials are encrypted through the same services as the UI and never returned. Model tests return token usage.
- Admin MCP insight tools expose runtime overview and health, pg-boss queues, AI usage, LLM configuration, knowledge generations and document status, assistant run metadata, and MCP audit events. Lists are cursor-paged and output-bounded; knowledge inspection requires scoped Maintainer access, and assistant inspection excludes message and event payload text.

- Administration › Diagnostics: a switchable diagnostic log (`off`,
  `standard`, `verbose`) with retention and a row cap, written by the web app,
  worker, and MCP server and pruned automatically every 15 minutes.
- Personal API keys of global Admins can carry System administration. Such a
  key gets the admin MCP tools `get_diagnostics_settings`,
  `set_diagnostics_settings`, `list_diagnostic_events`,
  `get_diagnostic_event`, and `prune_diagnostic_events` while its owner remains
  an Admin.
- Administration › AI lets Admins explicitly configure resizable Matryoshka
  embedding models through Ollama and LM Studio while Weaver keeps its
  1,536-dimensional knowledge index.
- Creating a project now initializes its Git repository immediately and commits a root `project.json` carrying the project id, name, description, creation time, and members with their roles. Renaming a project, editing its description, and adding, re-roling, or removing members rewrite the file.
- The primary sidebar can be collapsed into an icon rail (Dashboard, the active project's sections, Administration, and the user menu) and expanded again; the choice is remembered in a cookie so reloads render it directly.
- Administration › AI: testing a connection now discovers the provider's models together with their context window, max output tokens, embedding dimensions, and capabilities — read from the endpoint where it reports them (LM Studio, Ollama, OpenRouter, vLLM, and newer Anthropic model lists) and otherwise from a built-in catalog of OpenAI and Anthropic model families — and opens an **Import models** dialog that declares the selected models in bulk. New models are preselected, already declared models can have their limits refreshed, embedding dimensions are probed when the endpoint does not report them, and every value stays editable afterwards. Creating a connection runs the discovery automatically.
- Administration › AI: LM Studio and Ollama are selectable providers with prefilled local endpoints (`http://127.0.0.1:1234`, `http://127.0.0.1:11434`) and native model discovery; their API key is optional.
- Declared models carry an optional max output tokens limit, shown next to the context window in the models table.
- MCP runtime: a standalone `apps/mcp-server` speaking MCP 2026-07-28 over stateless Streamable HTTP. Personal API keys and OAuth 2.1 access tokens (DPoP-bound tokens honoured) authenticate every request; the tool list follows the credential's capabilities: read tools for `content:read`, and direct-write tools (`create_document`, `update_document`, `create_table`, `update_table_schema`, `update_table_rows`) only for `content:write`. Every write requires a client `idempotencyKey` so a retry returns the original commit instead of a duplicate; only `update_document`, `update_table_schema`, and `update_table_rows` additionally require the last-read `baseCommitSha`. Documents, tables, and graph entities are also readable as `weaver://` resources. Every tool call and resource read is audited without payloads or tokens.
- Connected apps: the user menu lists the MCP clients you have allowed and lets you revoke one; a revoked client's tokens stop working on their next request instead of after they expire.
- Assistant panel: a collapsible right-hand assistant (⌘J / Ctrl+J) on every page and a full-page `/assistant` view with conversation history. Each message carries a visible scope (this document, this table, this project, selected projects, or all); answers stream in as they are written and can be cancelled — a run survives a reload or a second tab and its answer still arrives there, though only the tab that started it sees the live stream; sources appear as citation cards that open the cited document section, table, or graph entity; and proposed changes appear as cards with an inline diff or change list that Editors can accept or reject.

- Assistant backend foundation: personal conversations with per-message scope snapshots, durable runs executed by the agent worker with leases, retries, cancellation, and reconnectable sequenced events (`/api/assistant/runs/:id/events`), server-validated citations, and reviewable change proposals (document create/edit, table create/schema/rows) that commit only on user acceptance with base-revision checks. An "all projects" scope covers the 100 most recently updated projects you can access and says so when it was narrowed; cancelling a run stops it promptly, keeps any new tool call from starting, and always leaves the run in the terminal `cancelled` state rather than being overridden by an answer that finished in the meantime, though a proposal already executing when the cancellation lands can still be written. The panel UI arrives in Phase 4E.
- Administration › AI: global Admins manage LLM connections (OpenAI, Anthropic, OpenAI-compatible endpoints) with AES-256-GCM-encrypted credentials, declare models with capabilities and prices, test connections and models, and assign the assistant, knowledge-extraction, and knowledge-embedding routes.
- `pnpm secrets:rotate` re-encrypts stored provider credentials under the newest `WEAVER_ENCRYPTION_KEYS` version; web and worker refuse to start when stored credentials reference a missing key version.
- Documents API foundation: Git-backed folders and document create/edit/move/delete, paged listing, cross-references and backlinks, rename-aware history/diff/restore, optimistic concurrency, and repairable PostgreSQL projections with Maintainer-only index rebuild.
- Documents workspace browsing and organization: folder-tree and paged-list actions for creating, renaming, moving, and deleting documents and folders, plus the Maintainer+ document-index rebuild control.
- Document detail reading: static rich-content rendering, last-editor bylines, permission-aware edit affordances, and explicit loading, missing, and error states.
- Rich-text document editing with accessible formatting controls, mandatory save summaries, unsaved-navigation protection, and conflict-safe keep-editing or confirmed reload choices.
- Document version history with append pagination, inline and side-by-side Git diffs, a collapsible context rail, and Editor+ restore that records a new version.
- Document cross-reference UX with a shared searchable `[[`/toolbar picker whose independent Documents/Tables tabs insert typed links, live typed chips and broken-reference fallbacks, document hover previews, table routes, and outgoing/incoming link panels.
- Mermaid document blocks with source-and-preview editing, strict theme-aware lazy rendering, accessible reader output, and diagram-local syntax errors.
- Responsive document panels with session-persistent desktop context state, project-scoped and state-preserving tree/context drawers below `xl`, committed-state editor/diff/breakpoint focus handoffs, skeleton loading, inline blocking errors, and busy-announced mutations.
- Project-role-aware document UX: Viewers can browse content, links, and history; Editors can organize, edit, and append restores; Maintainers can rebuild the derived index; inaccessible projects and documents keep their existence hidden.
- Document section navigation for search and graph provenance links, with canonical rich-heading anchors, focused reader highlights, reduced-motion support, and a current-document fallback when the indexed section changed.
- Tables server foundation (Phase 2, M1–M4): git-backed tables (`schema.json` + JSON Lines under `tables/`), the `table` and `tableFolder` tRPC routers, row-level three-way merge on conflicting saves, row-level history/diff/restore, and `weaver://table` cross-references with backlinks.
- Hardened table imports and history with canonical UUIDs, calendar-aware dates, pre-merge byte caps, exact two-file committed reads, bounded identity-based version discovery, and self-healing table-folder projection drift.
- Complete Tables workspace (Phase 2, M5–M7): project navigation and breadcrumbs, folder-tree and paged-list organization, Maintainer+ index repair, AG Grid Community 36.1.0 editing for all six cell types, explicit save/merge/conflict recovery, guarded navigation, Git history with structured diff and append-only restore, document-to-table references and backlinks, Viewer read-only access, distinct recovery states, and full narrow editing through compact controls and drawers.
- Phase 2 browser coverage for the complete typed-table workflow, including canonical reload, filtering, guarded navigation, concurrent conflict recovery, history/restore, document references/backlinks, Viewer access, and narrow editing; the final suite passed all 6 Playwright specs.
- Phase 3 knowledge-index server foundation: accepted document/table commits now enqueue automatic, reconcilable keyword indexing; an optional OpenAI-compatible provider adds document embeddings plus entity/relation extraction into active, generation-safe PostgreSQL graph projections while keyword search remains available without AI.
- Permission-aware `search`, `graph`, and `knowledge` APIs now expose grouped hybrid/keyword results, bounded active-generation graph neighborhoods and provenance, Viewer readiness, and Maintainer status/rebuild/retry operations. Community-summary evaluation remains planned.
- Global knowledge search palette with click and `Cmd/Ctrl+K` entry, all-accessible-project default and bounded multi-project filtering, debounced grouped document/table/entity results, complete keyboard navigation, section-aware destinations, keyword-fallback status, retry, and focus restoration.
- Project knowledge-graph exploration with canonical bounded URLs, debounced multi-project entity finding, document-derived seeds, truthful single-project neighborhoods, URL-owned filters, a client-only token-themed visual canvas, synchronized keyboard outline, remaining-capacity expansion with retained-state retry, hard client caps, access-safe project switching, distinct Focus, Reset, and Fit controls, responsive filter/detail drawers, and permission-filtered entity/relation provenance with live current-document section links.
- Maintainer knowledge-index operations in project settings, with accepted status snapshots, in-progress readiness/build polling, AI configuration implications, confirmed shadow rebuilds, and cursor-guarded failed-work retry with persistent stalled recovery.
- Phase 3 browser coverage for grouped global search and keyword fallback, exact section focus, graph seeding/expansion/details/provenance, a real server-truncated neighborhood reaching the 200-relation canvas cap, truthful project switching, narrow keyboard drawers, Viewer access, and Maintainer shadow-rebuild/retry behavior.
- Personal API keys: create, list, and revoke `wvr_` keys from the user menu; keys default to read + MCP access, can add propose/write, be restricted to selected projects, expire, and carry a per-minute rate limit; the secret is shown once.
- MCP OAuth 2.1 foundation: the web app is an authorization server (authorization code + PKCE, consent page, audience-bound EdDSA access tokens, JWKS, RFC 8414/9728 discovery, Client ID Metadata Document client discovery); dynamic client registration and client self-management routes are disabled.
- `pnpm db:bootstrap-admin` creates the first global Admin on an empty deployment.

### Fixed

- Import review shows acceptance errors even when no editable field matches;
  Related sections that exceed the document limit explain how to deselect links.
  Linking preserves valid Unicode section anchors, and import breadcrumbs hide
  cached filenames after access loss or deletion.

- Small screens use a navigation drawer and compact top-bar controls; widening the browser closes the drawer without changing the saved desktop sidebar preference.
- Graph workspaces fill wide windows, keep labels spaced and readable, and render translucent node colors correctly in dark mode.
- Collapsed table context controls no longer cover Save, and empty table lists no longer display “Page 1 of 0.”
- Admin MCP queue and worker timestamps, date filters, and pagination preserve UTC instants when PostgreSQL uses a local time zone.

- The knowledge graph canvas now retains its full height when Cytoscape injects its container styles, so indexed entities and relationships appear instead of a blank drawing area.

- Document readers handle nested headings and callouts; saves reject malformed content and unsafe titles, preserve dirty drafts, and retain clicked folders. Document and table history, tree, and reference reads avoid repeated full scans.
- Table editing preserves empty select/boolean cells, merges identical concurrent rows, guards stale deletes, and offers explicit conflict reload and historical restore limits.
- Project creation recovers interrupted repositories; membership changes serialize safely and prevent Maintainers from changing peers. Failed account/list operations now show useful recovery states.
- Authentication closes consent-revocation bypasses, enforces live session bans and token revocation, preserves login destinations, avoids competing sign-in/consent redirects, and keeps internal errors and provider credentials out of client responses.
- Assistant runs reconnect after reload, page long conversations, show active proposals and truncation limits, invalidate proposals from unsuccessful attempts, and recheck project access before replaying content.
- Knowledge rebuilds supersede obsolete generations, handle larger multi-chunk documents, converge duplicate entities, and recover failed work without starving imports or maintenance. Graph selection and retry controls remain usable after navigation and missing entities.
- Imports accept common CSV browser MIME types, support upload progress/cancel, preserve active staged files, validate parser results before transitions, and correctly preview quoted CSV fields.
- Diagnostics capture bounded streaming responses, restrict verbose bodies to current project members, preserve usage counts and standard metadata, and report writer drops across runtimes.
- Test resets verify their database/data directory at the destructive boundary; browser tests prepare before starting one copy of each runtime. Deployment startup, signal forwarding, migration timing, and worker/MCP drain budgets are hardened.

- Provider credentials remain bound to their destination across connection edits; diagnostics scrub echoed request secrets, and metadata-only admin inspection excludes provider error prose.
- Account changes recreate browser caches and assistant state; denied document refetches hide retained content. Global search respects unsaved edits, pending sends stay with their original conversation, and saves preserve newer drafts by disabling edits while pending.
- Document index rebuilds preserve search chunks and restore missing projections; title validation is shared across write boundaries, H1 headings retain the document title in keyword search, and project metadata sync reads current truth under the Git lock.
- Knowledge recovery repairs stale generation targets and activates completed rebuilds; entity embedding batches respect exact serialized byte limits for multilingual input.
- Retried MCP and assistant creates recover one committed resource after acknowledgement failures. Proposal acceptance claims a durable state before writing; cancellation and renewed leases win their documented races. Assistant history is bounded to the model context, and citation excerpts come from verified resource revisions.
- Bootstrap creates user and password records atomically, with explicit recovery for a legacy orphan first Admin. Generic organization endpoints no longer expose soft-deleted project metadata.
- MCP throttles admission before buffering or credential checks, derives log labels from validated requests, and bounds scope queries in the database. AI usage summaries separate currencies and report unpriced calls.
- Completed assistant text remains visible until persisted history arrives; SSE replay applies backpressure, and graph dialogs retain a default focus target.

- Knowledge extraction now tells every provider what extraction schema version 1
  looks like. The system prompt only named the schema, so real models (DeepSeek
  through LiteLLM, for example) answered with their own JSON shape and every
  document failed with "AI provider returned invalid extraction"; the prompt now
  spells out each field, its bounds, and the empty result. The prompt version is
  `prompt-v2`, so existing generations rebuild on the next reconciliation.
- LiteLLM connections now discover what the proxy knows about a model: `mode`
  from the public model list, plus `mode`, `supports_function_calling`,
  `output_vector_size`, and token limits from `/model/info` when the key may
  call it. Models LiteLLM marks as embeddings import as embedding models with
  their dimensions, and explicit function-calling support imports as tool use.
  Servers without `/model/info` are unaffected, and Weaver still does not guess
  tool use for models LiteLLM knows nothing about; set
  `model_info.supports_function_calling` in LiteLLM to declare it there.
- Knowledge timestamps written by raw SQL (generation documents, embeddings,
  and retries) are stored in UTC like every other timestamp. On servers whose
  PostgreSQL session time zone is not UTC they carried the local wall-clock,
  which listed stale configuration failures above newer failures in a project's
  Recent failures.
- Recent failures in project settings now show when each failure happened;
  entries without a completion time use their last update instead of no time.
- LiteLLM connections now import context-window and maximum-output limits from
  the public model list's `max_input_tokens` and `max_output_tokens` fields.
  Missing capability metadata remains explicit: Weaver does not guess tool-use
  support from model names.
- The agent worker's startup check of the enrichment queue no longer takes an access-exclusive lock on the whole `pgboss.job` hierarchy. That lock deadlocked against pg-boss's own scheduler insert (partition first, parent second) on nearly every start, and when Postgres chose the check as the victim the worker failed to start. It now takes an exclusive lock on the parent and an access-exclusive lock on the queue's own table.
- The Documents sidebar no longer shows a vertical scrollbar when a project has no documents yet.
- The code-block language selector stays enabled inside an existing code block and changes that block's language.
- Code blocks wrap long lines in the document reader instead of scrolling horizontally, matching the editor.
- Global search now fetches fresh results on every query instead of reusing a result cached up to 30 seconds earlier, so a document saved moments ago is found once its keyword index job (typically 1–2 s) has landed. Keyword search also matches words from a document's title and headings; previously only chunk bodies and exact full titles were searchable.
- MCP write-only OAuth grants now resolve their 100-project membership scope
  without requiring read permission, while every tool and resource still
  enforces its own capability and the same cap. `list_projects` reports scope
  truncation, the 101st project remains hidden from resources, and capped
  table/entity resources remain valid JSON with explicit truncation metadata.
- MCP crash recovery now verifies durable request-hash and tool-name Git
  trailers, write timeouts and incoming transport aborts cannot return
  `CANCELLED` before a later commit, and authenticated rate-limited
  tool/resource calls receive exactly one payload-free `RATE_LIMITED` audit
  row. MCP shutdown now stops admission and drains accepted requests before
  closing the SDK, so an admitted write cannot be falsely cancelled during
  termination.
- DPoP replay verification prunes only expired `dpop-proof:` reservations via
  a partial expiry index, and explicit MCP/issuer URLs now canonicalize
  non-root trailing slashes across audiences, discovery, consent, and routing.
- The OAuth authority cutover deploy now takes a writer-conflicting consent
  lock before any other held relation lock, waits for row-first revocations,
  and enforces a quiesced database before handing execution to Prisma. The
  already-applied cutover migration remains byte-for-byte append-only.
- Assistant runs no longer fail with "The assistant couldn't finish this answer." after the assistant reads something. Tool results were handed to the model as raw objects, so any result carrying a timestamp (`list_documents`, `list_tables`) failed the provider SDK's message validation on the model's next step and killed the run. Tool results are now always JSON values. An unclassified run failure is also logged (with credentials redacted) instead of failing silently, so the cause is visible in the worker log.
- OAuth consent generations now reject stale broader authorization codes after narrower re-consent, enforce one live grant per user/client, and serialize consent updates, refresh issuance, and revocation with one deadlock-free row-lock order. Because historical duplicate-pair evidence was unavailable after deduplication, a write-locked cutover rotates every existing grant and revokes every existing token family once; connected clients must reauthorize, while grants created afterward are unchanged.
- Worker shutdown now drains handlers before disconnecting Prisma, worker-stop cleanup survives queue errors, and a stale 15-second route-cache entry is refreshed before a knowledge generation is blocked.
- Semantic search compares query and stored vectors only under the same live route fingerprint and reports keyword fallback when no compatible vectors remain; embedding batching now budgets UTF-8 bytes for multilingual content.
- OpenAI-compatible usage accepts nullable cache details, Anthropic discovery follows pagination and accounts for cache-creation tokens, and rejected provider responses release their bodies.
- Concurrent Owner demotion/removal is serialized per project, preserving the last Owner invariant.
- CIMD redirects are origin-bound, OAuth refresh-token rotation/replay has integration coverage, bearer failures expose one uniform rejection message, and sign-in/plugin initialization observers no longer fail silently or turn a non-critical login timestamp write into a failed sign-in.
- LLM startup trial-decrypts stored credentials, rejects endpoints with query strings, bounds discovered model output and currency at the service boundary, and maps route/delete FK races to conflict errors.
- Cross-project reads enforce `content:read`; query-embedding infrastructure failures retain keyword results; API-key and Administration UI refetch/focus/whitespace edge cases no longer present stale or misleading state.
- Exact-title document search now uses its generated ready/current eligibility key with an ordered covering index, bounding duplicate-title scans per accessible project.
- The theme toggle no longer triggers a React hydration mismatch (and a permanently stale "Theme: system" label) for users with a stored light/dark preference.
- The theme toggle no longer triggers a hydration mismatch on Firefox reloads, which restore the button's enabled state over the server-rendered HTML.
- Background pg-boss errors (for example a dropped idle database connection) are logged instead of crashing the web or worker process, late job enqueues after the worker has drained fail loudly instead of starting an unmanaged queue, and the worker forces exit if shutdown hangs past 40 seconds.
- Repository lock queue: a queued writer that times out while the holder is still running no longer lets the next caller bypass the per-project turn queue, and concurrent readers of one project no longer each hold a lock-pool client while waiting (one waiting reader per project, readers still overlap once admitted), so one long write cannot starve saves to unrelated projects.
- The agent worker now closes the fallback publisher that handler enqueues may start during its graceful drain instead of leaving an unmanaged pg-boss instance alive until exit.
- Knowledge job/AI configuration treats blank environment values as unset — a `WEAVER_JOBS_ENABLED=` placeholder no longer crash-loops web and worker, and blank cost values mean "not configured" rather than free — and honors `SKIP_ENV_VALIDATION` like the server environment parser.
- The root `db:*`, `test:integration*`, and `e2e` scripts refuse to run when their env file is missing, names a different database/data-directory pair than documented, or is overridden by a differing shell `DATABASE_URL`/`WEAVER_DATA_DIR`, closing the dotenv-cli fallback that could point a destructive suite at the dev database.
- `pnpm db:seed` fails fast without `DATABASE_URL`, no longer reads a stray `packages/db/.env`, repairs Demo Project memberships on re-runs, and leaves a soft-deleted Demo Project deleted.
- Hand-authored migrations now match the Prisma schema: generated title columns are `NOT NULL`, unused server-side id defaults are dropped, the truncated `GraphRelation` unique index carries Prisma's canonical name, and `migration_lock.toml` is checked in so `prisma migrate diff --from-migrations` can run.
- The document conflict dialog now offers "Overwrite with my version" and explains that "Keep editing" keeps conflicting until you reload or overwrite; document saves are guarded against duplicate in-flight submissions from Cmd+S and the save form.
- The sidebar/topbar user menu and the project list show a retryable error instead of endless skeletons or a false "No projects yet" when their queries fail, and document workspace error states (project, access, document) now include a Retry button.
- Repository locking is fault-tolerant: waiters for one busy project no longer starve saves to unrelated projects, a dropped connection during unlock no longer reports a persisted save as a server error, and an idle lock-pool connection error no longer crashes the process.
- The agent worker reuses its own running job queue for follow-up enqueues instead of lazily starting a second pg-boss instance, the web publisher no longer runs queue supervision or the enrichment migration, and a partially started queue is now stopped instead of leaking its pool and timers.
- `pnpm db:seed` resolves its password-hashing dependency again after the move into `@weaver/db`.
- Document headings now keep stable canonical anchors across React render retries, and sign-in no longer races duplicate unused session fetches that could rotate its CSRF cookie.
- Graph drawers now close without leaving a hidden modal trap when resizing to desktop, same-project focus/document navigation deterministically focuses the resolved workspace without disturbing filter-only updates, and Details closure restores focus to a connected outline control or workspace fallback.
- Direct graph focus links now verify and switch to the focused entity’s project before rendering any canvas data, and stale document-section links show their current-document fallback as a visible polite status.
- Global-search destinations now route after modal teardown, document readers retain rendered section-node identity across unrelated updates, and knowledge status keeps polling while readiness is building before its generation row appears; section focus and one-time failed-work retry therefore remain observable and reliable. Active and building generation panels are explicitly named regions so assistive technology and tests can distinguish the preserved snapshot from shadow-build progress.
- Graph details now replace stale focused neighborhoods when the active graph generation changes, hide cached graph data after access loss, disable Expand consistently at hard capacity or during another graph action, keep narrow screen-reader order aligned with the outline-first layout, and honor reduced-motion preferences in dialogs.
- Document reading and editing now share an aligned `6xl` canvas while ordinary
  prose stays at a readable `70ch` and diagrams, code, tables, and images retain
  the full available width.
- Table Save now commits active text and number editors and preserves rapid
  successive cell edits.
- Knowledge indexing now enforces composed chunk/request/response limits, validates provider usage and vectors before every persistence/reuse/query boundary, propagates worker cancellation under a bounded enrichment lease, and coordinates generation builds and failed retries in stable 200-item pages without project-sized arrays or per-document counter rescans.
- Cached workspace breadcrumbs now hide project, document, and table titles after access loss, and permission-scoped table move/delete, folder rename/move/delete, and restore dialogs cannot revive stale destructive operations after demotion and regrant.
- Accepted table saves and merges now retain their exact pre-save cache guard when column or multi-row dialogs open, so a failed refresh cannot let an older cached snapshot replace committed state.
- Boolean table cells now distinguish empty values from false and expose selectable True/False text alongside accessible checkbox semantics.
- Typed cross-reference picker tabs now control real accessible tab panels with isolated controls; uncached reference loading uses neutral typed chips, while missing, mismatched, or failed resolution keeps metadata-free broken chips instead of falling through to raw editor-node markup.
- Accepted table saves now retain the exact normal or merged server response when the pre-save query cache is stale or cache refresh fails, while later canonical revisions still reconcile normally; malformed or empty conflict metadata no longer opens structured recovery.
- Table-folder move and rename now keep an open table detail route active while the list route preserves its selected descendant, and the quick-create folder picker has an associated visible label.
- Table no-op moves now ignore stale projection collisions, and table projection repair cannot mutate a same-ID row owned by another project or hide valid Git content when repair fails.
- Save summaries are now single-line at both browser and API boundaries, Git attribution trusts only Weaver's final canonical user trailer, and dirty editors guard browser Back and Forward navigation.
- Document-index rebuilds now refresh reference-resolution caches and keep failures visible in a non-dismissible busy dialog; readers report reference-resolution failures while retaining cached live targets.
- Document reads now resolve committed renames coherently even before their projection update finishes, repository recovery clears stranded Git lock files without following metadata symlinks, and index rebuild skips external files outside the normal path, title, and size contract.
- Document rename summaries now support every valid title length, and document/folder organization refreshes dependent document metadata and link caches.
- Document editing now survives background refetch failures, confirms dirty folder-button navigation, and preserves newer canonical metadata fetched after a save.
- Cross-reference refreshes now invalidate project-wide backlink caches, large valid documents resolve every reference in one bounded POST-body request, and picker refetch failures keep cached results visible and selectable.
- Document writes and path changes now refresh table backlink, identity, list, and typed reference caches so table chips and source-document backlinks stay coherent.
- Mermaid blocks now preserve prefix-language code fences, embedded backtick fence runs, and HTML clipboard source; concurrent diagrams serialize strict initialization and invalid syntax leaves no Mermaid-generated error container.

### Removed

- Pre-release accounts, password hashes, and project memberships are dropped by the Better Auth migration; run the seed again to recreate the demo users.

## [0.1.0] - 2026-08-21

### Added

- Application bootstrap: Next.js 16 app with credentials authentication (JWT sessions, global Admin/User roles).
- Projects and memberships: create/list/update/soft-delete projects; manage members with Owner/Maintainer/Editor/Viewer roles and last-Owner protection.
- Service layer with permission checks; tRPC 11 API; Zod 4 validation.
- PostgreSQL persistence via Prisma 7 with hand-authored migrations; three-database local setup (dev/integration/e2e).
- Dashboard and project settings UI, dark mode, permission-aware controls.
- Integration (Vitest) and end-to-end (Playwright) test suites with tiered cadence and guard hooks.
- Production Docker parity (Dockerfile + compose) for later deployment under the /knowledge base path.
