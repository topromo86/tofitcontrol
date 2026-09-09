"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireMemberAccess } from "@/lib/auth/guard";

async function clientMeta() {
  const h = await headers();
  const ipAddress = h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "127.0.0.1";
  const userAgent = h.get("user-agent") ?? "unknown";
  return { ipAddress, userAgent };
}

export async function grantConsentAction(formData: FormData) {
  const memberId = String(formData.get("memberId"));
  const consentTypeId = String(formData.get("consentTypeId"));

  const session = await requireMemberAccess(memberId);
  const consentType = await prisma.consentType.findUniqueOrThrow({ where: { id: consentTypeId } });

  // Zgodę "tylko dla niepełnoletnich" (w praktyce: zgoda opiekuna prawnego)
  // podpisuje WYŁĄCZNIE konto opiekuna. Bez tego czternastolatek z własnym
  // loginem sam podpisywał oświadczenie opiekuna prawnego - `requireMemberAccess`
  // przepuszcza go jako "siebie", więc dostęp był, a podpis nic nie znaczył.
  if (consentType.forMinorsOnly) {
    const member = await prisma.member.findUniqueOrThrow({
      where: { id: memberId },
      select: { guardianUserId: true, isMinor: true },
    });
    if (member.isMinor && member.guardianUserId !== session.user.id) {
      redirect(
        `/app/zgody?member=${memberId}&blad=${encodeURIComponent(
          member.guardianUserId
            ? "Tę zgodę podpisuje wyłącznie rodzic lub opiekun prawny ze swojego konta."
            : "Ta kartoteka nie ma jeszcze przypisanego opiekuna - zgłoś to w klubie.",
        )}`,
      );
    }
  }

  const { ipAddress, userAgent } = await clientMeta();

  await prisma.consent.create({
    data: {
      memberId,
      consentTypeId,
      version: consentType.version,
      ipAddress,
      userAgent,
      grantedByUserId: session.user.id,
    },
  });

  redirect(`/app/zgody?member=${memberId}`);
}

export async function revokeConsentAction(formData: FormData) {
  const consentId = String(formData.get("consentId"));
  const memberId = String(formData.get("memberId"));

  await requireMemberAccess(memberId);

  // Zgoda musi należeć do TEJ kartoteki. Strażnik sprawdzał dostęp do
  // `memberId` z formularza, a kasowanie szło po `consentId` - czyli mając
  // dostęp do własnej kartoteki dało się wycofać cudzą zgodę, podając swoje
  // `memberId` i czyjeś `consentId`. Warunek w `where` zamyka to w bazie,
  // a nie w sprawdzeniu, które da się ominąć.
  const wynik = await prisma.consent.updateMany({
    where: { id: consentId, memberId },
    data: { revokedAt: new Date() },
  });
  if (wynik.count === 0) {
    redirect(
      `/app/zgody?member=${memberId}&blad=${encodeURIComponent("Nie znaleziono takiej zgody.")}`,
    );
  }

  redirect(`/app/zgody?member=${memberId}`);
}
