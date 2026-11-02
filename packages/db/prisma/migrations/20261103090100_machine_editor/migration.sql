-- Expand only: lastEditedByProjectKeyId and its CHECK stay until a later release.
ALTER TABLE "Document" ADD COLUMN "lastEditedByMachineKind" TEXT, ADD COLUMN "lastEditedByMachineId" UUID;
ALTER TABLE "DataTable" ADD COLUMN "lastEditedByMachineKind" TEXT, ADD COLUMN "lastEditedByMachineId" UUID;

UPDATE "Document"
SET "lastEditedByMachineKind" = 'projectApiKey', "lastEditedByMachineId" = "lastEditedByProjectKeyId"
WHERE "lastEditedByProjectKeyId" IS NOT NULL;
UPDATE "DataTable"
SET "lastEditedByMachineKind" = 'projectApiKey', "lastEditedByMachineId" = "lastEditedByProjectKeyId"
WHERE "lastEditedByProjectKeyId" IS NOT NULL;

ALTER TABLE "Document" ADD CONSTRAINT "Document_machine_editor_pair" CHECK (
  ("lastEditedByMachineKind" IS NULL) = ("lastEditedByMachineId" IS NULL)
  AND ("lastEditedByMachineKind" IS NULL OR "lastEditedByMachineKind" IN ('projectApiKey', 'wikiAgent'))
  AND ("lastEditedById" IS NULL OR "lastEditedByMachineKind" IS NULL)
);
ALTER TABLE "DataTable" ADD CONSTRAINT "DataTable_machine_editor_pair" CHECK (
  ("lastEditedByMachineKind" IS NULL) = ("lastEditedByMachineId" IS NULL)
  AND ("lastEditedByMachineKind" IS NULL OR "lastEditedByMachineKind" IN ('projectApiKey', 'wikiAgent'))
  AND ("lastEditedById" IS NULL OR "lastEditedByMachineKind" IS NULL)
);
