-- Vision-capable chat models transcribe scanned PDF pages and images (Phase 5B OCR).
-- The new label is not referenced elsewhere in this migration, so ADD VALUE is
-- safe inside the migration transaction.
ALTER TYPE "LlmModelCapability" ADD VALUE 'vision';
