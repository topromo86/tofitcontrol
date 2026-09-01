import type { PrismaClient } from "@/app/generated/prisma/client";
import { classifyInactivityAlert, daysSince } from "@/lib/domain/retention";

export type DetectInactiveResult = { membersChecked: number; tasksCreated: number };

// SPEC.md sekcja 2 "Alerty retencyjne": 7 dni bez treningu = zadanie dla
// trenera, 14 dni = eskalacja. Liczone od ostatniej obecności (dowolna
// metoda), nie od ostatniej rezerwacji (CLAUDE.md reguła 10). Idempotentny -
// nie tworzy drugiego otwartego zadania tego samego typu dla tego samego
// klienta. PLAN.md Faza 6: klient z aktywnym (nierozwiązanym) zgłoszeniem
// nieobecności/kontuzji jest pomijany - wiadomo już, dlaczego nie trenuje,
// suchy alert nic by nie wniósł.
export async function detectInactive(
  prisma: PrismaClient,
  now: Date = new Date(),
): Promise<DetectInactiveResult> {
  const activeMembers = await prisma.member.findMany({
    // isDemo: false - klient demonstracyjny nie ma dostawać alertu retencyjnego.
    // Job zakłada RetentionTask, którego spis danych demo nie zna, więc bez tego
    // filtra "usuń demo" zostawiałoby po sobie zadania dla trenera.
    where: { status: "ACTIVE", joinedAt: { not: null }, isDemo: false },
    include: {
      attendances: { orderBy: { checkedInAt: "desc" }, take: 1 },
      absenceReports: { where: { resolvedAt: null }, take: 1 },
    },
  });

  let tasksCreated = 0;

  for (const member of activeMembers) {
    if (member.absenceReports.length > 0) continue;
    const lastAttendance = member.attendances[0]?.checkedInAt ?? null;
    const alertType = classifyInactivityAlert(daysSince(lastAttendance, now));
    if (!alertType) continue;

    const existingOpen = await prisma.retentionTask.findFirst({
      where: { memberId: member.id, type: alertType, closedAt: null },
    });
    if (existingOpen) continue;

    await prisma.retentionTask.create({
      data: {
        memberId: member.id,
        trainerId: member.ownerTrainerId,
        type: alertType,
        dueAt: now,
        escalatedAt: alertType === "INACTIVE_14" ? now : null,
      },
    });
    tasksCreated++;
  }

  return { membersChecked: activeMembers.length, tasksCreated };
}
