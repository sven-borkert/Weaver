UPDATE "LlmModel" SET "contextWindow" = NULL WHERE "contextWindow" = 0;
UPDATE "LlmModel" SET "maxOutputTokens" = NULL WHERE "maxOutputTokens" = 0;
ALTER TABLE "LlmModel"
  ADD CONSTRAINT "LlmModel_contextWindow_positive" CHECK ("contextWindow" IS NULL OR "contextWindow" > 0),
  ADD CONSTRAINT "LlmModel_maxOutputTokens_positive" CHECK ("maxOutputTokens" IS NULL OR "maxOutputTokens" > 0);
