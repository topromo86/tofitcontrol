import type { PrismaClient } from "@/app/generated/prisma/client";
import { shouldChurn } from "@/lib/domain/retention";

export type ChurnAndSurveyResult = { membersChecked: number; churned: number };

// SPEC.md sekcja 2 "Ankieta wyjścia": 21 dni bez obecności QR -> CHURNED +
// ChurnSurvey. Punkt odniesienia to ostatnia Attendance(method=QR); jeśli
// takiej nigdy nie było, spada na joinedAt (klient zapłacił/dołączył, ale
// nigdy fizycznie się nie pojawił). Idempotentny - status ACTIVE w filtrze
// wyklucza już przetworzonych klientów z kolejnych uruchomień.
export async function churnAndSurvey(
  prisma: PrismaClient,
  now: Date = new Date(),
): Promise<ChurnAndSurveyResult> {
  const activeMembers = await prisma.member.findMany({
    // isDemo: false - job przestawia status na CHURNED i zakłada ankietę,
    // czyli zmienia i tworzy rekordy poza spisem danych demonstracyjnych.
    where: { status: "ACTIVE", isDemo: false },
    include: {
      attendances: { where: { method: "QR" }, orderBy: { checkedInAt: "desc" }, take: 1 },
    },
  });

  let churned = 0;

  for (const member of activeMembers) {
    const referenceDate = member.attendances[0]?.checkedInAt ?? member.joinedAt;
    if (!shouldChurn(referenceDate, now)) continue;

    await prisma.$transaction([
      prisma.member.update({
        where: { id: member.id },
        data: { status: "CHURNED", churnedAt: now },
      }),
      prisma.churnSurvey.create({
        data: { memberId: member.id, sentAt: now },
      }),
    ]);
    churned++;
  }

  return { membersChecked: activeMembers.length, churned };
}
