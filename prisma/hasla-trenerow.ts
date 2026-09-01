// Nowe hasła dla kadry trenerskiej.
//
//   npx tsx prisma/hasla-trenerow.ts                       <- dev, tylko podgląd
//   npx tsx prisma/hasla-trenerow.ts --ustaw               <- dev, wykonanie
//   npx tsx prisma/hasla-trenerow.ts --env .env.vercel --ustaw
//
// Powód: konta kadry powstały ze wspólnym hasłem tymczasowym wpisanym w
// skrypcie zakładającym trenerów. Jedno hasło do wszystkich kont, znane
// każdemu, kto zajrzy do repozytorium, otwiera kartotekę klientów klubu.
//
// Hasła NIE trafiają na ekran ani do repozytorium - lądują w pliku obok
// projektu, wykluczonym z gita. Rozdaje się je osobiście, a plik kasuje.
// Wypisanie ich w konsoli zostawiłoby je w historii terminala.
//
// W pliku jest GOTOWA wiadomość dla każdego trenera osobno - do skopiowania
// i wysłania. Osobno, bo cała lista wysłana jedną wiadomością znaczyłaby, że
// każdy zna hasła pozostałych.
//
// Obejmuje wyłącznie konta z rolą TRAINER. Konto właściciela (ADMIN) jest poza
// tym świadomie - do niego służy prisma/wymus-zmiane-hasla.ts.

import { existsSync, writeFileSync } from "node:fs";
import { randomInt } from "node:crypto";
import dotenv from "dotenv";
import bcrypt from "bcryptjs";
import { PrismaClient } from "../app/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { pickConnectionString } from "../lib/domain/connection-string";

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

const envFile = arg("--env") ?? ".env";
const wykonaj = process.argv.includes("--ustaw");
// Adres, który trafia do wiadomości. Domyślnie produkcyjny, bo to jedyny,
// pod który trener ma się logować; --adres nadpisuje przy testach.
const adresPanelu = arg("--adres") ?? "https://panel.czaplaboxing.pl";

if (!existsSync(envFile)) {
  console.error(`Nie znaleziono pliku z adresem bazy: ${envFile}`);
  process.exit(1);
}
dotenv.config({ path: envFile, override: true, quiet: true });

const connectionString = pickConnectionString(process.env);
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

// Bez znaków, które mylą się przy dyktowaniu przez telefon: 0/O, 1/l/I, 5/S.
// Hasło ma być podane głosem w szatni, a nie przepisane z ekranu.
const ALPHABET = "abcdefghjkmnpqrtuvwxyz23467989";

function generatePassword(): string {
  const group = () =>
    Array.from({ length: 4 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
  // Trzy grupy po cztery znaki: 12 znaków z 30-znakowego alfabetu to ~59 bitów
  // entropii, a myślniki robią z tego coś, co da się podyktować.
  return `${group()}-${group()}-${group()}`;
}

async function main() {
  console.log(`Baza: ${connectionString.replace(/:\/\/[^@]*@/, "://***@")} (z ${envFile})\n`);

  const trenerzy = await prisma.user.findMany({
    where: { role: "TRAINER" },
    select: { id: true, email: true, name: true, lastLoginAt: true },
    orderBy: { name: "asc" },
  });

  if (trenerzy.length === 0) {
    console.log("Brak kont z rolą TRAINER.");
    return;
  }

  console.log(`Konta instruktorów (${trenerzy.length}):`);
  for (const t of trenerzy) {
    const logowanie = t.lastLoginAt
      ? `ostatnie logowanie ${t.lastLoginAt.toISOString().slice(0, 10)}`
      : "nigdy się nie logował(a)";
    console.log(`  ${t.email.padEnd(36)} ${t.name.padEnd(24)} ${logowanie}`);
  }

  if (!wykonaj) {
    console.log("\nTo była próba na sucho - żadne hasło nie zostało zmienione.");
    console.log("Uruchom z --ustaw, żeby wygenerować nowe hasła.");
    return;
  }

  const wiersze: string[] = [
    "HASŁA INSTRUKTORÓW - Czapla Boxing",
    `Wygenerowane: ${new Date().toLocaleString("pl-PL", { timeZone: "Europe/Warsaw" })}`,
    "",
    "NIE WYSYŁAJ CAŁEGO PLIKU NIKOMU. Każdy dostaje wyłącznie SWÓJ blok -",
    "inaczej cała kadra pozna nawzajem swoje hasła.",
    "Po rozdaniu skasuj ten plik.",
    "",
    "".padEnd(64, "="),
  ];

  for (const t of trenerzy) {
    const haslo = generatePassword();
    await prisma.user.update({
      where: { id: t.id },
      // Flaga wymuszenia: trener ustawi własne hasło przy pierwszym logowaniu.
      // Hasło podane głosem w szatni zna dwoje ludzi, więc nie jest hasłem.
      data: { passwordHash: await bcrypt.hash(haslo, 10), mustChangePassword: true },
    });

    // Gotowa wiadomość do skopiowania, a nie sama para login/hasło. Powód
    // praktyczny: to i tak trzeba było za każdym razem pisać ręcznie, a przy
    // pisaniu ręcznym ginie zdanie o wymuszonej zmianie hasła - czyli jedyne,
    // które tłumaczy, dlaczego system po zalogowaniu nie wpuszcza dalej.
    wiersze.push("");
    wiersze.push(`### ${t.name}  (wyślij na: ${t.email})`);
    wiersze.push("");
    wiersze.push(`Cześć ${t.name.split(" ")[0]},`);
    wiersze.push("");
    wiersze.push(`panel klubu: ${adresPanelu}`);
    wiersze.push(`login:       ${t.email}`);
    wiersze.push(`hasło:       ${haslo}`);
    wiersze.push("");
    wiersze.push("To hasło jest tymczasowe - znam je ja i Ty, więc nie jest hasłem.");
    wiersze.push("Po pierwszym zalogowaniu system poprosi Cię o ustawienie własnego");
    wiersze.push("i dopóki tego nie zrobisz, nie wpuści Cię dalej. Starego nie da się");
    wiersze.push("wpisać z powrotem.");
    wiersze.push("");
    wiersze.push("".padEnd(64, "="));
  }

  const nazwa = `hasla-instruktorow-${new Date().toISOString().slice(0, 10)}.txt`;
  writeFileSync(nazwa, wiersze.join("\n"), "utf8");

  console.log(`\nZmieniono hasła: ${trenerzy.length}.`);
  console.log(`Lista zapisana w pliku: ${nazwa}`);
  console.log("Plik jest wykluczony z gita. Rozdaj hasła i skasuj go.");
  console.log("Każdy trener ustawi własne hasło przy pierwszym logowaniu.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
