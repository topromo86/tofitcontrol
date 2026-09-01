-- AlterTable
ALTER TABLE "Location" ADD COLUMN     "isDemo" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Member" ADD COLUMN     "isDemo" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "isDemo" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "DemoRecord" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "recordId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DemoRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DemoRecord_batchId_seq_idx" ON "DemoRecord"("batchId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "DemoRecord_model_recordId_key" ON "DemoRecord"("model", "recordId");
