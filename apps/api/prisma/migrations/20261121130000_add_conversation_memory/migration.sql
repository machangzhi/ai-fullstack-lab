-- AlterTable
ALTER TABLE "conversations"
ADD COLUMN "historySummary" TEXT,
ADD COLUMN "summarizedMessages" INTEGER NOT NULL DEFAULT 0;
