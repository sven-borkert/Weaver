-- A task can name its target document and choose to revise it instead of replacing it.
CREATE TYPE "ScheduledTaskOutputMode" AS ENUM ('replace', 'update');
ALTER TABLE "ScheduledTask"
  ADD COLUMN "outputMode" "ScheduledTaskOutputMode" NOT NULL DEFAULT 'replace',
  ADD COLUMN "outputTitle" VARCHAR(200);
