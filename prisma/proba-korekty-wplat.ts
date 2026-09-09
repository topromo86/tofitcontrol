// Próba poprawiania pomyłek w kasie: anuluj wpłatę, data wsteczna, zamknięty dzień.
//
// Uruchamianie (tylko baza deweloperska - skrypt zakłada i kasuje dane):
//
//   Windows PowerShell:
//     $env:NODE_OPTIONS = "--conditions=react-server"
//     npx.cmd tsx prisma/proba-korekty-wplat.ts
//
// Sprawdza rzeczy, których nie złapie test jednostkowy, bo dzieją się między
// wpłatą, karnetem i dniem kasowym - czyli w bazie, w transakcji:
//
//   1. anulowanie wpłaty zeruje ją i zdejmuje z kasy tego samego dnia,
//   2. drugie anulowanie jest odrzucane (inaczej klient staje się dłużnikiem),
//   3. wpłata z datą wsteczną wchodzi do rozliczenia TAMTEGO dnia,
//   4. gotówki nie da się cofnąć z dnia, którego kasa jest już zamknięta,
//   5. nocny job nie rusza kwoty dnia zamkniętego.

import "dotenv/config";

delete process.env.SMTP_HOST;
delete process.env.SMTP_USER;
delete process.env.SMTP_PASSWORD;

import { prisma } from "@/lib/prisma";
import { sellPass } from "@/lib/services/pass";
import { cancelPayment, changePaymentDate } from "@/lib/services/payment-correction";
import { closeCashDay, recalcCashDay } from "@/lib/jobs/close-cash-day";
import { addCalendarDays, todayInTimeZone, zonedTimeToUtc } from "@/lib/domain/time";

let bledy = 0;
function sprawdz(opis: string, warunek: boolean, szczegol = "") {
  console.log(`  ${warunek ? "OK  " : "BŁĄD"}  ${opis}${szczegol ? ` (${szczegol})` : ""}`);
  if (!warunek) bledy++;
}

function sqlDay(d: { year: number; month: number; day: number }) {
  return new Date(Date.UTC(d.year, d.month - 1, d.day));
}

async function kasaDnia(locationId: string, d: { year: number; month: number; day: number }) {
  const dzien = await prisma.cashDay.findUnique({
    where: { locationId_date: { locationId, date: sqlDay(d) } },
    select: { expectedGross: true, closedAt: true },
  });
  return dzien ?? { expectedGross: 0, closedAt: null };
}

async function main() {
  const [admin, location, member] = await Promise.all([
    prisma.user.findFirst({ where: { role: "ADMIN" }, select: { id: true } }),
    prisma.location.findFirst({ where: { isDemo: false }, select: { id: true, name: true } }),
    prisma.member.findFirst({ where: { isDemo: false }, select: { id: true, isMinor: true } }),
  ]);
  if (!admin || !location || !member) {
    console.error("Baza deweloperska niekompletna. Uruchom: npx prisma db seed; npm run db:setup");
    process.exitCode = 1;
    return;
  }
  const plan = await prisma.plan.findFirst({
    where: { isDemo: false, forMinors: member.isMinor, priceGross: { gt: 0 } },
    select: { id: true, name: true, priceGross: true },
  });
  if (!plan) {
    console.error(
      "Brak planu pasującego do klubowicza. Uruchom: npx tsx prisma/reset-cennik.ts --usun",
    );
    process.exitCode = 1;
    return;
  }

  const teraz = new Date();
  const dzis = todayInTimeZone(teraz);
  const trzyDniTemu = addCalendarDays(dzis, -3);
  const dwaDniTemu = addCalendarDays(dzis, -2);
  const zalozonePasses: string[] = [];
  const zalozonePayments: string[] = [];
  const zalozeniKlubowicze: string[] = [];
  const dotknieteDni = [dzis, trzyDniTemu, dwaDniTemu];

  const kasaPrzed = await kasaDnia(location.id, dzis);

  try {
    console.log(`Sala: ${location.name} | plan: ${plan.name} (${plan.priceGross / 100} zł)\n`);

    console.log("=== 1. Wpłata gotówką na dziś ===");
    const sprzedaz = await prisma.$transaction((tx) =>
      sellPass(tx, {
        memberId: member.id,
        planId: plan.id,
        locationId: location.id,
        method: "CASH",
        actorUserId: admin.id,
        now: teraz,
      }),
    );
    zalozonePasses.push(sprzedaz.id);
    const wplata = await prisma.payment.findFirstOrThrow({
      where: { passId: sprzedaz.id },
      orderBy: { createdAt: "desc" },
    });
    zalozonePayments.push(wplata.id);
    await recalcCashDay(prisma, location.id, dzis);
    const kasaPoWplacie = await kasaDnia(location.id, dzis);
    sprawdz(
      "kasa dnia urosła o kwotę wpłaty",
      kasaPoWplacie.expectedGross === kasaPrzed.expectedGross + wplata.amountGross,
      `${kasaPrzed.expectedGross} -> ${kasaPoWplacie.expectedGross}`,
    );

    console.log("\n=== 2. Anulowanie pomyłki ===");
    const anul = await cancelPayment({
      paymentId: wplata.id,
      actorUserId: admin.id,
      note: "próba regresyjna - pomyłka przy kasie",
      now: new Date(),
    });
    sprawdz("anulowanie przyjęte", anul.ok);
    const saldo = await prisma.payment.aggregate({
      where: { OR: [{ id: wplata.id }, { correctsPaymentId: wplata.id }] },
      _sum: { amountGross: true },
    });
    sprawdz(
      "wpłata rozliczona do zera",
      (saldo._sum.amountGross ?? -1) === 0,
      String(saldo._sum.amountGross),
    );
    const kasaPoAnul = await kasaDnia(location.id, dzis);
    sprawdz(
      "kasa dnia wróciła do stanu sprzed wpłaty",
      kasaPoAnul.expectedGross === kasaPrzed.expectedGross,
      `${kasaPoAnul.expectedGross} vs ${kasaPrzed.expectedGross}`,
    );
    sprawdz(
      "właściciel ostrzeżony, że karnet został nieopłacony",
      Boolean(anul.ok && anul.ostrzezenie),
    );

    console.log("\n=== 3. Drugie anulowanie ===");
    const drugie = await cancelPayment({
      paymentId: wplata.id,
      actorUserId: admin.id,
      note: "próba regresyjna - drugie kliknięcie",
      now: new Date(),
    });
    sprawdz("odrzucone", !drugie.ok, drugie.ok ? "" : drugie.reason);

    console.log("\n=== 4. Wpłata z datą sprzed trzech dni ===");
    const kasaWsteczPrzed = await kasaDnia(location.id, trzyDniTemu);
    const wstecz = zonedTimeToUtc(trzyDniTemu.year, trzyDniTemu.month, trzyDniTemu.day, 12, 0);
    const sprzedaz2 = await prisma.$transaction(async (tx) => {
      const s = await sellPass(tx, {
        memberId: member.id,
        planId: plan.id,
        locationId: location.id,
        method: "CASH",
        actorUserId: admin.id,
        now: teraz,
        recordedAt: wstecz,
      });
      await recalcCashDay(tx, location.id, trzyDniTemu);
      return s;
    });
    zalozonePasses.push(sprzedaz2.id);
    const wplata2 = await prisma.payment.findFirstOrThrow({
      where: { passId: sprzedaz2.id },
      orderBy: { createdAt: "desc" },
    });
    zalozonePayments.push(wplata2.id);
    sprawdz("wpłata ma datę wsteczną", wplata2.recordedAt.getTime() === wstecz.getTime());
    sprawdz(
      "ale wpisana jest dzisiaj - ślad zostaje",
      Math.abs(wplata2.createdAt.getTime() - Date.now()) < 60_000,
    );
    const kasaWsteczPo = await kasaDnia(location.id, trzyDniTemu);
    sprawdz(
      "weszła do kasy TAMTEGO dnia",
      kasaWsteczPo.expectedGross === kasaWsteczPrzed.expectedGross + wplata2.amountGross,
      `${kasaWsteczPrzed.expectedGross} -> ${kasaWsteczPo.expectedGross}`,
    );

    console.log("\n=== 5. Zamknięty dzień jest nietykalny ===");
    await prisma.cashDay.update({
      where: { locationId_date: { locationId: location.id, date: sqlDay(trzyDniTemu) } },
      data: {
        closedAt: new Date(),
        closedByUserId: admin.id,
        countedGross: kasaWsteczPo.expectedGross,
      },
    });
    const proba = await cancelPayment({
      paymentId: wplata2.id,
      actorUserId: admin.id,
      note: "próba regresyjna - kasa zamknięta",
      now: new Date(),
    });
    sprawdz(
      "anulowanie gotówki z zamkniętego dnia odrzucone",
      !proba.ok && proba.reason === "KASA_ZAMKNIETA",
    );

    const przedJobem = await kasaDnia(location.id, trzyDniTemu);
    await closeCashDay(prisma, trzyDniTemu);
    const poJobie = await kasaDnia(location.id, trzyDniTemu);
    sprawdz(
      "nocny job nie zmienił kwoty dnia zamkniętego",
      poJobie.expectedGross === przedJobem.expectedGross,
      `${przedJobem.expectedGross} -> ${poJobie.expectedGross}`,
    );

    console.log("\n=== 6. Przeniesienie wplaty na inny dzien ===");
    // Wlasny klubowicz na te probe: karnet stojacy w kolejce za poprzednim ma
    // zostac nietkniety (SPEC.md sekcja 2), wiec przesuwania waznosci nie da
    // sie sprawdzic na kims, kto ma juz karnet z kroku 1.
    const trener = await prisma.trainer.findFirstOrThrow({ select: { id: true } });
    const member2 = await prisma.member.create({
      data: {
        firstName: "Próba",
        lastName: "Regresyjna",
        birthDate: new Date("1990-01-01"),
        isMinor: false,
        ownerTrainerId: trener.id,
        homeLocationId: location.id,
      },
      select: { id: true },
    });
    zalozeniKlubowicze.push(member2.id);
    const plan2 = plan;
    const sprzedaz3 = await prisma.$transaction((tx) =>
      sellPass(tx, {
        memberId: member2.id,
        planId: plan2.id,
        locationId: location.id,
        method: "CASH",
        actorUserId: admin.id,
        now: teraz,
      }),
    );
    zalozonePasses.push(sprzedaz3.id);
    const wplata3 = await prisma.payment.findFirstOrThrow({
      where: { passId: sprzedaz3.id },
      orderBy: { createdAt: "desc" },
    });
    zalozonePayments.push(wplata3.id);
    await recalcCashDay(prisma, location.id, dzis);

    const dzisPrzed = (await kasaDnia(location.id, dzis)).expectedGross;
    const celPrzed = (await kasaDnia(location.id, dwaDniTemu)).expectedGross;
    const iso = `${dwaDniTemu.year}-${String(dwaDniTemu.month).padStart(2, "0")}-${String(dwaDniTemu.day).padStart(2, "0")}`;

    const zmiana = await changePaymentDate({
      paymentId: wplata3.id,
      actorUserId: admin.id,
      rawDate: iso,
      now: new Date(),
    });
    sprawdz("zmiana daty przyjeta", zmiana.ok, zmiana.ok ? "" : zmiana.message);

    const po = await prisma.payment.findUniqueOrThrow({ where: { id: wplata3.id } });
    sprawdz(
      "data wplaty przesunieta",
      todayInTimeZone(po.recordedAt).day === dwaDniTemu.day,
      po.recordedAt.toISOString().slice(0, 10),
    );
    sprawdz(
      "data WPISANIA nietknieta - slad zostaje",
      po.createdAt.getTime() === wplata3.createdAt.getTime(),
    );
    const dzisPo = (await kasaDnia(location.id, dzis)).expectedGross;
    const celPo = (await kasaDnia(location.id, dwaDniTemu)).expectedGross;
    sprawdz(
      "kasa dnia zrodlowego zmniejszona",
      dzisPo === dzisPrzed - wplata3.amountGross,
      `${dzisPrzed} -> ${dzisPo}`,
    );
    sprawdz(
      "kasa dnia docelowego zwiekszona",
      celPo === celPrzed + wplata3.amountGross,
      `${celPrzed} -> ${celPo}`,
    );

    // Karnet jest wazny N dni OD SPRZEDAZY, wiec musi pojsc razem z wplata -
    // inaczej klient traci dni tylko dlatego, ze wlasciciel wpisal pieniadze
    // dzien pozniej.
    const karnetPo = await prisma.pass.findUniqueOrThrow({
      where: { id: sprzedaz3.id },
      include: { plan: { select: { durationDays: true } } },
    });
    sprawdz(
      "karnet zaczyna sie w nowej dacie wplaty",
      todayInTimeZone(karnetPo.startsAt).day === dwaDniTemu.day,
      karnetPo.startsAt.toISOString().slice(0, 10),
    );
    sprawdz(
      "waznosc karnetu przeliczona od nowa",
      karnetPo.endsAt.getTime() ===
        karnetPo.startsAt.getTime() + karnetPo.plan.durationDays * 86_400_000,
      `${karnetPo.startsAt.toISOString().slice(0, 10)} -> ${karnetPo.endsAt.toISOString().slice(0, 10)}`,
    );

    const wPrzyszlosc = await changePaymentDate({
      paymentId: wplata3.id,
      actorUserId: admin.id,
      rawDate: `${dzis.year}-${String(dzis.month).padStart(2, "0")}-${String(dzis.day + 1).padStart(2, "0")}`,
      now: new Date(),
    });
    sprawdz("data z przyszlosci odrzucona", !wPrzyszlosc.ok);
  } finally {
    // Sprzątanie w kolejności odwrotnej: najpierw korekty, potem wpłaty, karnety.
    await prisma.payment.deleteMany({ where: { correctsPaymentId: { in: zalozonePayments } } });
    await prisma.payment.deleteMany({ where: { passId: { in: zalozonePasses } } });
    await prisma.pass.deleteMany({ where: { id: { in: zalozonePasses } } });
    if (zalozeniKlubowicze.length > 0) {
      await prisma.activityLog.deleteMany({ where: { memberId: { in: zalozeniKlubowicze } } });
      await prisma.onboardingStep.deleteMany({ where: { memberId: { in: zalozeniKlubowicze } } });
      await prisma.member.deleteMany({ where: { id: { in: zalozeniKlubowicze } } });
    }
    for (const d of dotknieteDni) {
      await prisma.cashDay.deleteMany({ where: { locationId: location.id, date: sqlDay(d) } });
    }
    console.log("\nPosprzątane.");
  }

  console.log(bledy === 0 ? "\nOK: poprawianie pomyłek nie rozjeżdża kasy." : `\nBŁĘDÓW: ${bledy}`);
  if (bledy > 0) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
