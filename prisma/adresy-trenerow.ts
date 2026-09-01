// Wymiana adresów e-mail kadry trenerskiej na adresy prywatne podane przez klub.
//
//   npx tsx prisma/adresy-trenerow.ts                       <- dev, tylko podgląd
//   npx tsx prisma/adresy-trenerow.ts --ustaw               <- dev, wykonanie
//   npx tsx prisma/adresy-trenerow.ts --env .env.vercel     <- produkcja, podgląd
//   npx tsx prisma/adresy-trenerow.ts --env .env.vercel --ustaw
//
// Powód: konta kadry powstały z adresami @czaplaboxing.pl wymyślonymi przez
// skrypt zakładający trenerów (prisma/add-real-trainers.ts). Ta domena nie ma
// skrzynek, więc reset hasła i powiadomienia nie mają dokąd dojść.
//
// Adres to LOGIN do panelu - po wymianie trener loguje się nowym adresem.
// Hasło zostaje bez zmian (do wymiany służy prisma/hasla-trenerow.ts).
//
// `emailVerifiedAt` jest zerowane: nowy adres podał klub, a nie właściciel
// skrzynki, więc nikt go jeszcze nie potwierdził. Dla panelu trenera nie ma to
// żadnego skutku - baner "potwierdź e-mail" wisi wyłącznie w panelu klienta.
//
// Bez `--ustaw` skrypt niczego nie zapisuje, tylko wypisuje, co by zmienił.
// Dopasowanie idzie po IMIENIU I NAZWISKU z bazy, nie po dotychczasowym
// adresie - adresy są tym, co wymieniamy, więc nie mogą być kluczem.

import { existsSync } from "node:fs";
import dotenv from "dotenv";
import { PrismaClient } from "../app/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { pickConnectionString } from "../lib/domain/connection-string";

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

const envFile = arg("--env") ?? ".env";
const wykonaj = process.argv.includes("--ustaw");

if (!existsSync(envFile)) {
  console.error(`Nie znaleziono pliku z adresem bazy: ${envFile}`);
  process.exit(1);
}
dotenv.config({ path: envFile, override: true, quiet: true });

const connectionString = pickConnectionString(process.env);
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

// Nowe adresy od klubu (stan na 20.08.2026).
//
// Dwóch Targielów, więc dopasowanie po samym nazwisku byłoby zgadywaniem:
// "Targielkuba123" to Kuba, czyli Jakub Targiel; "Jacek.Targiel" to Jacek.
// Daniela Pilca nie ma na liście - jego adres (dpilc@wp.pl) zostaje.
const NOWE_ADRESY: { name: string; email: string }[] = [
  { name: "Michał Kieca", email: "michal.kieca1@gmail.com" },
  { name: "Bartłomiej Przybyła", email: "bartekprzybyla345@gmail.com" },
  // Klub podał "Targielkuba123@gmail.con" - domena .con nie istnieje, więc
  // pod tym adresem nie doszłoby nic: ani reset hasła, ani powiadomienie.
  // Przyjęte jako literówka i poprawione na .com. Jeśli to jednak celowe,
  // zmień tę jedną linijkę.
  { name: "Jakub Targiel", email: "Targielkuba123@gmail.com" },
  { name: "Jacek Targiel", email: "Jacek.Targiel@gmail.com" },
  { name: "Patryk Bortel", email: "bortel1234@gmail.com" },
];

async function main() {
  console.log(`Baza: ${connectionString.replace(/:\/\/[^@]*@/, "://***@")} (z ${envFile})\n`);

  const konta = await prisma.user.findMany({
    where: { name: { in: NOWE_ADRESY.map((t) => t.name) } },
    select: { id: true, name: true, email: true, role: true },
    orderBy: { name: "asc" },
  });

  const brakujace = NOWE_ADRESY.filter((t) => !konta.some((k) => k.name === t.name));
  const doZmiany = NOWE_ADRESY.filter((t) => {
    const konto = konta.find((k) => k.name === t.name);
    return konto && konto.email.toLowerCase() !== t.email.toLowerCase();
  });

  console.log("Dopasowanie:");
  for (const wpis of NOWE_ADRESY) {
    const konto = konta.find((k) => k.name === wpis.name);
    if (!konto) {
      console.log(`  ${wpis.name.padEnd(22)} BRAK KONTA W BAZIE`);
      continue;
    }
    const stan =
      konto.email.toLowerCase() === wpis.email.toLowerCase() ? "bez zmian" : "do wymiany";
    console.log(`  ${wpis.name.padEnd(22)} ${konto.email}  ->  ${wpis.email}   [${stan}]`);
  }

  // Adres jest unikalny w całej tabeli User - kolizja z kontem klienta albo
  // z drugim trenerem wywaliłaby zapis w połowie. Sprawdzamy PRZED zmianą.
  const kolizje = await prisma.user.findMany({
    where: {
      email: { in: NOWE_ADRESY.map((t) => t.email), mode: "insensitive" },
      NOT: { id: { in: konta.map((k) => k.id) } },
    },
    select: { name: true, email: true },
  });

  if (brakujace.length > 0) {
    console.log(`\nUWAGA: nie znaleziono kont dla: ${brakujace.map((b) => b.name).join(", ")}`);
  }
  if (kolizje.length > 0) {
    console.error("\nPRZERWANE: te adresy należą już do innych kont:");
    for (const k of kolizje) console.error(`  ${k.email} -> ${k.name}`);
    await prisma.$disconnect();
    process.exit(1);
  }

  if (doZmiany.length === 0) {
    console.log("\nNic do zrobienia - wszystkie adresy są już aktualne.");
    await prisma.$disconnect();
    return;
  }

  if (!wykonaj) {
    console.log(
      `\nTo był tylko podgląd. Do wymiany: ${doZmiany.length}. ` +
        "Uruchom ponownie z --ustaw, żeby zapisać.",
    );
    await prisma.$disconnect();
    return;
  }

  // Jedna transakcja: albo wszystkie adresy, albo żaden. Połowa kadry
  // z nowym loginem, a połowa ze starym to najgorszy możliwy stan.
  await prisma.$transaction(
    doZmiany.map((wpis) =>
      prisma.user.update({
        where: { id: konta.find((k) => k.name === wpis.name)!.id },
        data: { email: wpis.email, emailVerifiedAt: null },
      }),
    ),
  );

  console.log(`\nZapisano. Wymieniono adresów: ${doZmiany.length}.`);
  console.log("Od teraz trenerzy logują się NOWYM adresem - hasła bez zmian.");
  await prisma.$disconnect();
}

void main().catch(async (blad) => {
  console.error(blad);
  await prisma.$disconnect();
  process.exit(1);
});
