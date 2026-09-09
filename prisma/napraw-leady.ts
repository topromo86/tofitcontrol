// Naprawa leadów zaimportowanych zepsutym parserem.
//
//   npx tsx prisma/napraw-leady.ts                        <- dev, tylko podgląd
//   npx tsx prisma/napraw-leady.ts --ustaw                <- dev, wykonanie
//   npx tsx prisma/napraw-leady.ts --env .env.vercel                  <- produkcja, podgląd
//   npx tsx prisma/napraw-leady.ts --env .env.vercel --ustaw
//
// Co było zepsute: parser szukał kolumny "imię i nazwisko", a plik z Meta ma
// "Imię Nazwisko" (bez spójnika). Kolumna nie pasowała, więc w miejsce nazwiska
// wchodził numer telefonu - cały plik lądował w klubie z imionami w rodzaju
// "p:+48571277686". Do tego numery zapisywały się w takiej postaci, w jakiej
// przyszły (`p:+48...`, `48661535704`, `605687770`), czyli ten sam człowiek miał
// trzy różne zapisy i nie dawał się odnaleźć.
//
// Dlaczego da się to naprawić bez ponownego wgrywania pliku: `rawData` od
// początku trzyma CAŁY wiersz z pliku, więc prawdziwe imię i surowy numer są
// w bazie obok. Skrypt tylko przepisuje je na właściwe pola.
//
// Bez `--ustaw` niczego nie zmienia - wypisuje, co by zrobił.

import { existsSync } from "node:fs";
import dotenv from "dotenv";
import { PrismaClient } from "../app/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { pickConnectionString } from "../lib/domain/connection-string";
import { leadFieldsFromRaw, leadIdentity } from "../lib/domain/lead-import";

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

// Lead "bez imienia" to taki, którego nazwa nie zawiera ANI JEDNEJ litery -
// czyli numer, `p:+48...` albo sam identyfikator. Nazwisko z cyframi w środku
// zostawiamy w spokoju: bywają pseudonimy i nie chcemy zgadywać.
function wyglądaJakNumer(fullName: string): boolean {
  return !/\p{L}/u.test(fullName);
}

async function main() {
  console.log(`Baza: ${connectionString.replace(/:\/\/[^@]*@/, "://***@")} (z ${envFile})\n`);

  const leady = await prisma.lead.findMany({
    select: { id: true, fullName: true, phone: true, rawData: true, status: true },
    orderBy: { importedAt: "asc" },
  });
  console.log(`Leadów w bazie: ${leady.length}`);

  const doNaprawy: { id: string; fullName?: string; phone?: string }[] = [];
  let bezNazwyNieDoOdzyskania = 0;

  for (const lead of leady) {
    const raw = (lead.rawData ?? {}) as Record<string, unknown>;
    const zRaw = leadFieldsFromRaw(raw);

    const zmiany: { id: string; fullName?: string; phone?: string } = { id: lead.id };

    if (wyglądaJakNumer(lead.fullName)) {
      if (zRaw.fullName && !wyglądaJakNumer(zRaw.fullName)) zmiany.fullName = zRaw.fullName;
      else bezNazwyNieDoOdzyskania++;
    }
    // Numer sprowadzamy do jednej postaci niezależnie od imienia - to on jest
    // kluczem, po którym rozpoznajemy powtórny import.
    const nowyNumer = zRaw.phone ?? null;
    if (nowyNumer && nowyNumer !== lead.phone) zmiany.phone = nowyNumer;

    if (zmiany.fullName || zmiany.phone) doNaprawy.push(zmiany);
  }

  console.log(`Do poprawienia: ${doNaprawy.length}`);
  console.log(`  w tym imion:  ${doNaprawy.filter((z) => z.fullName).length}`);
  console.log(`  w tym numerów:${doNaprawy.filter((z) => z.phone).length}`);
  if (bezNazwyNieDoOdzyskania > 0) {
    console.log(`Bez imienia i bez śladu w rawData (zostaną jak są): ${bezNazwyNieDoOdzyskania}`);
  }

  if (doNaprawy.length > 0) {
    console.log("\nPrzykłady (do 10):");
    for (const z of doNaprawy.slice(0, 10)) {
      const przed = leady.find((l) => l.id === z.id)!;
      const imie = z.fullName ? `"${przed.fullName}" -> "${z.fullName}"` : "(imię bez zmian)";
      const tel = z.phone ? `${przed.phone ?? "brak"} -> ${z.phone}` : "(numer bez zmian)";
      console.log(`  ${imie.padEnd(46)} ${tel}`);
    }
  }

  // Powtórny import mógł założyć te same osoby drugi raz. Liczymy je PO
  // ujednoliceniu numerów, bo dopiero wtedy widać, że to ci sami ludzie.
  const poNaprawie = leady.map((l) => {
    const z = doNaprawy.find((d) => d.id === l.id);
    return { ...l, phone: z?.phone ?? l.phone };
  });
  const licznik = new Map<string, number>();
  for (const l of poNaprawie) {
    const key = leadIdentity({ phone: l.phone, email: null });
    if (key) licznik.set(key, (licznik.get(key) ?? 0) + 1);
  }
  const powtorzone = [...licznik.values()].filter((n) => n > 1).length;
  if (powtorzone > 0) {
    console.log(
      `\nUWAGA: ${powtorzone} numerów ma w bazie więcej niż jednego leada - to ślad po` +
        `\npowtórnym imporcie. Skrypt ICH NIE KASUJE: każdy z nich mógł już dostać` +
        `\nstatus, notatkę albo termin, a tego nie da się odtworzyć. Scal je ręcznie` +
        `\nw panelu; od teraz import sam pilnuje, żeby nie powstawały nowe.`,
    );
  }

  if (!wykonaj) {
    console.log("\nTo była próba na sucho - nic nie zostało zmienione.");
    console.log("Uruchom z --ustaw, żeby zapisać poprawki.");
    return;
  }

  for (const z of doNaprawy) {
    await prisma.lead.update({
      where: { id: z.id },
      data: {
        ...(z.fullName ? { fullName: z.fullName } : {}),
        ...(z.phone ? { phone: z.phone } : {}),
      },
    });
  }
  console.log(`\nPoprawiono leadów: ${doNaprawy.length}.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
