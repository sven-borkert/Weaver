-- Exact-title search needs a stored key so its candidate limit also bounds
-- execution instead of normalizing every authorized title at query time.
ALTER TABLE "Document"
  ADD COLUMN "normalizedTitle" TEXT
  GENERATED ALWAYS AS (
    lower(regexp_replace(normalize("title", NFKC), '\s+', ' ', 'g'))
  ) STORED;

ALTER TABLE "DataTable"
  ADD COLUMN "normalizedTitle" TEXT
  GENERATED ALWAYS AS (
    lower(regexp_replace(normalize("title", NFKC), '\s+', ' ', 'g'))
  ) STORED;

CREATE INDEX "Document_projectId_normalizedTitle_title_id_idx"
  ON "Document"("projectId", "normalizedTitle", "title", "id");

CREATE INDEX "DataTable_projectId_normalizedTitle_title_id_idx"
  ON "DataTable"("projectId", "normalizedTitle", "title", "id");
