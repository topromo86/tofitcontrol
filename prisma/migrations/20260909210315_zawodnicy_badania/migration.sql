-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ActivityAction" ADD VALUE 'COMPETITOR_CHANGED';
ALTER TYPE "ActivityAction" ADD VALUE 'MEDICAL_EXAM_SET';

-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'MEDICAL_EXAM';

-- AlterTable
ALTER TABLE "Member" ADD COLUMN     "isCompetitor" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "medicalExamValidUntil" DATE;

-- AlterTable
ALTER TABLE "Trainer" ADD COLUMN     "isCompetitor" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "medicalExamValidUntil" DATE;
