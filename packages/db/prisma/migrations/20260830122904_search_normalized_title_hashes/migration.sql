CREATE EXTENSION IF NOT EXISTS pgcrypto;

DROP INDEX "Document_projectId_normalizedTitle_title_id_idx";
DROP INDEX "DataTable_projectId_normalizedTitle_title_id_idx";

ALTER TABLE "Document" DROP COLUMN "normalizedTitle";
ALTER TABLE "DataTable" DROP COLUMN "normalizedTitle";

-- ECMAScript NFKC/lowercase/whitespace semantics with a bounded index key.
ALTER TABLE "Document"
  ADD COLUMN "normalizedTitle" TEXT COLLATE "C"
  GENERATED ALWAYS AS (
    btrim(
      regexp_replace(
        lower(normalize("title", NFKC) COLLATE "und-x-icu"),
        U&'[\0009-\000D\0020\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]+',
        ' ',
        'g'
      ),
      ' '
    )
  ) STORED,
  ADD COLUMN "normalizedTitleHash" BYTEA
  GENERATED ALWAYS AS (
    digest(
      btrim(
        regexp_replace(
          lower(normalize("title", NFKC) COLLATE "und-x-icu"),
          U&'[\0009-\000D\0020\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]+',
          ' ',
          'g'
        ),
        ' '
      ),
      'sha256'
    )
  ) STORED;

ALTER TABLE "DataTable"
  ADD COLUMN "normalizedTitle" TEXT COLLATE "C"
  GENERATED ALWAYS AS (
    btrim(
      regexp_replace(
        lower(normalize("title", NFKC) COLLATE "und-x-icu"),
        U&'[\0009-\000D\0020\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]+',
        ' ',
        'g'
      ),
      ' '
    )
  ) STORED,
  ADD COLUMN "normalizedTitleHash" BYTEA
  GENERATED ALWAYS AS (
    digest(
      btrim(
        regexp_replace(
          lower(normalize("title", NFKC) COLLATE "und-x-icu"),
          U&'[\0009-\000D\0020\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]+',
          ' ',
          'g'
        ),
        ' '
      ),
      'sha256'
    )
  ) STORED;

CREATE INDEX "Document_projectId_normalizedTitleHash_title_id_idx"
  ON "Document"("projectId", "normalizedTitleHash", "title", "id");

CREATE INDEX "DataTable_projectId_normalizedTitleHash_title_id_idx"
  ON "DataTable"("projectId", "normalizedTitleHash", "title", "id");
