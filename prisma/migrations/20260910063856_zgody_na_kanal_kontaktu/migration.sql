-- CreateEnum
CREATE TYPE "ContactChannel" AS ENUM ('SMS', 'EMAIL', 'PHONE_CALL');

-- CreateEnum
CREATE TYPE "ContactConsentSource" AS ENUM ('META_LEAD_ADS', 'ROZMOWA_TELEFONICZNA', 'FORMULARZ_WWW', 'PANEL_KLUBU');

-- CreateTable
CREATE TABLE "ContactConsent" (
    "id" TEXT NOT NULL,
    "leadId" TEXT,
    "memberId" TEXT,
    "channel" "ContactChannel" NOT NULL,
    "granted" BOOLEAN NOT NULL,
    "grantedAt" TIMESTAMPTZ NOT NULL,
    "recordedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recordedByUserId" TEXT,
    "source" "ContactConsentSource" NOT NULL,
    "textSnapshot" TEXT NOT NULL,
    "textVersion" TEXT NOT NULL,
    "note" TEXT,

    CONSTRAINT "ContactConsent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ContactConsent_leadId_channel_idx" ON "ContactConsent"("leadId", "channel");

-- CreateIndex
CREATE INDEX "ContactConsent_memberId_channel_idx" ON "ContactConsent"("memberId", "channel");

-- AddForeignKey
ALTER TABLE "ContactConsent" ADD CONSTRAINT "ContactConsent_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactConsent" ADD CONSTRAINT "ContactConsent_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactConsent" ADD CONSTRAINT "ContactConsent_recordedByUserId_fkey" FOREIGN KEY ("recordedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
