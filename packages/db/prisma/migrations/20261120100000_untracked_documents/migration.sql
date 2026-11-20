CREATE TABLE "UntrackedDocument" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "path" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "kind" "DocumentKind" NOT NULL DEFAULT 'markdown',
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "revision" CHAR(40) NOT NULL,
    "appearance" JSONB,
    "excerpt" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL,
    "createdById" UUID,
    "createdByName" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" UUID,
    "updatedByName" TEXT,
    "reviewDueAt" TIMESTAMP(3),
    "lastReviewedAt" TIMESTAMP(3),
    "wikiType" TEXT,
    "wikiSummary" TEXT,

    CONSTRAINT "UntrackedDocument_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "UntrackedDocument_projectId_path_key" ON "UntrackedDocument"("projectId", "path");
CREATE UNIQUE INDEX "UntrackedDocument_projectId_slug_key" ON "UntrackedDocument"("projectId", "slug");
ALTER TABLE "UntrackedDocument" ADD CONSTRAINT "UntrackedDocument_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "UntrackedFolder" (
    "projectId" UUID NOT NULL,
    "path" TEXT NOT NULL,
    "metadata" TEXT NOT NULL,

    CONSTRAINT "UntrackedFolder_pkey" PRIMARY KEY ("projectId", "path")
);

ALTER TABLE "UntrackedFolder" ADD CONSTRAINT "UntrackedFolder_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "UntrackedFile" (
    "projectId" UUID NOT NULL,
    "path" TEXT NOT NULL,
    "bytes" BYTEA NOT NULL,
    "sha" CHAR(40) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UntrackedFile_pkey" PRIMARY KEY ("projectId", "path")
);

ALTER TABLE "UntrackedFile" ADD CONSTRAINT "UntrackedFile_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Carry Outside Git entries over as untracked folders and documents. Each path
-- segment gets the entry's id prefix so it cannot collide with tracked content.
WITH RECURSIVE entries AS (
    SELECT e.*,
        COALESCE(
            NULLIF(trim(BOTH '-' FROM left(regexp_replace(lower(e."title"), '[^a-z0-9]+', '-', 'g'), 60)), ''),
            'untitled'
        ) || '-' || left(e."id"::text, 8) AS "segment"
    FROM "LocalDocumentEntry" e
),
tree AS (
    SELECT e."id", e."projectId", e."kind", e."title", e."markdown", e."createdAt", e."updatedAt",
        e."segment", e."segment" AS "path"
    FROM entries e
    WHERE e."parentId" IS NULL
    UNION ALL
    SELECT c."id", c."projectId", c."kind", c."title", c."markdown", c."createdAt", c."updatedAt",
        c."segment", t."path" || '/' || c."segment"
    FROM entries c
    JOIN tree t ON t."id" = c."parentId" AND t."projectId" = c."projectId" AND t."kind" = 'folder'
),
folders AS (
    INSERT INTO "UntrackedFolder" ("projectId", "path", "metadata")
    SELECT "projectId", "path",
        jsonb_pretty(jsonb_build_object(
            'id', "id"::text,
            'name', "title",
            'created', to_char("createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
            'updated', to_char("updatedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        )) || E'\n'
    FROM tree
    WHERE "kind" = 'folder'
    RETURNING 1
),
documents AS (
    SELECT t.*,
        E'---\nid: ' || t."id"::text
        || E'\ntitle: ' || to_json(t."title")::text
        || E'\ncreated: ' || to_char(t."createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        || E'\nupdated: ' || to_char(t."updatedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        || E'\n---\n\n' || t."markdown" AS "content"
    FROM tree t
    WHERE t."kind" = 'document'
)
INSERT INTO "UntrackedDocument" (
    "id", "projectId", "path", "slug", "kind", "title", "content", "revision",
    "excerpt", "createdAt", "updatedAt"
)
SELECT d."id", d."projectId", d."path" || '.md', d."segment", 'markdown', d."title", d."content",
    left(encode(sha256(convert_to(d."content", 'UTF8')), 'hex'), 40),
    left(regexp_replace(d."markdown", '\s+', ' ', 'g'), 300),
    d."createdAt", d."updatedAt"
FROM documents d
WHERE (SELECT count(*) FROM folders) >= 0;

DROP TABLE "LocalDocumentEntry";
DROP TYPE "LocalDocumentEntryKind";
