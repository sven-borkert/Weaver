-- Recreated source projections can make an existing derived state current
-- again, so insertion refreshes the same trigger-owned eligibility key.
CREATE TRIGGER "Document_refresh_exact_title_insert"
AFTER INSERT ON "Document"
FOR EACH ROW EXECUTE FUNCTION "weaver_refresh_document_exact_title"();

CREATE TRIGGER "DataTable_refresh_exact_title_insert"
AFTER INSERT ON "DataTable"
FOR EACH ROW EXECUTE FUNCTION "weaver_refresh_table_exact_title"();
