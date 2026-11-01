CREATE INDEX "DiagnosticEvent_fileId_createdAt_id_idx"
ON "DiagnosticEvent" (("details"->>'fileId'), "createdAt" DESC, "id" DESC)
WHERE "details" ? 'fileId';
