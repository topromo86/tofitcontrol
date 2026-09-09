-- AlterEnum
ALTER TYPE "ActivityAction" ADD VALUE 'TRAINER_CHECKIN_WAIVED';

-- AlterTable
ALTER TABLE "Session" ADD COLUMN     "trainerCheckInWaivedAt" TIMESTAMPTZ,
ADD COLUMN     "trainerCheckInWaivedByUserId" TEXT,
ADD COLUMN     "trainerCheckInWaivedNote" TEXT;
