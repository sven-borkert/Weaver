-- The default parser stores "/app/conf/datastoreconfig.xml" as one "file" lexeme, so the bare
-- file name never matched. Split paths and dotted/underscored names into words on both sides.

CREATE FUNCTION weaver_search_text(input text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
  RETURN regexp_replace(input, '[/\\._]', ' ', 'g');

DROP INDEX "DocumentSearchChunk_searchVector_idx";
ALTER TABLE "DocumentSearchChunk" DROP COLUMN "searchVector";
ALTER TABLE "DocumentSearchChunk"
  ADD COLUMN "searchVector" tsvector
  GENERATED ALWAYS AS (
    to_tsvector(
      'simple',
      weaver_search_text(
        coalesce(weaver_join_text_array("headingPath"), '') || ' ' || coalesce("content", '')
      )
    )
  ) STORED;
CREATE INDEX "DocumentSearchChunk_searchVector_idx"
  ON "DocumentSearchChunk" USING GIN ("searchVector");
