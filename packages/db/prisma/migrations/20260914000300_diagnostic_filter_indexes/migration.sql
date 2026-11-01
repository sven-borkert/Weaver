CREATE INDEX "DiagnosticEvent_event_createdAt_idx" ON "DiagnosticEvent" ("event", "createdAt");
CREATE INDEX "DiagnosticEvent_severity_createdAt_idx" ON "DiagnosticEvent" ("severity", "createdAt");
CREATE INDEX "DiagnosticEvent_userId_createdAt_idx" ON "DiagnosticEvent" ("userId", "createdAt");
CREATE INDEX "DiagnosticEvent_connectionId_createdAt_idx" ON "DiagnosticEvent" ("connectionId", "createdAt");
