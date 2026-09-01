import type { PrismaClient } from "@/app/generated/prisma/client";
import { addCalendarDays, type CalendarDate, zonedTimeToUtc } from "@/lib/domain/time";

export type CloseCashDayResult = { locationsProcessed: number };

// SPEC.md sekcja 4 "closeCashDay": expectedGross = suma Payment(CASH) danego
// dnia per lokalizacja. Idempotentny - ponowne uruchomienie tylko przelicza
// expectedGross, nigdy nie rusza countedGross/closedAt/discrepancyNote, żeby
// nie nadpisać już wykonanego rozliczenia właściciela.
export async function closeCashDay(
  prisma: PrismaClient,
  date: CalendarDate,
): Promise<CloseCashDayResult> {
  const locations = await prisma.location.findMany();
  const dayStart = zonedTimeToUtc(date.year, date.month, date.day, 0, 0);
  const tomorrow = addCalendarDays(date, 1);
  const dayEnd = zonedTimeToUtc(tomorrow.year, tomorrow.month, tomorrow.day, 0, 0);
  const sqlDate = new Date(Date.UTC(date.year, date.month - 1, date.day));

  for (const location of locations) {
    // Sala pokazowa nie ma kasy do zamknięcia. Bez tego nocny job zakładałby
    // dla niej CashDay poza spisem danych demo - a przez RESTRICT ten wiersz
    // zablokowałby potem usunięcie sali.
    if (location.isDemo) continue;
    const sum = await prisma.payment.aggregate({
      where: {
        locationId: location.id,
        method: "CASH",
        recordedAt: { gte: dayStart, lt: dayEnd },
      },
      _sum: { amountGross: true },
    });
    const expectedGross = sum._sum.amountGross ?? 0;

    await prisma.cashDay.upsert({
      where: { locationId_date: { locationId: location.id, date: sqlDate } },
      create: { locationId: location.id, date: sqlDate, expectedGross },
      update: { expectedGross },
    });
  }

  return { locationsProcessed: locations.length };
}
