import type { PrismaClient, Prisma } from "@/app/generated/prisma/client";

// Działa i na kliencie, i wewnątrz transakcji - korekta musi przeliczyć kasę
// w tej samej transakcji, w której zmienia wpłatę.
type Db = PrismaClient | Prisma.TransactionClient;
import { addCalendarDays, type CalendarDate, zonedTimeToUtc } from "@/lib/domain/time";

export type CloseCashDayResult = { locationsProcessed: number };

// SPEC.md sekcja 4 "closeCashDay": expectedGross = suma Payment(CASH) danego
// dnia per lokalizacja. Idempotentny - ponowne uruchomienie tylko przelicza
// expectedGross, nigdy nie rusza countedGross/closedAt/discrepancyNote, żeby
// nie nadpisać już wykonanego rozliczenia właściciela.
//
// DZIEŃ ZAMKNIĘTY JEST NIETYKALNY. Wcześniej `update` szedł bezwarunkowo, więc
// wpłata albo korekta zrobiona po zamknięciu podmieniała oczekiwaną kwotę
// w rozliczeniu, którego w tym systemie NIE DA SIĘ otworzyć - właściciel
// widział nazajutrz czerwone manko, którego wieczorem nie było, i nie miał
// jak dojść, skąd się wzięło. Kwota, wobec której zamykał dzień, ma zostać
// taka, jaką widział.
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

    const istniejacy = await prisma.cashDay.findUnique({
      where: { locationId_date: { locationId: location.id, date: sqlDate } },
      select: { closedAt: true },
    });
    if (istniejacy?.closedAt) continue;

    await prisma.cashDay.upsert({
      where: { locationId_date: { locationId: location.id, date: sqlDate } },
      create: { locationId: location.id, date: sqlDate, expectedGross },
      update: { expectedGross },
    });
  }

  return { locationsProcessed: locations.length };
}

// Przeliczenie kasy JEDNEJ sali w JEDNYM dniu - wołane zaraz po wpłacie albo
// korekcie z datą inną niż dzisiejsza.
//
// Bez tego wpłata z datą wsteczną nie weszłaby do rozliczenia tamtego dnia
// NIGDY: nocny job liczy wyłącznie dzień, w którym się odpala, i nigdy nie
// wraca do poprzednich. Pieniądze byłyby widoczne w Finansach i niewidoczne
// w kasie - czyli dokładnie tam, gdzie właściciel je liczy.
//
// Zamkniętego dnia nie rusza (patrz wyżej); zwraca `false`, żeby wołający
// wiedział, że musi odmówić, zamiast zapisać wpłatę, której kasa nie zobaczy.
export async function recalcCashDay(
  db: Db,
  locationId: string,
  date: CalendarDate,
): Promise<boolean> {
  const dayStart = zonedTimeToUtc(date.year, date.month, date.day, 0, 0);
  const tomorrow = addCalendarDays(date, 1);
  const dayEnd = zonedTimeToUtc(tomorrow.year, tomorrow.month, tomorrow.day, 0, 0);
  const sqlDate = new Date(Date.UTC(date.year, date.month - 1, date.day));

  const istniejacy = await db.cashDay.findUnique({
    where: { locationId_date: { locationId, date: sqlDate } },
    select: { closedAt: true },
  });
  if (istniejacy?.closedAt) return false;

  const sum = await db.payment.aggregate({
    where: { locationId, method: "CASH", recordedAt: { gte: dayStart, lt: dayEnd } },
    _sum: { amountGross: true },
  });

  await db.cashDay.upsert({
    where: { locationId_date: { locationId, date: sqlDate } },
    create: { locationId, date: sqlDate, expectedGross: sum._sum.amountGross ?? 0 },
    update: { expectedGross: sum._sum.amountGross ?? 0 },
  });
  return true;
}

// Czy kasa danej sali w danym dniu jest już zamknięta. Osobno, bo pytają o to
// strażnicy PRZED zapisem - odmowa jest tańsza niż zapis, którego nikt nie
// zobaczy w rozliczeniu.
export async function isCashDayClosed(
  db: Db,
  locationId: string,
  date: CalendarDate,
): Promise<boolean> {
  const sqlDate = new Date(Date.UTC(date.year, date.month - 1, date.day));
  const dzien = await db.cashDay.findUnique({
    where: { locationId_date: { locationId, date: sqlDate } },
    select: { closedAt: true },
  });
  return Boolean(dzien?.closedAt);
}
