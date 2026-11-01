import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ReaderFailure,
  runArtifactReader,
} from "../artifacts/readerProcess";
import {
  readArtifact,
  reportOperationalFailure,
  toCoreError,
} from "./artifactReads";

const emitted = vi.hoisted(() => vi.fn());
const getArtifact = vi.hoisted(() => vi.fn());
vi.mock("./artifacts", () => ({ getArtifact }));
vi.mock("../diagnostics/writer", () => ({ emitDiagnostic: emitted }));

describe("toCoreError", () => {
  const cases: Array<{
    failure: ReaderFailure;
    code: string;
    /** Only where the mapping replaces the reader's own message. */
    message?: string;
    details?: Record<string, unknown>;
  }> = [
    {
      failure: {
        code: "not_found",
        message: "file content is no longer stored",
      },
      code: "NOT_FOUND",
    },
    {
      failure: {
        code: "busy",
        message: "too many file reads are in progress; try again",
      },
      code: "TOO_MANY_REQUESTS",
    },
    {
      failure: {
        code: "unavailable",
        cause: "timeout",
        message: "reading the file took too long",
      },
      code: "BAD_REQUEST",
      message: "reading the file took too long",
      details: { reason: "PAYLOAD_TOO_LARGE" },
    },
    {
      failure: {
        code: "unavailable",
        cause: "memory",
        message: "reading the file needed too much memory",
      },
      code: "BAD_REQUEST",
      message: "reading the file needed too much memory",
      details: { reason: "PAYLOAD_TOO_LARGE" },
    },
    // A child that aborted on its own heap limit is still the file's fault.
    {
      failure: {
        code: "unavailable",
        cause: "memory",
        message: "reading the file needed too much memory",
        exitCode: null,
        signal: "SIGABRT",
      },
      code: "BAD_REQUEST",
      message: "reading the file needed too much memory",
      details: { reason: "PAYLOAD_TOO_LARGE" },
    },
    // An operational failure is the server's, not the caller's: it must not
    // come back as a BAD_REQUEST the model would try to "fix".
    {
      failure: {
        code: "unavailable",
        cause: "crashed",
        message: "reading the file failed",
        exitCode: 1,
        signal: null,
      },
      code: "INTERNAL_SERVER_ERROR",
      message: "reading the file failed on the server",
    },
    {
      failure: {
        code: "unavailable",
        cause: "not_started",
        message: "the file reader could not be started",
      },
      code: "INTERNAL_SERVER_ERROR",
      message: "reading the file failed on the server",
    },
    {
      failure: {
        code: "resource_limit",
        message: "the file is too large or complex to read",
      },
      code: "BAD_REQUEST",
      details: { reason: "PAYLOAD_TOO_LARGE" },
    },
    {
      failure: { code: "malformed", message: "artifact is not valid JSON" },
      code: "BAD_REQUEST",
    },
    {
      failure: { code: "invalid_input", message: "invalid file reference" },
      code: "BAD_REQUEST",
    },
    {
      failure: { code: "legacy_format", message: "legacy format" },
      code: "BAD_REQUEST",
    },
    {
      failure: { code: "encrypted", message: "PDF is password-protected" },
      code: "BAD_REQUEST",
    },
    {
      failure: { code: "unsupported_format", message: "unsupported format" },
      code: "BAD_REQUEST",
    },
    {
      failure: { code: "invalid_path", message: "invalid path" },
      code: "BAD_REQUEST",
    },
  ];

  it.each(cases)(
    "maps reader code $failure.code $failure.cause to $code",
    ({ failure, code, message, details }) => {
      const error = toCoreError(failure);
      expect(error.code).toBe(code);
      expect(error.message).toBe(message ?? failure.message);
      expect(error.details).toEqual(details);
    },
  );
});

describe("reportOperationalFailure", () => {
  const artifact = { id: "artifact-1", projectId: "project-1" };
  const unavailable = (
    cause: "timeout" | "memory" | "crashed" | "not_started",
    exit?: { exitCode: number | null; signal: NodeJS.Signals | null },
  ): ReaderFailure => ({
    code: "unavailable",
    cause,
    message: "fixed",
    ...(exit ?? {}),
  });

  it("records a crash and a failed start as errors with the exit status", () => {
    emitted.mockClear();
    reportOperationalFailure(
      unavailable("crashed", { exitCode: 1, signal: null }),
      "word.outline",
      artifact,
    );
    reportOperationalFailure(unavailable("not_started"), "pdf.pages", artifact);
    expect(emitted.mock.calls.map((call) => call[0] as unknown)).toEqual([
      {
        event: "artifact.reader.failed",
        severity: "error",
        outcome: "error",
        message: "artifact reader failed",
        projectId: "project-1",
        details: {
          cause: "crashed",
          operation: "word.outline",
          artifactId: "artifact-1",
          exitCode: 1,
          signal: null,
        },
      },
      {
        event: "artifact.reader.failed",
        severity: "error",
        outcome: "error",
        message: "artifact reader failed",
        projectId: "project-1",
        details: {
          cause: "not_started",
          operation: "pdf.pages",
          artifactId: "artifact-1",
        },
      },
    ]);
  });

  it("records a child that aborted on its heap limit as a warning only", () => {
    emitted.mockClear();
    reportOperationalFailure(
      unavailable("memory", { exitCode: null, signal: "SIGABRT" }),
      "word.chapter",
      artifact,
    );
    expect(emitted).toHaveBeenCalledTimes(1);
    expect(emitted.mock.calls[0]![0]).toEqual({
      event: "artifact.reader.failed",
      severity: "warn",
      outcome: "error",
      message: "artifact reader ran out of memory",
      projectId: "project-1",
      details: {
        cause: "memory",
        operation: "word.chapter",
        artifactId: "artifact-1",
        exitCode: null,
        signal: "SIGABRT",
      },
    });
  });

  it("stays silent for the watchdog kill, a timeout, and every reader code", () => {
    emitted.mockClear();
    reportOperationalFailure(unavailable("memory"), "word.outline", artifact);
    reportOperationalFailure(unavailable("timeout"), "word.outline", artifact);
    reportOperationalFailure(
      { code: "busy", message: "busy" },
      "word.outline",
      artifact,
    );
    reportOperationalFailure(
      { code: "malformed", message: "bad" },
      "word.outline",
      artifact,
    );
    expect(emitted).not.toHaveBeenCalled();
  });
});

describe("readArtifact completion cancellation", () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each([false, true])(
    "handles successful runner completion with late abort=%s",
    async (abort) => {
      vi.stubEnv(
        "DATABASE_URL",
        "postgresql://unused:unused@localhost/weaver_test",
      );
      vi.stubEnv(
        "AUTH_SECRET",
        "artifact-reader-unit-test-secret-32-characters",
      );
      vi.stubEnv("WEAVER_DATA_DIR", "./data-test");
      const target = { projectId: "project-1", filename: "read.txt" };
      const artifact = {
        ...target,
        id: "artifact-1",
        contentType: "text/plain",
        byteSize: 7,
        contentDigest: "a".repeat(64),
        updatedAt: new Date("2026-10-09T00:00:00Z"),
      };
      getArtifact.mockResolvedValue(artifact);
      const controller = new AbortController();
      const reason = new Error("cancelled before runner completion");
      const value = { text: "private", nextPosition: null };
      const runReader = vi.fn<typeof runArtifactReader>(
        async (_request, options) => {
          expect(options?.signal).toBe(controller.signal);
          expect(controller.signal.aborted).toBe(false);
          if (abort) controller.abort(reason);
          return { ok: true, value };
        },
      );
      const returned = vi.fn();
      const pending = readArtifact(
        {} as Parameters<typeof readArtifact>[0],
        {} as Parameters<typeof readArtifact>[1],
        target,
        "text.read",
        {},
        { signal: controller.signal, runReader },
      ).then((result) => {
        returned(result);
        return result;
      });
      if (abort) {
        await expect(pending).rejects.toBe(reason);
        expect(returned).not.toHaveBeenCalled();
      } else {
        await expect(pending).resolves.toMatchObject({
          artifact: { filename: "read.txt" },
          value,
        });
        expect(returned).toHaveBeenCalledTimes(1);
        expect(controller.signal.aborted).toBe(false);
      }
      expect(runReader).toHaveBeenCalledTimes(1);
    },
  );
});
