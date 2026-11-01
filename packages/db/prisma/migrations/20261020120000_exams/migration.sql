CREATE TYPE "TrainingRole" AS ENUM ('trainer', 'trainee');

CREATE TYPE "ExamStatus" AS ENUM ('draft', 'published', 'archived');

CREATE TYPE "ExamQuestionKind" AS ENUM ('multiple_choice', 'free_text');

CREATE TYPE "ExamAttemptStatus" AS ENUM ('in_progress', 'submitted', 'in_review', 'released');

CREATE TYPE "ExamSubmissionKind" AS ENUM ('manual', 'timeout');

CREATE TABLE "ProjectTrainingRole" (
    "projectId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "role" "TrainingRole" NOT NULL,
    "assignedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ProjectTrainingRole_pkey" PRIMARY KEY ("projectId", "userId")
);

CREATE INDEX "ProjectTrainingRole_userId_idx" ON "ProjectTrainingRole"("userId");
CREATE INDEX "ProjectTrainingRole_assignedById_idx" ON "ProjectTrainingRole"("assignedById");
ALTER TABLE "ProjectTrainingRole" ADD CONSTRAINT "ProjectTrainingRole_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProjectTrainingRole" ADD CONSTRAINT "ProjectTrainingRole_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProjectTrainingRole" ADD CONSTRAINT "ProjectTrainingRole_assignedById_fkey" FOREIGN KEY ("assignedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "Exam" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "instructions" TEXT NOT NULL DEFAULT '',
    "status" "ExamStatus" NOT NULL DEFAULT 'draft',
    "timeLimitMinutes" INTEGER NOT NULL,
    "passingPercent" INTEGER,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Exam_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Exam_projectId_status_idx" ON "Exam"("projectId", "status");
CREATE INDEX "Exam_projectId_updatedAt_idx" ON "Exam"("projectId", "updatedAt");
CREATE INDEX "Exam_createdById_idx" ON "Exam"("createdById");
ALTER TABLE "Exam" ADD CONSTRAINT "Exam_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Exam" ADD CONSTRAINT "Exam_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "ExamQuestion" (
    "id" UUID NOT NULL,
    "examId" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "kind" "ExamQuestionKind" NOT NULL,
    "prompt" TEXT NOT NULL,
    "weight" INTEGER NOT NULL,
    "choices" JSONB,
    "allowMultiple" BOOLEAN NOT NULL DEFAULT false,
    "expectedAnswer" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ExamQuestion_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ExamQuestion_examId_position_key" ON "ExamQuestion"("examId", "position");
ALTER TABLE "ExamQuestion" ADD CONSTRAINT "ExamQuestion_examId_fkey" FOREIGN KEY ("examId") REFERENCES "Exam"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ExamAttempt" (
    "id" UUID NOT NULL,
    "examId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "traineeId" UUID NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "examRevision" INTEGER NOT NULL,
    "definitionSnapshot" JSONB NOT NULL,
    "status" "ExamAttemptStatus" NOT NULL DEFAULT 'in_progress',
    "startedAt" TIMESTAMP(3) NOT NULL,
    "deadlineAt" TIMESTAMP(3) NOT NULL,
    "submittedAt" TIMESTAMP(3),
    "submissionKind" "ExamSubmissionKind",
    "maxScore" INTEGER NOT NULL,
    "gradedAt" TIMESTAMP(3),
    "gradedById" UUID,
    "gradedByName" VARCHAR(200),
    "gradedVia" VARCHAR(20),
    "releasedAt" TIMESTAMP(3),
    "releasedById" UUID,
    "releasedByName" VARCHAR(200),
    "totalScore" DOUBLE PRECISION,
    "percent" DOUBLE PRECISION,
    "passed" BOOLEAN,
    "overallFeedback" TEXT,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ExamAttempt_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ExamAttempt_examId_traineeId_attemptNumber_key" ON "ExamAttempt"("examId", "traineeId", "attemptNumber");
CREATE INDEX "ExamAttempt_projectId_status_submittedAt_idx" ON "ExamAttempt"("projectId", "status", "submittedAt");
CREATE INDEX "ExamAttempt_examId_status_idx" ON "ExamAttempt"("examId", "status");
CREATE INDEX "ExamAttempt_traineeId_startedAt_idx" ON "ExamAttempt"("traineeId", "startedAt");
CREATE INDEX "ExamAttempt_status_deadlineAt_idx" ON "ExamAttempt"("status", "deadlineAt");
CREATE INDEX "ExamAttempt_gradedById_idx" ON "ExamAttempt"("gradedById");
CREATE INDEX "ExamAttempt_releasedById_idx" ON "ExamAttempt"("releasedById");
ALTER TABLE "ExamAttempt" ADD CONSTRAINT "ExamAttempt_examId_fkey" FOREIGN KEY ("examId") REFERENCES "Exam"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ExamAttempt" ADD CONSTRAINT "ExamAttempt_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ExamAttempt" ADD CONSTRAINT "ExamAttempt_traineeId_fkey" FOREIGN KEY ("traineeId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ExamAttempt" ADD CONSTRAINT "ExamAttempt_gradedById_fkey" FOREIGN KEY ("gradedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ExamAttempt" ADD CONSTRAINT "ExamAttempt_releasedById_fkey" FOREIGN KEY ("releasedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "ExamAnswer" (
    "id" UUID NOT NULL,
    "attemptId" UUID NOT NULL,
    "questionId" UUID NOT NULL,
    "kind" "ExamQuestionKind" NOT NULL,
    "selectedChoiceIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "text" TEXT,
    "sequence" INTEGER NOT NULL DEFAULT 0,
    "savedAt" TIMESTAMP(3) NOT NULL,
    "autoScore" DOUBLE PRECISION,
    "score" DOUBLE PRECISION,
    "rationale" TEXT,
    CONSTRAINT "ExamAnswer_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ExamAnswer_attemptId_questionId_key" ON "ExamAnswer"("attemptId", "questionId");
ALTER TABLE "ExamAnswer" ADD CONSTRAINT "ExamAnswer_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "ExamAttempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Only one unfinished attempt may exist per trainee and exam.
CREATE UNIQUE INDEX "ExamAttempt_open_attempt_key" ON "ExamAttempt"("examId", "traineeId") WHERE "status" = 'in_progress';
-- Keep persisted limits valid independently of request validation.
ALTER TABLE "Exam" ADD CONSTRAINT "Exam_timeLimit_check" CHECK ("timeLimitMinutes" BETWEEN 1 AND 1440), ADD CONSTRAINT "Exam_passingPercent_check" CHECK ("passingPercent" IS NULL OR "passingPercent" BETWEEN 0 AND 100);
ALTER TABLE "ExamQuestion" ADD CONSTRAINT "ExamQuestion_weight_check" CHECK ("weight" BETWEEN 1 AND 1000);
ALTER TABLE "ExamAnswer" ADD CONSTRAINT "ExamAnswer_score_check" CHECK ("score" IS NULL OR "score" >= 0);
