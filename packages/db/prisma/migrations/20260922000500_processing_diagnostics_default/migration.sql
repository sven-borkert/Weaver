-- Capture processing lifecycle metadata by default; preserve explicit off/verbose choices.
UPDATE "SystemSetting"
SET "value" = jsonb_set("value", '{level}', '"standard"'::jsonb),
    "updatedAt" = timezone('UTC', now())
WHERE "key" = 'diagnostics'
  AND "value"->>'level' = 'errors';
