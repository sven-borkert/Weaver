/** Whether this server can render PDFs; shared by the server check and the client button. */
export type PdfRuntimeStatus =
  { status: "ok" } | { status: "missing"; reason: string };
