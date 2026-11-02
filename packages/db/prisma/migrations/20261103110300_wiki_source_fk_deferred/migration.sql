-- Deferred so a project delete does not depend on FK trigger order, which a dump and restore changes.
BEGIN;
ALTER TABLE "Document" DROP CONSTRAINT "Document_wikiSourceItemId_fkey";
ALTER TABLE "DataTable" DROP CONSTRAINT "DataTable_wikiSourceItemId_fkey";
ALTER TABLE "Document" ADD CONSTRAINT "Document_wikiSourceItemId_fkey" FOREIGN KEY ("wikiSourceItemId") REFERENCES "WikiInputItem"("id") ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "DataTable" ADD CONSTRAINT "DataTable_wikiSourceItemId_fkey" FOREIGN KEY ("wikiSourceItemId") REFERENCES "WikiInputItem"("id") ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;
COMMIT;
