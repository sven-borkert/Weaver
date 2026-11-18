# Weaver application code review

Reviewed `main` at `8edccc7ac28e164f16a270bfced9d3c619190bad` (Weaver `0.1.241`) on 2026-11-18.

The findings below describe that revision. The [implementation notes](IMPLEMENTATION.md#november-18-application-review-fixes) document the fixes in Weaver `0.1.242`.

## Summary

The highest-priority defect allows a normal document move to relocate a different document and its images when Git and the database disagree about which document occupies a path. Git pull has two independent failure paths that can prolong that disagreement. Other findings affect peer credentials, reviewer authorization, scheduled task scope, and preservation of user work after a retry or concurrent edit.

| ID                                                                              | Priority | Finding                                                             |
| ------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------- |
| [R01](#r01-document-move-and-image-upload-can-target-the-wrong-document)        | P1       | Document move and image upload can target the wrong document        |
| [R02](#r02-peer-transfer-can-pair-a-credential-with-the-wrong-endpoint)         | P2       | Peer transfer can pair a credential with the wrong endpoint         |
| [R03](#r03-stale-reviewer-projections-authorize-a-review-stamp)                 | P2       | Stale reviewer projections authorize a review stamp                 |
| [R04](#r04-import-acceptance-trusts-unverified-git-recovery-evidence)           | P2       | Import acceptance trusts unverified Git recovery evidence           |
| [R05](#r05-single-resource-scheduled-tasks-include-project-wide-history)        | P2       | Single-resource scheduled tasks include project-wide history        |
| [R06](#r06-a-failed-git-pull-can-publish-preliminary-renames)                   | P2       | A failed Git pull can publish preliminary renames                   |
| [R07](#r07-a-concurrent-save-can-prevent-post-pull-projections-from-converging) | P2       | A concurrent save can prevent post-pull projections from converging |
| [R08](#r08-git-pull-and-machine-key-management-acquire-locks-in-reverse-order)  | P2       | Git pull and machine-key management acquire locks in reverse order  |
| [R09](#r09-a-stale-machine-key-form-can-restore-removed-grants)                 | P2       | A stale machine-key form can restore removed grants                 |
| [R10](#r10-personal-workspaces-are-visible-before-ownership-is-finalized)       | P2       | Personal workspaces are visible before ownership is finalized       |
| [R11](#r11-run-now-can-delete-a-run-the-queue-already-accepted)                 | P2       | Run Now can delete a run the queue already accepted                 |
| [R12](#r12-a-wiki-worker-can-mutate-input-after-losing-its-lease)               | P2       | A wiki worker can mutate input after losing its lease               |
| [R13](#r13-exam-autosave-can-acknowledge-a-different-answer)                    | P2       | Exam autosave can acknowledge a different answer                    |
| [R14](#r14-document-exports-mix-repository-revisions)                           | P2       | Document exports mix repository revisions                           |
| [R15](#r15-a-partially-published-image-release-cannot-resume)                   | P2       | A partially published image release cannot resume                   |
| [R16](#r16-each-paged-pdf-read-extracts-the-entire-file)                        | P3       | Each paged PDF read extracts the entire file                        |
| [R17](#r17-the-deep-json-test-depends-on-v8-stack-behavior)                     | P3       | The deep JSON test depends on V8 stack behavior                     |

P1 indicates a high-impact integrity failure reachable through normal use. P2 indicates a material correctness, authorization, or reliability defect under specific operating conditions. P3 indicates a narrower performance or test reliability issue.

## Findings

### R01 Document move and image upload can target the wrong document

The document move mutation accepts a document ID and destination folder. The writer takes the repository lock, reads the path from PostgreSQL, and moves the file and asset directory without comparing the ID in the file header. Git pull can relocate a local document and reuse its old path for incoming content before PostgreSQL is rebuilt. During that interval, moving the local document moves the incoming document and updates the local document's row to point to the wrong destination. Image upload has the same path-binding gap and can write to the other document's asset directory. [Move router](../apps/web/src/server/api/routers/document.ts#L115-L119), [Move writer](../packages/core/src/services/documents.ts#L2498-L2585), [Image writer](../packages/core/src/services/documentImages.ts#L60-L85), [Git collision handling](../packages/core/src/services/projectGitRemoteMerge.ts#L505-L550), [Post-pull rebuild](../packages/core/src/services/projectGitRemoteJobs.ts#L666-L686).

**Correction.** Resolve or validate the requested ID against the committed snapshot under the write lock before any file or asset mutation. The current delete path already performs this check. Add a regression with a stale row whose old path contains a different document. Assert that a move and image upload leave the other document and its assets intact. [Deletion identity check](../packages/core/src/services/documents.ts#L2628-L2647).

### R02 Peer transfer can pair a credential with the wrong endpoint

Transfer reads the enabled peer and its base URL, then looks up the connection separately by the peer's stable ID. The registry keeps that ID when replacing the URL, clears old connections, and allows reconnection. A transfer overlapping a replacement and reconnection can therefore pair a credential for the replacement with the previous URL. The fresh-token path proceeds directly to dispatch. OAuth authorization state also records the stable peer ID without an endpoint generation. [Token resolution and dispatch](../packages/core/src/services/remoteInstances/connections.ts#L342-L385), [Endpoint replacement](../packages/core/src/services/remoteInstances/registry.ts#L215-L237), [Authorization state](../packages/core/src/services/remoteInstances/connections.ts#L103-L123), [Callback endpoint resolution](../packages/core/src/services/remoteInstances/connections.ts#L185-L217).

**Correction.** Bind OAuth state, credentials, and dispatch to the same endpoint generation. Read the endpoint and connection coherently and fence callback persistence and token refresh by that generation. Use inert peer doubles to verify that a replacement makes old work fail closed and a new credential goes only to its associated endpoint.

### R03 Stale reviewer projections authorize a review stamp

Folder review parses the current Git headers and checks the expected Git HEAD, but determines eligibility from projected reviewer data. If a pull changes a document's reviewer assignment without changing its ID or path, the previous reviewer can still be considered eligible while the projection catches up. A preview and review against the new HEAD can stamp that reassigned document as reviewed. The single-document mutation also uses the projected assignment for its authorization. [Folder review preparation](../packages/core/src/services/folderReview.ts#L589-L634), [Projected eligibility](../packages/core/src/services/documentReview.ts#L100-L119), [Single-document review](../packages/core/src/services/documentReview.ts#L194-L227).

**Correction.** Use the committed assignment and live project membership and group resolution when stamping a review, or require the assignment projection to match the committed revision. Cover a pulled reassignment while the old reviewer projection remains present.

### R04 Import acceptance trusts unverified Git recovery evidence

Import acceptance asks the common recovery function for an existing create but omits the recovery identity. The common function requires a trusted request match only when that identity is supplied. The import can therefore mark a draft accepted against Git history that matches the operation and resource identifiers without showing that Weaver wrote that exact reviewed draft. The failure path also treats an operation trailer by itself as a reason to retain the acceptance claim. [Import write and recovery](../packages/core/src/services/ingestionAccept.ts#L212-L256), [Claim release](../packages/core/src/services/ingestionAccept.ts#L281-L296), [Recovery trust and resource matching](../packages/core/src/services/contentOperations.ts#L830-L898).

**Correction.** Bind trusted local recovery evidence to the import and the reviewed draft contents for both acceptance and claim release. Cover a legitimate lost acknowledgement and an untrusted historical match with repository doubles.

### R05 Single-resource scheduled tasks include project-wide history

A task focused on one document or table narrows the current-content block, but the history filter applies only to folders. The digest can contain the titles and change summaries of other resources and raw diff lines from unrelated documents. The runner sends both blocks to the model. This exceeds the configured focus and can carry unrelated material into a generated report, including a report saved in another project. [Change collection and folder filter](../packages/core/src/scheduledTasks/context.ts#L299-L351), [Document diff collection](../packages/core/src/scheduledTasks/context.ts#L368-L419), [Current-content selection](../packages/core/src/scheduledTasks/context.ts#L477-L494), [Prompt assembly](../packages/ai/src/taskRunner.ts#L409-L414).

**Correction.** Filter change entries and diff candidates by the selected resource ID. Suppress commit messages and shared summaries when a commit also touches resources outside that scope. An isolated run of the context assembly with doubles confirmed that both single-resource scope types include unrelated project content in the digest. Add prompt assertions for both types, including mixed-resource commits.

### R06 A failed Git pull can publish preliminary renames

When a pull must resolve slug collisions, its preparation commit advances the live HEAD. If a later checkout, metadata write, or final merge commit fails, recovery resets the worktree to the current HEAD, which can be that preparation commit. The worker records a durable merge SHA only after the merge call returns. It therefore reports the pull as failed and exits before rebuilding projections while the preliminary renames remain published. [Preparation commit](../packages/core/src/services/projectGitRemoteMerge.ts#L645-L653), [Git ref update](../packages/git-store/src/gitStore.ts#L1660-L1682), [Merge failure handling](../packages/core/src/services/projectGitRemoteMerge.ts#L786-L840), [Worker publication and error branch](../packages/core/src/services/projectGitRemoteJobs.ts#L552-L562), [Failure return](../packages/core/src/services/projectGitRemoteJobs.ts#L618-L629).

**Correction.** Stage the preparation commit without advancing the live ref, then publish the final outcome with the original HEAD as a precondition. Inject a controlled failure after preparation and check that failed pulls leave the original HEAD and projections aligned.

### R07 A concurrent save can prevent post-pull projections from converging

Document rebuild scans a captured Git revision, then checks that HEAD still matches before publishing. A routine save during the scan correctly causes a conflict. The pull worker handles both projection rebuilds in one block, so a document conflict skips the table rebuild and leaves only a diagnostic. Its fallback knowledge reconciliation receives no projection repair IDs and starts from existing database rows. Newly imported resources can remain absent from lists and search until another rebuild occurs. [Document scan](../packages/core/src/services/documents.ts#L2013-L2080), [Projection HEAD guard](../packages/core/src/services/documents.ts#L2173-L2179), [Pull rebuild and fallback](../packages/core/src/services/projectGitRemoteJobs.ts#L676-L708), [Reconciliation dispatch](../packages/core/src/jobs/runtime.ts#L365-L404), [Knowledge input scan](../packages/core/src/services/knowledgeReconciliation.ts#L125-L141).

**Correction.** Schedule durable, independently retryable document and table projection rebuilds after a published pull. Verify convergence after a supported write advances HEAD between the document scan and publication.

### R08 Git pull and machine-key management acquire locks in reverse order

Machine-key policy changes acquire the exclusive repository lock before taking the project membership lock. Git pull publication takes the same membership lock first. Concurrent operations can wait on one another until a lock timeout breaks the cycle, during which same-project Git work is stalled. The pull can surface `MERGE_FAILED`. [Key policy lock ordering](../packages/core/src/services/projectApiKeys.ts#L313-L327), [Membership lock key](../packages/core/src/services/projectMembers.ts#L299-L305), [Pull lock ordering](../packages/core/src/services/projectGitRemoteJobs.ts#L542-L552).

**Correction.** Use one lock order across both entry points. Test publication and a concurrent policy write with independent database connections and a controlled admission barrier.

### R09 A stale machine-key form can restore removed grants

The edit dialog sends a full grant snapshot without the policy version it was loaded from. The API reads the current key and checks revocation of the key itself, then replaces the grants and increments `policyVersion`. A maintainer saving an unrelated change from an old form can reinstate access removed by another maintainer. The policy lock serializes both writes and permits the stale replacement to run second. [Edit dialog](<../apps/web/src/app/(workspace)/projects/[projectId]/settings/_components/MachineApiKeyDialog.tsx#L182-L197>), [Update schema](../packages/core/src/projectApi/schemas.ts#L164-L176), [Policy update](../packages/core/src/services/projectApiKeys.ts#L405-L442).

**Correction.** Keep the loaded policy version with the form draft and require a matching version under the policy lock. Test two authorized updates and verify that a stale submission conflicts and the removed grant stays absent.

### R10 Personal workspaces are visible before ownership is finalized

Provisioning releases its per-user advisory lock before creating the project. The new project and Owner membership become visible before the separate update that sets `personalOwnerId`. Landing can select the interim project, and a deletion admitted during that window checks only the Owner role inside the repository lock. Concurrent provisioning can also expose a losing project that the cleanup path later removes. [Workspace provisioning](../packages/core/src/services/personalWorkspace.ts#L48-L100), [Project publication](../packages/core/src/services/projects.ts#L140-L173), [Landing selection](../packages/core/src/services/landingProject.ts#L43-L49), [Deletion guard](../packages/core/src/services/projects.ts#L209-L234).

**Correction.** Set personal ownership in the same transaction that publishes project and membership rows. Include the protection in the guarded deletion update. Cover concurrent first landings and a deletion attempt while creation is paused.

### R11 Run Now can delete a run the queue already accepted

`dispatchTaskRun` publishes the job, then writes the queue job ID separately. A failure recording that ID is treated as a failed dispatch by Run Now, which unconditionally deletes the durable run and tells the user it was never queued. A worker may have claimed that run already. The result can be lost run history or a report whose run has disappeared. [Publish then record job ID](../packages/core/src/services/scheduledTasks.ts#L969-L979), [Run Now error handling](../packages/core/src/services/scheduledTasks.ts#L925-L947), [Worker claim](../packages/core/src/services/scheduledTasks.ts#L1173-L1213).

**Correction.** Make successful queue acceptance independent of receipt bookkeeping. Keep the durable intent when publication is ambiguous so reconciliation can settle it. An isolated run with queue and database doubles confirmed that a failed receipt write deletes an already running row. Keep that case as a regression alongside confirmed non-publication.

### R12 A wiki worker can mutate input after losing its lease

The runner checks that the session is live before invoking a tool. Input completion, however, writes by input ID, run ID, and status. A requeue normally leaves processing items attached to the same run, so an operation that passed its precheck before lease loss can still mark an item processed or skipped after a new worker takes over. Completion clears notes and can clear the source text. Input claim and note writes also lack a lease check at their write boundary. [Runner precheck](../packages/ai/src/wikiRunner.ts#L195-L205), [Requeue behavior](../packages/core/src/services/wikiTick.ts#L146-L181), [Input mutations](../packages/core/src/services/wikiRunSession.ts#L200-L245), [Completion write](../packages/core/src/services/wikiRunSession.ts#L258-L304).

**Correction.** Verify the current lease token and expiry in the transaction applying the input mutation, following the run-to-input lock order. An isolated service check confirmed that a delayed completion can clear source text after the reaper runs. Add a regression that replaces the lease before an old completion writes and verifies that the new attempt retains control of the input.

### R13 Exam autosave can acknowledge a different answer

Two tabs of the same attempt can load the same answer sequence and submit different answers at the next sequence. The server accepts the first write and returns `stale` for the second. The hook refreshes the canonical answer and marks it saved based on sequence alone. It replaces the second tab's text or selection, clears the pending state, and lets submission proceed. A fresh canonical read fixes the earlier stale-cache issue but cannot establish that the values match. [Server write ordering](../packages/core/src/services/examAttempts.ts#L319-L371), [Autosave recovery](<../apps/web/src/app/(workspace)/projects/[projectId]/exams/attempts/[attemptId]/_components/useAutosaveAnswers.ts#L145-L167>), [Reducer and flush](<../apps/web/src/app/(workspace)/projects/[projectId]/exams/attempts/[attemptId]/_components/useAutosaveAnswers.ts#L50-L60>), [Submission](<../apps/web/src/app/(workspace)/projects/[projectId]/exams/attempts/[attemptId]/_components/TakeExam.tsx#L74-L90>).

**Correction.** Treat recovery as an acknowledgement only when the canonical answer represents the submitted value or carries the same write identity. Preserve a divergent local draft and expose the conflict before submission. A React renderer with tRPC doubles confirmed that `flush()` resolves with the other tab's answer marked saved.

### R14 Document exports mix repository revisions

ZIP export resolves the requested document path at one HEAD, then resolves HEAD again and builds the archive from the old path. A concurrent pull or move can make that path disappear or point to a different document. PDF export and peer send have the inverse mismatch. They read ordinary images at the document file's last modification commit, so an asset-only change can be missing from an otherwise current export. [ZIP export](../packages/core/src/services/documentDownload.ts#L83-L104), [Document snapshot lookup](../packages/core/src/services/documents.ts#L1714-L1781), [PDF image reads](../apps/web/src/server/documents/pdf/export.ts#L48-L67), [Peer image reads](../packages/core/src/services/remoteInstances/transfer.ts#L85-L120).

**Correction.** Pin document identity, enumeration, and attachments to one repository snapshot. Cover path reuse between ZIP lookup and packaging, and verify that PDF and peer send include changes to an already referenced image made in an asset-only commit.

### R15 A partially published image release cannot resume

CI checks every immutable tag before pushing, then pushes all tags for each image in turn. If a later image fails to push, a rerun rejects the immutable tag already published for the earlier image. The release remains incomplete, and `latest` may already point at different revisions across services. A local test of the actual script with a stub registry left only the tools image published after an interrupted web push. The retry stopped at the existing tools version tag. [Registry preflight and push loop](../deploy/ci/build-images.sh#L73-L98), [GitHub release arguments](../.github/workflows/build-images.yml#L75-L90), [GitLab release arguments](../.gitlab-ci.yml#L68-L81).

**Correction.** Record the expected image digests in a release manifest so a retry can verify and resume the original publish. Update mutable aliases only after the complete immutable set is available. Add a stateful registry-double test that interrupts a release and retries it.

### R16 Each paged PDF read extracts the entire file

The PDF tool passes a page range to the reader, but the reader extracts text for the entire PDF before slicing the result. Each continuation launches another bounded reader process and repeats that work. A large file can exceed the reader timeout when the caller needs only a small range. [Tool range dispatch](../packages/assistant-tools/src/tools/artifacts.ts#L775-L789), [Full-document extraction](../packages/artifact-readers/src/pdf.ts#L75-L85), [Range and budget handling](../packages/artifact-readers/src/pdf.ts#L159-L201), [Reader limits](../packages/core/src/artifacts/readerProcess.ts#L46-L52).

**Correction.** Open the document once per request and extract only the pages needed for that range and response budget. Use an instrumented fixture to assert that a single-page read never extracts unrelated pages.

### R17 The deep JSON test depends on V8 stack behavior

The test expects `JSON.stringify` to exhaust the native stack at a fixed depth. The same test passes on Node 22.23.5 and fails on Node 26.13.1 because the query returns normally there. This makes the documented Node 22+ setup yield different Tier 1 results. [Depth test](../packages/artifact-readers/src/json.test.ts#L390-L402), [Serialization budget](../packages/artifact-readers/src/json.ts#L194-L212), [Supported setup](setup.md#L9).

**Correction.** Test error translation with a controlled serializer failure. If the reader needs a depth limit, define and test that limit explicitly.

## Coverage and verification

The review covered the application across these areas by following entry points through authorization, state transitions, storage, and failure handling. Existing tests and the [November 14 review](code-review-2026-11-14.md) provided regression context.

| Area                            | Paths inspected                                                                                                                                                                                                                              |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity and integrations       | Better Auth sessions, credential issuance and revocation, OAuth/DPoP, external OIDC, project access and membership, tRPC, project machine API, inbound and outbound MCP, and peer connections and transfer                                   |
| Git and persistence             | Project lifecycle, database schema and recent constraints, repository readers and writers, lock ordering, document and table lifecycle and history, review, recovery, archives, and Git synchronization                                      |
| Background work and AI          | Worker startup and queue ownership, assistant runs and proposals, tool dispatch, scheduled task assembly and publication, wiki processing and leases, knowledge indexing and search, LLM routing, diagnostics, and ingestion                 |
| Files, exams, dashboard, and UI | Artifact storage and selected readers, notebook preparation, import review, exam definitions and grading, timed attempts and autosave, dashboard activity and pins, and representative document, table, account, admin, and explorer screens |
| Operations                      | CI, image publication, migrations entry points, Compose services, runtime health, backup, and upgrade                                                                                                                                        |

- On Node 22.23.5, `pnpm check` passed lint and type checking across all 14 scoped packages, and `pnpm format:check` passed. `pnpm test --concurrency=1 --continue=always` passed across all 14 package tasks, plus script and mock-server tests. The core suite reported one skipped test. On Node 26.13.1 the regular test command reached the artifact readers and stopped at R17.
- Isolated checks executed the relevant code with doubles for scheduled task context, Run Now, wiki lease recovery, exam autosave, and image release retry. A direct comparison of both Node runtimes confirmed the serialization behavior in R17. The other findings are based on source tracing.
- This was an application-wide review with representative coverage of UI and file formats. Full integration and browser suites, live providers and peers, deployment, historical migration replay, and an exhaustive dependency or vendored-parser audit remain unverified.

Address R01 with the pull publication and projection recovery gaps in R06 and R07. Then prioritize peer endpoint binding, reviewer and import trust, and scheduled task scope before the remaining concurrency and operation-retry issues.
