// Próba cyklu danych demonstracyjnych: wgraj -> sprawdź -> usuń -> porównaj.
//
// To jest regresja dla najbardziej ryzykownego kodu w repozytorium. Sprawdza
// rzecz, której nie da się sprawdzić testem jednostkowym: że po wgraniu
// i usunięciu danych demonstracyjnych baza klubu jest DOKŁADNIE taka sama jak
// przed - co do liczby kartotek, wpłat, zajęć i kont.
//
// Uruchamianie (tylko baza deweloperska - skrypt wgrywa i kasuje):
//
//   Windows PowerShell:
//     $env:NODE_OPTIONS = "--conditions=react-server"
//     npx.cmd tsx prisma/proba-danych-demo.ts
//
// NODE_OPTIONS jest konieczne: warstwa usług jest oznaczona `server-only`,
// który poza Next.js rzuca wyjątkiem, dopóki nie włączy się warunek
// `react-server` przy rozwiązywaniu modułów.
//
// Skrypt sam po sobie sprząta - także po nieudanej próbie zostawia bazę
// w stanie sprzed uruchomienia.

import "dotenv/config";

// Poczta i push wyłączone na czas próby - to jest test, nie zdarzenie w klubie.
delete process.env.SMTP_HOST;
delete process.env.SMTP_USER;
delete process.env.SMTP_PASSWORD;

import { prisma } from "@/lib/prisma";
import { demoBlockers, demoStatus, removeDemoData } from "@/lib/services/demo-data";
import { loadDemoData } from "@/lib/services/demo-dataset";

async function migawkaKlubu() {
  const [
    czlonkowie,
    wplaty,
    zajecia,
    trenerzy,
    sale,
    plany,
    dniKasowe,
    aktywnosc,
    karnety,
    obecnosci,
    konta,
    oceny,
    notatki,
    zadania,
  ] = await Promise.all([
    prisma.member.count({ where: { isDemo: false } }),
    prisma.payment.count({ where: { member: { isDemo: false } } }),
    prisma.session.count({ where: { location: { isDemo: false } } }),
    prisma.trainer.count({ where: { user: { isDemo: false } } }),
    prisma.location.count({ where: { isDemo: false } }),
    prisma.plan.count(),
    prisma.cashDay.count(),
    prisma.activityLog.count(),
    prisma.pass.count({ where: { member: { isDemo: false } } }),
    prisma.attendance.count({ where: { member: { isDemo: false } } }),
    prisma.user.count({ where: { isDemo: false } }),
    prisma.rating.count({ where: { member: { isDemo: false } } }),
    prisma.note.count({ where: { member: { isDemo: false } } }),
    prisma.retentionTask.count({ where: { member: { isDemo: false } } }),
  ]);
  return {
    czlonkowie,
    wplaty,
    zajecia,
    trenerzy,
    sale,
    plany,
    dniKasowe,
    aktywnosc,
    karnety,
    obecnosci,
    konta,
    oceny,
    notatki,
    zadania,
  };
}

function porownaj(przed: Record<string, number>, po: Record<string, number>): string[] {
  const roznice: string[] = [];
  for (const klucz of Object.keys(przed)) {
    if (przed[klucz] !== po[klucz]) {
      roznice.push(`${klucz}: ${przed[klucz]} -> ${po[klucz]}`);
    }
  }
  return roznice;
}

async function main() {
  console.warn("=== 0. Stan klubu PRZED ===");
  const przed = await migawkaKlubu();
  console.warn(przed);

  const bylyDemo = await demoStatus();
  if (bylyDemo.present) {
    console.warn("\n! W bazie już są dane demo - sprzątam przed próbą.");
    console.warn(await removeDemoData());
  }

  console.warn("\n=== 1. Wgranie ===");
  const wgranie = await loadDemoData();
  console.warn(wgranie);
  if (!wgranie.ok) {
    await prisma.$disconnect();
    process.exit(1);
  }

  const stan = await demoStatus();
  console.warn("   spis:", stan.total, "rekordów, partia", stan.batchId);
  console.warn("   rozbicie:", stan.summary.map((s) => `${s.label}=${s.count}`).join(", "));

  console.warn("\n=== 2. Właściwości bezpieczeństwa ===");
  const [gotowka, kontaZHaslem, kontaAdmin, adresyPoza, salaDemo, publiczne] = await Promise.all([
    prisma.payment.count({ where: { member: { isDemo: true }, method: "CASH" } }),
    prisma.user.count({ where: { isDemo: true, passwordHash: { not: null } } }),
    prisma.user.count({ where: { isDemo: true, role: "ADMIN" } }),
    prisma.user.count({ where: { isDemo: true, NOT: { email: { endsWith: "@demo.invalid" } } } }),
    prisma.location.count({ where: { isDemo: true } }),
    // Dokładnie to zapytanie, którym publiczny harmonogram karmi stronę klubu.
    prisma.session.count({
      where: {
        kind: "GROUP",
        status: "SCHEDULED",
        startsAt: { gte: new Date() },
        location: { isDemo: false },
        name: { contains: "[DEMO]" },
      },
    }),
  ]);
  console.warn("   wpłaty gotówką (ma być 0):        ", gotowka);
  console.warn("   konta demo z hasłem (ma być 0):   ", kontaZHaslem);
  console.warn("   konta demo z rolą ADMIN (0):      ", kontaAdmin);
  console.warn("   adresy poza .invalid (0):         ", adresyPoza);
  console.warn("   sale demo (1):                    ", salaDemo);
  console.warn("   demo w publicznym harmonogramie(0):", publiczne);

  console.warn("\n=== 3. Odmowa, gdy doczepi się coś prawdziwego ===");
  const prawdziwy = await prisma.member.findFirst({ where: { isDemo: false } });
  const sesjaDemo = await prisma.session.findFirst({ where: { location: { isDemo: true } } });
  if (prawdziwy && sesjaDemo) {
    const zapis = await prisma.booking.create({
      data: { sessionId: sesjaDemo.id, memberId: prawdziwy.id, status: "BOOKED" },
    });
    const przeszkody = await demoBlockers();
    console.warn("   przeszkody:", przeszkody);
    const odmowa = await removeDemoData();
    console.warn("   próba usunięcia:", odmowa);
    await prisma.booking.delete({ where: { id: zapis.id } });
    console.warn("   (zapis testowy skasowany)");
  } else {
    console.warn("   pominięte - brak prawdziwej kartoteki albo zajęć demo");
  }

  console.warn("\n=== 4. Usunięcie ===");
  const usuniecie = await removeDemoData();
  console.warn(usuniecie);

  console.warn("\n=== 5. Stan klubu PO ===");
  const po = await migawkaKlubu();
  console.warn(po);
  const roznice = porownaj(przed, po);
  console.warn(
    roznice.length === 0
      ? "\nOK: dane klubu identyczne przed i po."
      : `\nUWAGA - różnice: ${roznice.join(" | ")}`,
  );

  const [spis, saleZ, memZ, usrZ] = await Promise.all([
    prisma.demoRecord.count(),
    prisma.location.count({ where: { isDemo: true } }),
    prisma.member.count({ where: { isDemo: true } }),
    prisma.user.count({ where: { isDemo: true } }),
  ]);
  console.warn(`resztki: spis=${spis} sale=${saleZ} kartoteki=${memZ} konta=${usrZ}`);

  await prisma.$disconnect();
}

void main();
