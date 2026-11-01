-- Diagnostic events receive UTC timestamps from the process, never a session-time-zone default.

ALTER TABLE "DiagnosticEvent" ALTER COLUMN "createdAt" DROP DEFAULT;
