import type { Pass, Member, PrismaClient } from "@/app/generated/prisma/client";
import { classifyRenewalStage } from "@/lib/domain/retention";

export type RenewalRemindersResult = { tasksCreated: number; tasksEscalated: number };

// SPEC.md sekcja 4 "renewalReminders". "Zadanie" (RetentionTask dla trenera)
// przy -3 dniach, "eskalacja" (jeśli zadanie wciąż otwarte) przy +3 dniach -
// patrz lib/domain/retention.ts#classifyRenewalStage dla pełnego wyjaśnienia
// kroku "-5 dni powiadomienie". Idempotentny: nigdy nie tworzy drugiego
// otwartego RENEWAL dla tego samego klienta, eskalacja dogania brakujące
// zadanie zamiast go pomijać (na wypadek przerwy w uruchamianiu joba).
export async function renewalReminders(
  prisma: PrismaClient,
  now: Date = new Date(),
): Promise<RenewalRemindersResult> {
  const windowStart = new Date(now.getTime() - 7 * 86_400_000);
  const windowEnd = new Date(now.getTime() + 7 * 86_400_000);

  const passes = await prisma.pass.findMany({
    where: {
      status: { in: ["ACTIVE", "EXPIRED"] },
      endsAt: { gte: windowStart, lte: windowEnd },
      // isDemo: false - job zakłada zadanie RENEWAL i wysyła powiadomienie.
      // Jedno i drugie dotyczyłoby osoby, która nie istnieje.
      member: { status: "ACTIVE", isDemo: false },
    },
    include: { member: true },
    orderBy: { endsAt: "desc" },
  });

  // Jeden karnet per klient - jeśli w oknie jest więcej niż jeden (np. świeżo
  // sprzedany kolejny), liczy się najpóźniejszy.
  const latestPassByMember = new Map<string, Pass & { member: Member }>();
  for (const pass of passes) {
    if (!latestPassByMember.has(pass.memberId)) {
      latestPassByMember.set(pass.memberId, pass);
    }
  }

  let tasksCreated = 0;
  let tasksEscalated = 0;

  for (const pass of latestPassByMember.values()) {
    const stage = classifyRenewalStage(pass.endsAt, now);
    if (!stage) continue;

    const existingOpen = await prisma.retentionTask.findFirst({
      where: { memberId: pass.memberId, type: "RENEWAL", closedAt: null },
    });

    if (stage === "TASK") {
      if (existingOpen) continue;
      await prisma.retentionTask.create({
        data: {
          memberId: pass.memberId,
          trainerId: pass.member.ownerTrainerId,
          type: "RENEWAL",
          dueAt: pass.endsAt,
        },
      });
      tasksCreated++;
      continue;
    }

    // stage === "ESCALATE"
    if (existingOpen) {
      if (existingOpen.escalatedAt) continue;
      await prisma.retentionTask.update({
        where: { id: existingOpen.id },
        data: { escalatedAt: now },
      });
    } else {
      await prisma.retentionTask.create({
        data: {
          memberId: pass.memberId,
          trainerId: pass.member.ownerTrainerId,
          type: "RENEWAL",
          dueAt: pass.endsAt,
          escalatedAt: now,
        },
      });
    }
    tasksEscalated++;
  }

  return { tasksCreated, tasksEscalated };
}
