// Porządki we wpłatach: zostaw wskazane, usuń całą resztę.
//
//   npx tsx prisma/porzadki-wplat.ts --env .env.vercel
//       ^ sama lista wszystkich wpłat w bazie, nic nie zmienia
//
//   npx tsx prisma/porzadki-wplat.ts --env .env.vercel --klient "Monika Roterman" --klient "Natalia Bagnecka"
//       ^ próba na sucho: pokazuje, co zostanie i co zniknie
//
//   ...to samo z --usun na końcu  -> wykonanie
//
// Do czego to służy: sprzątanie wpłat testowych PRZED oddaniem systemu klubowi.
// To NIE jest narzędzie do codziennej pracy - pomyłkę w kasie poprawia się
// przyciskiem "Pomyłka - anuluj wpłatę" w panelu, który zostawia ślad. Tutaj
// kasujemy naprawdę i bezpowrotnie.
//
// Dlaczego to musi być skrypt, a nie przycisk: na `Payment` wskazują cztery
// referencje i wszystkie są `SetNull`, więc samo `DELETE` przejdzie i zostawi
// po sobie karty podarunkowe bez zapisu przychodu, osierocone realizacje
// i rozliczenia kasy z kwotą, której nie da się już odtworzyć. Ten skrypt
// sprząta to wszystko razem.
//
// `--klient` zostawia NAJNOWSZĄ wpłatę danej osoby (pomijając wpisy korygujące).
// Gdy trzeba zostawić inną, podaj wprost: `--zostaw <id wpłaty>`.

import { existsSync } from "node:fs";
import dotenv from "dotenv";
import { PrismaClient } from "../app/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { pickConnectionString } from "../lib/domain/connection-string";
import { todayInTimeZone } from "../lib/domain/time";

function args(name: string): string[] {
  const out: string[] = [];
  process.argv.forEach((a, i) => {
    if (a === name && process.argv[i + 1]) out.push(process.argv[i + 1]);
  });
  return out;
}

const envFile = args("--env")[0] ?? ".env";
const klienci = args("--klient");
const zostawIds = args("--zostaw");
const wykonaj = process.argv.includes("--usun");
const usunKarnety = process.argv.includes("--usun-osierocone-karnety");
const trybKarnety = process.argv.includes("--karnety-bez-wplat");
const trybWaznosc = process.argv.includes("--napraw-waznosc");
const karnetIds = args("--karnet");

if (!existsSync(envFile)) {
  console.error(`Nie znaleziono pliku z adresem bazy: ${envFile}`);
  process.exit(1);
}
dotenv.config({ path: envFile, override: true, quiet: true });

const connectionString = pickConnectionString(process.env);
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

const zl = (grosze: number) => `${(grosze / 100).toFixed(2)} zł`;
const dzien = (d: Date) => d.toISOString().slice(0, 10);

async function main() {
  console.log(`Baza: ${connectionString.replace(/:\/\/[^@]*@/, "://***@")} (z ${envFile})\n`);

  // Tryb osobny: karnet biegnie od DATY SPRZEDAZY, a nie od dnia wpisania.
  //
  // Naprawa dla karnetow sprzedanych, zanim system umial przesuwac waznosc
  // razem z data wplaty - albo takich, ktore stały w kolejce za karnetem
  // pozniej skasowanym i zostały z data startu wzieta z powietrza.
  //
  // NIE rusza karnetu, ktory legalnie stoi w kolejce za innym karnetem tego
  // samego klienta (SPEC.md sekcja 2: nowy startuje od konca starego, zeby nie
  // okradac klienta z dni). Rozpoznajemy to po tym, czy jakis inny karnet tej
  // osoby konczy sie dokladnie wtedy, gdy ten sie zaczyna.
  if (trybWaznosc) {
    const karnety = await prisma.pass.findMany({
      include: {
        member: { select: { id: true, firstName: true, lastName: true } },
        plan: { select: { name: true, durationDays: true } },
        payments: { orderBy: { recordedAt: "asc" }, take: 1 },
      },
      orderBy: { startsAt: "asc" },
    });

    const doPoprawy: { id: string; opis: string; startsAt: Date; endsAt: Date }[] = [];
    for (const k of karnety) {
      const pierwsza = k.payments[0];
      if (!pierwsza) continue;

      const poprzednik = karnety.some(
        (inny) =>
          inny.id !== k.id &&
          inny.memberId === k.memberId &&
          inny.endsAt.getTime() === k.startsAt.getTime(),
      );
      if (poprzednik) continue;

      if (dzien(k.startsAt) === dzien(pierwsza.recordedAt)) continue;

      const startsAt = pierwsza.recordedAt;
      const endsAt = new Date(startsAt.getTime() + k.plan.durationDays * 86_400_000);
      doPoprawy.push({
        id: k.id,
        startsAt,
        endsAt,
        opis:
          `${k.member.firstName} ${k.member.lastName} · "${k.plan.name}" · wplata ${dzien(pierwsza.recordedAt)}` +
          ` · bylo ${dzien(k.startsAt)}-${dzien(k.endsAt)} -> ma byc ${dzien(startsAt)}-${dzien(endsAt)}`,
      });
    }

    console.log(`Karnetow z waznoscia niezgodna z data wplaty: ${doPoprawy.length}\n`);
    for (const k of doPoprawy) console.log(`  ${k.opis}`);

    if (!wykonaj) {
      console.log(`\nTo byla proba na sucho - nic nie zostalo zmienione. Uruchom z --usun.`);
      return;
    }
    for (const k of doPoprawy) {
      await prisma.pass.update({
        where: { id: k.id },
        data: { startsAt: k.startsAt, endsAt: k.endsAt },
      });
    }
    console.log(`\nPoprawiono karnetow: ${doPoprawy.length}.`);
    return;
  }

  // Tryb osobny: karnety, na ktorych nie wisi ANI JEDNA wplata.
  //
  // Powstaja na dwa sposoby i tylko jeden z nich jest smieciem:
  //   - po skasowaniu wplaty (`Payment.passId` jest SetNull, wiec karnet
  //     zostaje) - wtedy kartoteka pokazuje kilka karnetow oplaconych jedna
  //     wplata,
  //   - albo legalnie: "karnet na potem" sprzedany z zerowa zaliczka; sellPass
  //     swiadomie nie tworzy wtedy wpisu w kasie.
  // Dlatego skrypt ich NIE kasuje hurtem - wypisuje i czeka na wskazanie
  // konkretnych przez --karnet <id>.
  if (trybKarnety) {
    const bezWplat = await prisma.pass.findMany({
      where: { payments: { none: {} } },
      include: {
        member: { select: { firstName: true, lastName: true } },
        plan: { select: { name: true } },
      },
      orderBy: { startsAt: "desc" },
    });
    console.log(`Karnetow bez ani jednej wplaty: ${bezWplat.length}\n`);
    for (const k of bezWplat) {
      console.log(
        `  ${k.id}  ${dzien(k.startsAt)}-${dzien(k.endsAt)}  ${zl(k.priceGross).padStart(10)}  ` +
          `${k.status.padEnd(9)} ${k.plan.name.padEnd(28)} ${k.member.firstName} ${k.member.lastName}`,
      );
    }
    if (karnetIds.length === 0) {
      console.log("\nWskaz, ktore skasowac: --karnet <id> (mozna wiele razy), potem --usun.");
      console.log("UWAGA: karnet sprzedany z zerowa zaliczka moze byc prawdziwy.");
      return;
    }
    const nieznane = karnetIds.filter((id) => !bezWplat.some((k) => k.id === id));
    if (nieznane.length > 0) {
      console.error(`\nBLAD: te id nie sa karnetami bez wplat: ${nieznane.join(", ")}. Przerywam.`);
      process.exitCode = 1;
      return;
    }
    const doKasacji = bezWplat.filter((k) => karnetIds.includes(k.id));
    console.log(`\nDO SKASOWANIA (${doKasacji.length}):`);
    for (const k of doKasacji) {
      console.log(`  "${k.plan.name}" - ${k.member.firstName} ${k.member.lastName}`);
    }
    if (!wykonaj) {
      console.log("\nTo byla proba na sucho - nic nie zostalo usuniete.");
      return;
    }
    await prisma.pass.deleteMany({ where: { id: { in: doKasacji.map((k) => k.id) } } });
    console.log(`\nSkasowano karnetow: ${doKasacji.length}.`);
    return;
  }

  const wszystkie = await prisma.payment.findMany({
    include: {
      member: { select: { firstName: true, lastName: true } },
      location: { select: { id: true, name: true } },
      pass: { select: { id: true, plan: { select: { name: true } } } },
      soldGiftCard: { select: { code: true } },
      giftRedemptions: { select: { id: true, giftCardId: true, amountGross: true } },
    },
    orderBy: { recordedAt: "desc" },
  });

  console.log(`Wpłat w bazie: ${wszystkie.length}\n`);
  for (const p of wszystkie) {
    const kto = `${p.member.firstName} ${p.member.lastName}`;
    const rodzaj = p.correctsPaymentId ? "KOREKTA" : "wpłata ";
    console.log(
      `  ${p.id}  ${dzien(p.recordedAt)}  ${rodzaj}  ${zl(p.amountGross).padStart(11)}  ` +
        `${p.method.padEnd(8)} ${p.location.name.padEnd(10)} ${kto}`,
    );
  }

  if (klienci.length === 0 && zostawIds.length === 0) {
    console.log('\nNie wskazano, co zostawić. Podaj --klient "Imię Nazwisko" albo --zostaw <id>.');
    return;
  }

  // Ustalenie, co zostaje.
  const zostaw = new Set(zostawIds);
  for (const nazwa of klienci) {
    const czesci = nazwa.trim().split(/\s+/);
    const kandydaci = wszystkie.filter(
      (p) =>
        p.correctsPaymentId === null &&
        czesci.every((c) =>
          `${p.member.firstName} ${p.member.lastName}`.toLowerCase().includes(c.toLowerCase()),
        ),
    );
    if (kandydaci.length === 0) {
      console.error(`\nBŁĄD: nie znalazłem żadnej wpłaty dla "${nazwa}". Przerywam.`);
      process.exitCode = 1;
      return;
    }
    // Najnowsza - lista jest posortowana malejąco po dacie.
    zostaw.add(kandydaci[0].id);
    if (kandydaci.length > 1) {
      console.log(
        `\nUwaga: "${nazwa}" ma ${kandydaci.length} wpłat. Zostawiam najnowszą ` +
          `(${dzien(kandydaci[0].recordedAt)}, ${zl(kandydaci[0].amountGross)}). ` +
          `Jeśli ma zostać inna - podaj --zostaw <id>.`,
      );
    }
  }

  const doUsuniecia = wszystkie.filter((p) => !zostaw.has(p.id));
  const zostajace = wszystkie.filter((p) => zostaw.has(p.id));

  console.log(`\n=== ZOSTAJE (${zostajace.length}) ===`);
  for (const p of zostajace) {
    console.log(
      `  ${dzien(p.recordedAt)}  ${zl(p.amountGross)}  ${p.method}  ` +
        `${p.member.firstName} ${p.member.lastName}` +
        (p.pass ? `  · karnet "${p.pass.plan.name}"` : ""),
    );
  }

  console.log(`\n=== DO USUNIĘCIA (${doUsuniecia.length}) ===`);
  const korekty = doUsuniecia.filter((p) => p.correctsPaymentId !== null).length;
  console.log(`  w tym wpisów korygujących: ${korekty}`);

  // Co jeszcze na tym wisi.
  const kartyWydane = doUsuniecia.filter((p) => p.soldGiftCard);
  const realizacje = doUsuniecia.flatMap((p) => p.giftRedemptions);
  const dniKasowe = new Map<string, { locationId: string; date: Date; nazwa: string }>();
  for (const p of doUsuniecia.filter((x) => x.method === "CASH")) {
    const d = todayInTimeZone(p.recordedAt);
    const klucz = `${p.location.id}|${d.year}-${d.month}-${d.day}`;
    dniKasowe.set(klucz, {
      locationId: p.location.id,
      date: new Date(Date.UTC(d.year, d.month - 1, d.day)),
      nazwa: `${p.location.name} ${dzien(p.recordedAt)}`,
    });
  }
  if (kartyWydane.length > 0) {
    console.log(
      `  karty podarunkowe sprzedane tymi wpłatami: ${kartyWydane.length} ` +
        `(${kartyWydane.map((p) => p.soldGiftCard!.code).join(", ")}) - zostaną wygaszone`,
    );
  }
  if (realizacje.length > 0) {
    console.log(`  realizacje kart do cofnięcia: ${realizacje.length} - saldo kart wróci`);
  }
  if (dniKasowe.size > 0) {
    console.log(`  dni kasowych do przeliczenia: ${dniKasowe.size}`);
  }

  // Karnety, które po usunięciu zostaną bez ani jednej wpłaty.
  const passIds = [...new Set(doUsuniecia.map((p) => p.passId).filter((x): x is string => !!x))];
  const osierocone: { id: string; nazwa: string; kto: string }[] = [];
  for (const passId of passIds) {
    const zostajaceWplaty = zostajace.filter((p) => p.passId === passId).length;
    if (zostajaceWplaty === 0) {
      const karnet = await prisma.pass.findUnique({
        where: { id: passId },
        include: { plan: { select: { name: true } }, member: true },
      });
      if (karnet) {
        osierocone.push({
          id: karnet.id,
          nazwa: karnet.plan.name,
          kto: `${karnet.member.firstName} ${karnet.member.lastName}`,
        });
      }
    }
  }
  if (osierocone.length > 0) {
    console.log(`\n  UWAGA: ${osierocone.length} karnetów zostanie BEZ WPŁATY (nieopłacone):`);
    for (const k of osierocone) console.log(`    "${k.nazwa}" - ${k.kto}`);
    console.log(
      "  Karnetów NIE kasuję - to osobna decyzja. Jeśli mają zniknąć, powiedz;\n" +
        "  inaczej zostaną w kartotece jako niedopłacone.",
    );
  }

  if (!wykonaj) {
    console.log("\nTo była próba na sucho - nic nie zostało usunięte.");
    console.log("Uruchom z --usun, żeby wykonać.");
    return;
  }

  await prisma.$transaction(async (tx) => {
    const ids = doUsuniecia.map((p) => p.id);

    // 1. Realizacje kart podarunkowych - saldo wraca na kartę.
    for (const r of realizacje) {
      await tx.giftCard.update({
        where: { id: r.giftCardId },
        data: { balanceGross: { increment: r.amountGross } },
      });
    }
    await tx.giftCardRedemption.deleteMany({ where: { paymentId: { in: ids } } });

    // 2. Karty wydane za usuwane wpłaty - nieopłacone, więc gasimy.
    for (const p of kartyWydane) {
      await tx.giftCard.updateMany({
        where: { soldPaymentId: p.id },
        data: { active: false, note: "Wpłata za kartę usunięta przy porządkach przed startem." },
      });
    }

    // 3. Same wpłaty. Najpierw korygujące, bo wskazują na inne wpłaty.
    await tx.payment.deleteMany({ where: { id: { in: ids }, correctsPaymentId: { not: null } } });
    await tx.payment.deleteMany({ where: { id: { in: ids } } });

    // 4. Karnety bez ani jednej wpłaty - tylko na wyraźne życzenie.
    //    Bez tego kartoteka pokazuje kilka karnetów opłaconych jedną wpłatą,
    //    bo `Payment.passId` jest SetNull i skasowanie wpłaty zostawia karnet
    //    wiszący w próżni. Rezerwacje, którym ten karnet pobrał wejście, tracą
    //    tylko wskazanie na niego (SetNull) - same obecności zostają.
    if (usunKarnety && osierocone.length > 0) {
      await tx.pass.deleteMany({ where: { id: { in: osierocone.map((k) => k.id) } } });
    }

    // 5. Dni kasowe - przeliczamy od zera na tym, co zostało.
    for (const d of dniKasowe.values()) {
      const dayStart = new Date(d.date);
      const dayEnd = new Date(d.date.getTime() + 86_400_000);
      const suma = await tx.payment.aggregate({
        where: {
          locationId: d.locationId,
          method: "CASH",
          recordedAt: { gte: dayStart, lt: dayEnd },
        },
        _sum: { amountGross: true },
      });
      const expectedGross = suma._sum.amountGross ?? 0;
      if (expectedGross === 0) {
        await tx.cashDay.deleteMany({ where: { locationId: d.locationId, date: d.date } });
      } else {
        await tx.cashDay.updateMany({
          where: { locationId: d.locationId, date: d.date },
          data: { expectedGross },
        });
      }
    }
  });

  const po = await prisma.payment.count();
  console.log(`\nUsunięto: ${doUsuniecia.length}. Wpłat w bazie po porządkach: ${po}.`);
  if (osierocone.length > 0) {
    console.log(
      usunKarnety
        ? `Skasowano karnetów bez wpłaty: ${osierocone.length}.`
        : `Karnetów bez wpłaty: ${osierocone.length} - zostały nietknięte.`,
    );
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
