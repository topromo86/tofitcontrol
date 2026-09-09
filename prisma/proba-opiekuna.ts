// Próba powiązania rodzic-dziecko: przypisz, odmów, odepnij.
//
// Uruchamianie (tylko baza deweloperska - skrypt zakłada i kasuje dane):
//
//   Windows PowerShell:
//     $env:NODE_OPTIONS = "--conditions=react-server"
//     npx.cmd tsx prisma/proba-opiekuna.ts
//
// Sprawdza rzeczy, których nie złapie test jednostkowy, bo dotyczą DOSTĘPU do
// danych dziecka i dzieją się w bazie:
//
//   1. przypisanie rodzica do kartoteki dziecka działa,
//   2. zgoda opiekuna podpisana przez SAMO DZIECKO traci ważność przy
//      przypisaniu rodzica - podpisał ją ktoś, kto nie mógł,
//   3. nie da się przypisać opiekuna do kartoteki osoby PEŁNOLETNIEJ
//      (jedno kliknięcie oddałoby obcemu człowiekowi cudzą kartotekę),
//   4. nie da się przypisać drugiego opiekuna bez odpięcia pierwszego,
//   5. konto nie może być opiekunem samego siebie,
//   6. odpięcie działa i zostawia ślad w historii.

import "dotenv/config";

delete process.env.SMTP_HOST;
delete process.env.SMTP_USER;
delete process.env.SMTP_PASSWORD;

import { prisma } from "@/lib/prisma";
import { linkGuardian, unlinkGuardian } from "@/lib/services/guardian";
import { recalcMinorStatus } from "@/lib/jobs/recalc-minor-status";

let bledy = 0;
function sprawdz(opis: string, warunek: boolean, szczegol = "") {
  console.log(`  ${warunek ? "OK  " : "BŁĄD"}  ${opis}${szczegol ? ` (${szczegol})` : ""}`);
  if (!warunek) bledy++;
}

const latTemu = (n: number) => new Date(Date.now() - n * 365.25 * 86_400_000);

async function main() {
  const [admin, trener, sala] = await Promise.all([
    prisma.user.findFirst({ where: { role: "ADMIN" }, select: { id: true } }),
    prisma.trainer.findFirst({ select: { id: true } }),
    prisma.location.findFirst({ where: { isDemo: false }, select: { id: true } }),
  ]);
  if (!admin || !trener || !sala) {
    console.error("Baza deweloperska niekompletna. Uruchom: npm run db:setup");
    process.exitCode = 1;
    return;
  }

  const konta: string[] = [];
  const kartoteki: string[] = [];

  try {
    const rodzic = await prisma.user.create({
      data: {
        email: `proba-rodzic-${Date.now()}@example.invalid`,
        name: "Próba Rodzic",
        role: "MEMBER",
      },
      select: { id: true },
    });
    konta.push(rodzic.id);

    const dziecko = await prisma.member.create({
      data: {
        firstName: "Próba",
        lastName: "Dziecko",
        birthDate: latTemu(12),
        isMinor: true,
        ownerTrainerId: trener.id,
        homeLocationId: sala.id,
      },
      select: { id: true },
    });
    kartoteki.push(dziecko.id);

    // Zgoda opiekuna podpisana przez samo dziecko - stan, w jakim jest dziś
    // część kartotek w klubie.
    const typZgody = await prisma.consentType.findFirst({ where: { forMinorsOnly: true } });
    let zgodaId: string | null = null;
    if (typZgody) {
      const zgoda = await prisma.consent.create({
        data: {
          memberId: dziecko.id,
          consentTypeId: typZgody.id,
          version: typZgody.version,
          ipAddress: "127.0.0.1",
          userAgent: "proba",
          grantedByUserId: admin.id,
        },
        select: { id: true },
      });
      zgodaId = zgoda.id;
    }

    console.log("=== 1. Przypisanie rodzica ===");
    const wynik = await linkGuardian({
      memberId: dziecko.id,
      guardianUserId: rodzic.id,
      actorUserId: admin.id,
    });
    sprawdz("przypisanie przyjęte", wynik.ok, wynik.ok ? "" : wynik.reason);
    const poPrzypisaniu = await prisma.member.findUniqueOrThrow({
      where: { id: dziecko.id },
      select: { guardianUserId: true },
    });
    sprawdz("kartoteka wskazuje konto rodzica", poPrzypisaniu.guardianUserId === rodzic.id);

    if (zgodaId) {
      const zgoda = await prisma.consent.findUniqueOrThrow({ where: { id: zgodaId } });
      sprawdz("zgoda podpisana nie przez rodzica została wycofana", zgoda.revokedAt !== null);
    }

    console.log("\n=== 2. Odmowy ===");
    const drugiRaz = await linkGuardian({
      memberId: dziecko.id,
      guardianUserId: rodzic.id,
      actorUserId: admin.id,
    });
    sprawdz(
      "drugi opiekun bez odpięcia pierwszego - odmowa",
      !drugiRaz.ok && drugiRaz.reason === "MA_JUZ_OPIEKUNA",
    );

    const dorosly = await prisma.member.create({
      data: {
        firstName: "Próba",
        lastName: "Dorosla",
        birthDate: latTemu(30),
        isMinor: false,
        ownerTrainerId: trener.id,
        homeLocationId: sala.id,
      },
      select: { id: true },
    });
    kartoteki.push(dorosly.id);
    const naDoroslego = await linkGuardian({
      memberId: dorosly.id,
      guardianUserId: rodzic.id,
      actorUserId: admin.id,
    });
    sprawdz(
      "opiekun dla osoby pełnoletniej - odmowa",
      !naDoroslego.ok && naDoroslego.reason === "PELNOLETNI",
      naDoroslego.ok ? "PRZESZŁO - to oddaje cudzą kartotekę" : "",
    );

    // Dziecko z własnym loginem, próbujące być swoim opiekunem.
    const kontoDziecka = await prisma.user.create({
      data: {
        email: `proba-dziecko-${Date.now()}@example.invalid`,
        name: "Próba Dziecko",
        role: "MEMBER",
      },
      select: { id: true },
    });
    konta.push(kontoDziecka.id);
    const drugieDziecko = await prisma.member.create({
      data: {
        firstName: "Próba",
        lastName: "Samo",
        birthDate: latTemu(15),
        isMinor: true,
        userId: kontoDziecka.id,
        ownerTrainerId: trener.id,
        homeLocationId: sala.id,
      },
      select: { id: true },
    });
    kartoteki.push(drugieDziecko.id);
    const samoSobie = await linkGuardian({
      memberId: drugieDziecko.id,
      guardianUserId: kontoDziecka.id,
      actorUserId: admin.id,
    });
    sprawdz(
      "konto nie może być opiekunem samego siebie",
      !samoSobie.ok && samoSobie.reason === "TO_SAMO_KONTO",
    );

    console.log("\n=== 3. Odpięcie ===");
    const odpiete = await unlinkGuardian({
      memberId: dziecko.id,
      actorUserId: admin.id,
      reason: "próba regresyjna",
    });
    sprawdz("odpięcie przyjęte", odpiete.ok);
    const poOdpieciu = await prisma.member.findUniqueOrThrow({
      where: { id: dziecko.id },
      select: { guardianUserId: true },
    });
    sprawdz("kartoteka nie ma już opiekuna", poOdpieciu.guardianUserId === null);
    const slad = await prisma.activityLog.count({
      where: { memberId: dziecko.id, action: { in: ["GUARDIAN_LINKED", "GUARDIAN_UNLINKED"] } },
    });
    sprawdz("obie operacje zostawiły ślad w historii", slad === 2, String(slad));

    console.log("\n=== 4. Po odpięciu da się przypisać nowego ===");
    const ponownie = await linkGuardian({
      memberId: dziecko.id,
      guardianUserId: rodzic.id,
      actorUserId: admin.id,
    });
    sprawdz("przypisanie po odpięciu działa", ponownie.ok);

    console.log("\n=== 5. Powiazanie wygasa w 18. urodziny ===");
    // Data urodzenia dokladnie 18 lat temu: dzis konczy 18 lat.
    const osiemnastka = new Date();
    osiemnastka.setFullYear(osiemnastka.getFullYear() - 18);
    const prawieDorosly = await prisma.member.create({
      data: {
        firstName: "Próba",
        lastName: "Osiemnastka",
        birthDate: osiemnastka,
        isMinor: true,
        ownerTrainerId: trener.id,
        homeLocationId: sala.id,
        guardianUserId: rodzic.id,
      },
      select: { id: true },
    });
    kartoteki.push(prawieDorosly.id);

    const wynikJoba = await recalcMinorStatus(prisma);
    const poUrodzinach = await prisma.member.findUniqueOrThrow({
      where: { id: prawieDorosly.id },
      select: { isMinor: true, guardianUserId: true },
    });
    sprawdz("status pelnoletnosci przeliczony", poUrodzinach.isMinor === false);
    sprawdz(
      "powiazanie z rodzicem WYGASLO",
      poUrodzinach.guardianUserId === null,
      poUrodzinach.guardianUserId ?? "",
    );
    sprawdz("job zaraportowal wygasniecie", wynikJoba.expiredGuardianships >= 1);
    const sladWygasniecia = await prisma.activityLog.count({
      where: { memberId: prawieDorosly.id, action: "GUARDIAN_UNLINKED" },
    });
    sprawdz("zostal slad w historii", sladWygasniecia === 1, String(sladWygasniecia));

    // Powrotu nie ma: przypisanie dziala wylacznie dla niepelnoletnich.
    const proba = await linkGuardian({
      memberId: prawieDorosly.id,
      guardianUserId: rodzic.id,
      actorUserId: admin.id,
    });
    sprawdz(
      "po 18. urodzinach nie da sie przypisac opiekuna z powrotem",
      !proba.ok && proba.reason === "PELNOLETNI",
    );
  } finally {
    await prisma.activityLog.deleteMany({ where: { memberId: { in: kartoteki } } });
    await prisma.consent.deleteMany({ where: { memberId: { in: kartoteki } } });
    await prisma.member.deleteMany({ where: { id: { in: kartoteki } } });
    await prisma.user.deleteMany({ where: { id: { in: konta } } });
    console.log("\nPosprzątane.");
  }

  console.log(
    bledy === 0 ? "\nOK: powiązanie rodzic-dziecko trzyma się reguł." : `\nBŁĘDÓW: ${bledy}`,
  );
  if (bledy > 0) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
