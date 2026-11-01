/** Maximum files accepted by one browser upload batch. */
export const MAX_INGESTION_UPLOAD_FILES = 20;

/** Largest decoded file accepted by the external feed JSON form. */
export const MAX_EXTERNAL_JSON_FILE_BYTES = 10_485_760;

/** Table drafts mirror the bounds a `table.create` content operation accepts (5C acceptance). */
export const MAX_DRAFT_TABLE_ROWS = 1_000;
export const MAX_DRAFT_TABLE_COLUMNS = 100;
export const MAX_DRAFT_TABLE_CELL_CHARS = 10_000;
export const MAX_DRAFT_TABLE_COLUMN_NAME_CHARS = 100;
export const DRAFT_TABLE_SAMPLE_ROWS = 20;
