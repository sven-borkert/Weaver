BEGIN;

ALTER TABLE "RemoteInstance" ADD COLUMN "endpointGeneration" INTEGER NOT NULL DEFAULT 1;
CREATE UNIQUE INDEX "RemoteInstance_id_endpointGeneration_key"
  ON "RemoteInstance"("id", "endpointGeneration");

ALTER TABLE "RemoteInstanceConnection" ADD COLUMN "endpointGeneration" INTEGER;
UPDATE "RemoteInstanceConnection" SET "endpointGeneration" = 1;
ALTER TABLE "RemoteInstanceConnection"
  ALTER COLUMN "endpointGeneration" SET NOT NULL,
  DROP CONSTRAINT "RemoteInstanceConnection_remoteInstanceId_fkey",
  ADD CONSTRAINT "RemoteInstanceConnection_endpoint_fkey"
    FOREIGN KEY ("remoteInstanceId", "endpointGeneration")
    REFERENCES "RemoteInstance"("id", "endpointGeneration") ON DELETE CASCADE ON UPDATE RESTRICT;

-- Pending OAuth states created by the previous version have no endpoint binding.
ALTER TABLE "RemoteInstanceAuthorization" ADD COLUMN "endpointGeneration" INTEGER;
DELETE FROM "RemoteInstanceAuthorization";
ALTER TABLE "RemoteInstanceAuthorization"
  ALTER COLUMN "endpointGeneration" SET NOT NULL,
  DROP CONSTRAINT "RemoteInstanceAuthorization_remoteInstanceId_fkey",
  ADD CONSTRAINT "RemoteInstanceAuthorization_endpoint_fkey"
    FOREIGN KEY ("remoteInstanceId", "endpointGeneration")
    REFERENCES "RemoteInstance"("id", "endpointGeneration") ON DELETE CASCADE ON UPDATE RESTRICT;

COMMIT;
