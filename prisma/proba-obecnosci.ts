// Próba: ile wejść z karnetu schodzi za JEDEN trening.
//
// Regresja dla błędu, którego nie złapie test jednostkowy, bo cała rzecz dzieje
// się między zapisem obecności a licznikiem karnetu - w bazie, w transakcji.
//
// Co było zepsute: `markManualAttendance` zapisywało obecność przez `upsert`
// z pustym `update` (drugie wywołanie nie zmieniało nic), ale wejście z karnetu
// zdejmowało BEZWARUNKOWO. Klubowicz płacił dwa wejścia za jeden trening,
// w bazie zostawał jeden wpis obecności, więc nie było po czym tego poznać.
// Dróg do powtórzenia jest kilka i wszystkie codzienne: pozycja wracająca
// z kolejki po powrocie łącza, ekran trenera z listą sprzed odbicia na kiosku,
// dwa kliknięcia na wolnym wifi.
//
// Uruchamianie (tylko baza deweloperska - skrypt zakłada i kasuje dane):
//
//   Windows PowerShell:
//     $env:NODE_OPTIONS = "--conditions=react-server"
//     npx.cmd tsx prisma/proba-obecnosci.ts
//
// NODE_OPTIONS jest konieczne z tego samego powodu, co w proba-danych-demo.ts:
// warstwa usług jest oznaczona `server-only`.
//
// Skrypt sprząta po sobie także po nieudanej próbie.

import "dotenv/config";

// Poczta i push wyłączone - to jest próba, nie zdarzenie w klubie.
delete process.env.SMTP_HOST;
delete process.env.SMTP_USER;
delete process.env.SMTP_PASSWORD;

import { prisma } from "@/lib/prisma";
import { markManualAttendance } from "@/lib/services/attendance";

const WEJSCIA_NA_START = 10;

async function main() {
  const [member, sesja, plan, admin] = await Promise.all([
    prisma.member.findFirst({ where: { isDemo: false }, select: { id: true, joinedAt: true } }),
    prisma.session.findFirst({ where: { kind: "GROUP" }, select: { id: true } }),
    prisma.plan.findFirst({ where: { isDemo: false }, select: { id: true } }),
    prisma.user.findFirst({ where: { role: "ADMIN" }, select: { id: true } }),
  ]);

  if (!member || !sesja || !plan || !admin) {
    console.error("Baza deweloperska nie ma kompletu: klubowicz, zajęcia grupowe, plan, admin.");
    console.error("Odtwórz stan klubu: npx prisma db seed  oraz  npm run db:setup");
    process.exitCode = 1;
    return;
  }

  const teraz = new Date();
  let karnetId: string | null = null;
  let rezerwacjaId: string | null = null;

  try {
    const karnet = await prisma.pass.create({
      data: {
        memberId: member.id,
        planId: plan.id,
        priceGross: 0,
        startsAt: new Date(teraz.getTime() - 86_400_000),
        endsAt: new Date(teraz.getTime() + 30 * 86_400_000),
        entriesLeft: WEJSCIA_NA_START,
        soldByUserId: admin.id,
      },
      select: { id: true },
    });
    karnetId = karnet.id;

    const rezerwacja = await prisma.booking.create({
      data: { sessionId: sesja.id, memberId: member.id, status: "BOOKED" },
      select: { id: true },
    });
    rezerwacjaId = rezerwacja.id;

    console.log(`Karnet na start: ${WEJSCIA_NA_START} wejść.`);

    // Dwa razy to samo - dokładnie tak, jak robi to powtórzona wysyłka
    // z kolejki albo drugie kliknięcie trenera.
    await markManualAttendance({ bookingId: rezerwacja.id, byUserId: admin.id, at: teraz });
    console.log("Zaznaczono obecność (1).");
    await markManualAttendance({ bookingId: rezerwacja.id, byUserId: admin.id, at: teraz });
    console.log("Zaznaczono obecność (2) - to samo zdarzenie, powtórzone.");

    const [po, obecnosci] = await Promise.all([
      prisma.pass.findUniqueOrThrow({ where: { id: karnet.id }, select: { entriesLeft: true } }),
      prisma.attendance.count({ where: { sessionId: sesja.id, memberId: member.id } }),
    ]);

    const zeszlo = WEJSCIA_NA_START - (po.entriesLeft ?? 0);
    console.log(`\nWpisów obecności w bazie: ${obecnosci} (ma być 1)`);
    console.log(`Zeszło wejść z karnetu:   ${zeszlo} (ma być 1)`);

    if (obecnosci === 1 && zeszlo === 1) {
      console.log("\nOK: jeden trening = jedno wejście, mimo dwóch zapisów.");
    } else {
      console.error("\nBŁĄD: jeden trening zabrał klubowiczowi inną liczbę wejść niż jedno.");
      process.exitCode = 1;
    }
  } finally {
    // Sprzątanie w kolejności odwrotnej do zakładania - klucze obce są tu
    // w większości RESTRICT.
    await prisma.attendance.deleteMany({ where: { sessionId: sesja.id, memberId: member.id } });
    if (rezerwacjaId) await prisma.booking.deleteMany({ where: { id: rezerwacjaId } });
    if (karnetId) await prisma.pass.deleteMany({ where: { id: karnetId } });
    // markJoinedIfNeeded mogło ustawić datę dołączenia i założyć etapy
    // wdrożenia - przywracamy stan sprzed próby.
    if (!member.joinedAt) {
      await prisma.onboardingStep.deleteMany({ where: { memberId: member.id } });
      await prisma.member.update({ where: { id: member.id }, data: { joinedAt: null } });
    }
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
