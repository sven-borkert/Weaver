-- packages/db/prisma/migrations/20260908090000_document_search_heading_text/migration.sql
-- Document keyword search matched chunk bodies only, so a document could not be
-- found by a word of its own title or headings (they live in "headingPath").
-- Generated columns require an immutable expression; array_to_string is stable.

CREATE FUNCTION weaver_join_text_array(parts text[]) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
  RETURN array_to_string(parts, ' ');

ALTER TABLE "DocumentSearchChunk" DROP COLUMN "searchVector";
ALTER TABLE "DocumentSearchChunk"
  ADD COLUMN "searchVector" tsvector
  GENERATED ALWAYS AS (
    to_tsvector(
      'simple',
      coalesce(weaver_join_text_array("headingPath"), '') || ' ' || coalesce("content", '')
    )
  ) STORED;
CREATE INDEX "DocumentSearchChunk_searchVector_idx"
  ON "DocumentSearchChunk" USING GIN ("searchVector");
