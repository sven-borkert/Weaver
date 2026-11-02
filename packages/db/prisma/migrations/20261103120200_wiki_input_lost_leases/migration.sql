-- attempts counts Process presses; this counts runs lost while the input was being worked on.
ALTER TABLE "WikiInputItem" ADD COLUMN "lostLeases" INTEGER NOT NULL DEFAULT 0;
