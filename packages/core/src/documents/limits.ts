export const MAX_MARKDOWN_CHARS = 200_000;
export const MAX_DOCUMENT_GENERATION_INSTRUCTION_CHARS = 4_000;
/** Selected text the document assistant may receive. */
export const MAX_DOCUMENT_ASSISTANT_SELECTION_CHARS = 20_000;
/** Document text on each side of the selection the editor sends along. */
export const MAX_DOCUMENT_ASSISTANT_CONTEXT_CHARS = 20_000;
/** Earlier messages of one document assistant conversation. */
export const MAX_DOCUMENT_ASSISTANT_TURNS = 12;
export const MAX_DOCUMENT_ASSISTANT_TURN_CHARS = 20_000;
/** Images one document write may copy in. */
export const MAX_IMPORTED_IMAGES = 100;
/** Combined image bytes one imported document may carry. */
export const MAX_IMPORT_IMAGE_BYTES = 64 * 1024 ** 2;
