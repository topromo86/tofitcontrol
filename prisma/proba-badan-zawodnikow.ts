// Próba przypominania o badaniach zawodnika.
//
// Uruchamianie (tylko baza deweloperska - skrypt zakłada i kasuje dane):
//
//   Windows PowerShell:
//     $env:NODE_OPTIONS = "--conditions=react-server"
//     npx.cmd tsx prisma/proba-badan-zawodnikow.ts
//
// Sprawdza to, czego nie złapie test jednostkowy, bo dzieje się między
// kartoteką, zadaniem nocnym i dziennikiem wysyłek:
//
//   1. zawodnikowi z badaniami kończącymi się za 10 dni NALEŻY się przypomnienie,
//   2. kto nie jest oznaczony jako zawodnik, nie wchodzi do wysyłki,
//   3. po terminie przypomnienie już nie idzie - wtedy jest inna rozmowa.
//
// Czego ta próba NIE sprawdza i dlaczego: samej wysyłki i jej idempotencji.
// `notify` zwalnia rezerwację, gdy żaden kanał nie zadziała (świadomie - patrz
// lib/services/notification.ts), a w próbie SMTP jest wyłączony i nie ma
// subskrypcji push, więc nic nie wychodzi i nic nie ląduje w dzienniku.
// Idempotencja stoi na kluczu `subjectId` i unikacie w bazie - tym samym,
// z którego korzystają cztery pozostałe typy powiadomień.

import "dotenv/config";

delete process.env.SMTP_HOST;
delete process.env.SMTP_USER;
delete process.env.SMTP_PASSWORD;

import { prisma } from "@/lib/prisma";
import { medicalExams } from "@/lib/jobs/medical-exams";

let bledy = 0;
function sprawdz(opis: string, warunek: boolean, szczegol = "") {
  console.log(`  ${warunek ? "OK  " : "BŁĄD"}  ${opis}${szczegol ? ` (${szczegol})` : ""}`);
  if (!warunek) bledy++;
}

const zaDni = (n: number) => {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + n);
  return d;
};

async function main() {
  const [trener, sala, admin] = await Promise.all([
    prisma.trainer.findFirst({ select: { id: true } }),
    prisma.location.findFirst({ where: { isDemo: false }, select: { id: true } }),
    prisma.user.findFirst({ where: { role: "ADMIN", isDemo: false }, select: { id: true } }),
  ]);
  if (!trener || !sala || !admin) {
    console.error("Baza deweloperska niekompletna. Uruchom: npm run db:setup");
    process.exitCode = 1;
    return;
  }

  const konta: string[] = [];
  const kartoteki: string[] = [];

  try {
    const konto = await prisma.user.create({
      data: {
        email: `proba-zawodnik-${Date.now()}@example.invalid`,
        name: "Próba Zawodnik",
        role: "MEMBER",
      },
      select: { id: true },
    });
    konta.push(konto.id);

    const zawodnik = await prisma.member.create({
      data: {
        firstName: "Próba",
        lastName: "Zawodnik",
        birthDate: new Date("1998-04-04"),
        isMinor: false,
        userId: konto.id,
        ownerTrainerId: trener.id,
        homeLocationId: sala.id,
        isCompetitor: true,
        medicalExamValidUntil: zaDni(10),
      },
      select: { id: true },
    });
    kartoteki.push(zawodnik.id);

    // Ktoś, kto zawodnikiem nie jest - z taką samą datą.
    const nieZawodnik = await prisma.member.create({
      data: {
        firstName: "Próba",
        lastName: "Rekreacja",
        birthDate: new Date("1995-01-01"),
        isMinor: false,
        ownerTrainerId: trener.id,
        homeLocationId: sala.id,
        isCompetitor: false,
        medicalExamValidUntil: zaDni(10),
      },
      select: { id: true },
    });
    kartoteki.push(nieZawodnik.id);

    console.log("=== 1. Termin za 10 dni ===");
    const pierwsze = await medicalExams(prisma);
    console.log(`  sprawdzonych=${pierwsze.checked} nalezy-sie=${pierwsze.due}`);
    sprawdz("zawodnikowi nalezy sie przypomnienie", pierwsze.due === 1, String(pierwsze.due));
    sprawdz(
      "kto nie jest zawodnikiem, nie wchodzi nawet do sprawdzania",
      pierwsze.checked === 1,
      String(pierwsze.checked),
    );

    console.log("\n=== 2. Termin daleki - jeszcze nie przypominamy ===");
    await prisma.member.update({
      where: { id: zawodnik.id },
      data: { medicalExamValidUntil: zaDni(40) },
    });
    const daleki = await medicalExams(prisma);
    sprawdz("40 dni przed - cisza", daleki.due === 0, String(daleki.due));

    console.log("\n=== 3. Po terminie - tez cisza ===");
    await prisma.member.update({
      where: { id: zawodnik.id },
      data: { medicalExamValidUntil: zaDni(-1) },
    });
    const poTerminie = await medicalExams(prisma);
    sprawdz("po wygasnieciu nie przypominamy", poTerminie.due === 0, String(poTerminie.due));

    console.log("\n=== 4. Dzien wygasniecia jeszcze sie liczy ===");
    await prisma.member.update({
      where: { id: zawodnik.id },
      data: { medicalExamValidUntil: zaDni(0) },
    });
    const dzisiaj = await medicalExams(prisma);
    sprawdz("w dniu konca przypominamy", dzisiaj.due === 1, String(dzisiaj.due));
  } finally {
    await prisma.notificationLog.deleteMany({
      where: {
        OR: [
          { userId: { in: konta } },
          { type: "MEDICAL_EXAM", subjectId: { in: [] } },
          ...kartoteki.map((id) => ({ subjectId: { contains: id } })),
        ],
      },
    });
    await prisma.activityLog.deleteMany({ where: { memberId: { in: kartoteki } } });
    await prisma.member.deleteMany({ where: { id: { in: kartoteki } } });
    await prisma.user.deleteMany({ where: { id: { in: konta } } });
    console.log("\nPosprzątane.");
  }

  console.log(
    bledy === 0 ? "\nOK: przypomnienia o badaniach nie spamują i nie gubią." : `\nBŁĘDÓW: ${bledy}`,
  );
  if (bledy > 0) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
