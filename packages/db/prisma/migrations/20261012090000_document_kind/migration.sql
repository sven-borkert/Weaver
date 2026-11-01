CREATE TYPE "DocumentKind" AS ENUM ('markdown', 'python');
ALTER TABLE "Document" ADD COLUMN "kind" "DocumentKind" NOT NULL DEFAULT 'markdown';
