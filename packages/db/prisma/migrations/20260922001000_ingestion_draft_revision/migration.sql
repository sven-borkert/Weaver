-- Reviewed-version counter: a draft save or first accept must name the revision it saw.

ALTER TABLE "IngestionDraft"
  ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 0;
