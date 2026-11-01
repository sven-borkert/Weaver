export const PROJECT_API_PREFIX = "wvr_project_";
export const MACHINE_ACTIONS = ["read", "create", "update", "delete"] as const;
export const MACHINE_TARGET_KINDS = [
  "document",
  "documentFolder",
  "table",
  "tableFolder",
] as const;
export const PROJECT_API_DEFAULT_EXPIRY_DAYS = 90;
export const PROJECT_API_MAX_EXPIRY_DAYS = 365;
export const PROJECT_API_DEFAULT_RATE_LIMIT = 100;
export const PROJECT_API_MAX_RATE_LIMIT = 10_000;
export const PROJECT_API_MAX_KEYS = 100;
export const PROJECT_API_MAX_GRANTS = 100;
export const PROJECT_API_MAX_BODY_BYTES = 5 * 1024 ** 2;
export const PROJECT_API_DEFAULT_PAGE_SIZE = 50;
export const PROJECT_API_MAX_PAGE_SIZE = 100;
export const PROJECT_API_MAX_ROW_BATCH = 1_000;
export const PROJECT_API_OPERATION_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
export const PROJECT_API_AUDIT_RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;
export const MACHINE_UUID_RE =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export const MACHINE_IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_.:-]{8,128}$/;
