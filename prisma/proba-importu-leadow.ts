// Próba importu leadów: wgraj -> wgraj drugi raz -> napraw stary wpis.
//
// Uruchamianie (tylko baza deweloperska - skrypt zakłada i kasuje leady):
//
//   Windows PowerShell:
//     $env:NODE_OPTIONS = "--conditions=react-server"
//     npx.cmd tsx prisma/proba-importu-leadow.ts
//
// Plik testowy jest SYNTETYCZNY, ale odtwarza co do znaku każde dziwactwo
// z realnego eksportu klubu (Czapla Boxing, wrzesień 2026):
//
//   - nagłówek "Imię Nazwisko" bez spójnika "i",
//   - numery w pięciu postaciach naraz: `p:+48...`, `p:` bez plusa,
//     `48XXXXXXXXX` (kierunkowy bez plusa), dziewięć cyfr, numer zagraniczny,
//   - imiona jednowyrazowe i takie, które są nazwą firmy,
//   - ten sam człowiek wpisany dwa razy,
//   - kilkadziesiąt pustych wierszy na końcu i zabłąkana notatka w ostatniej
//     kolumnie ostatniego wiersza.
//
// Prawdziwego pliku tu nie ma i być nie może - to dane osobowe 185 osób.

import "dotenv/config";

delete process.env.SMTP_HOST;
delete process.env.SMTP_USER;
delete process.env.SMTP_PASSWORD;

import { prisma } from "@/lib/prisma";
import { importLeadsFromCsv } from "@/lib/services/lead";
import { leadFieldsFromRaw } from "@/lib/domain/lead-import";

const CSV = [
  'Imię Nazwisko,Numer Telefonu,"Treningi odbywają się w Czapla Boxing, Niepodległosci 188 Tychy, czy Ci to pasuje?",Jesteś w stanie zapłacić 100 zł za pierwszy trening próbny?,Dlaczego chcialbys trenowac boks?,,,,',
  'Kamila Drab,p:+48571277686,tak,tak,"Wzmocnienie charakteru, nowa forma treningu",,,,',
  "Klaudyna,p:605687770,tak,tak,Utrzymania kondycji,,,,",
  "Grzegorz Szewczyk,48661535704,tak,tak,dla kondycji zdrowia. ruchu,,,,",
  "Aleksandra Pawikowska,783925065,tak,tak,rozładowanie emocji,,,,",
  "Paulina Niewęgłowska,31613737346,tak,tak,zawsze marzyłam,,,,",
  "Firma Remontowo Targowa,48794605076,tak,tak,sport to zdrowie,,,,",
  '"Adam Krawczyk",48501362278,tak,tak,"trenuje cale zycie na silowni",,,,',
  '"Adam Krawczyk",48501362278,tak,tak,"trenuje cale zycie na silowni",,,,',
  ",,,,,,,,",
  ",,,,,,,,",
  ',,,,,,,,">>Follow up1, brak kontaku"',
].join("\n");

const OCZEKIWANE_NUMERY = [
  "+48571277686",
  "+48605687770",
  "+48661535704",
  "+48783925065",
  "+31613737346",
  "+48794605076",
  "+48501362278",
];

let bledy = 0;
function sprawdz(opis: string, warunek: boolean, szczegol = "") {
  console.log(`  ${warunek ? "OK  " : "BŁĄD"}  ${opis}${szczegol ? ` (${szczegol})` : ""}`);
  if (!warunek) bledy++;
}

async function main() {
  const admin = await prisma.user.findFirst({ where: { role: "ADMIN" }, select: { id: true } });
  if (!admin) {
    console.error("Baza deweloperska nie ma konta ADMIN. Uruchom: npm run db:setup");
    process.exitCode = 1;
    return;
  }

  const zalozone: string[] = [];

  try {
    console.log("=== 1. Pierwszy import ===");
    const pierwszy = await importLeadsFromCsv({ csv: CSV, actorUserId: admin.id });
    console.log(
      `  utworzone=${pierwszy.created} dublety=${pierwszy.duplicates} pominięte=${pierwszy.skipped}`,
    );
    sprawdz("zakłada 7 leadów (8 wierszy, jeden powtórzony)", pierwszy.created === 7);
    sprawdz("wyłapuje dubla w pliku", pierwszy.duplicates === 1);
    sprawdz("pomija wiersz z samą notatką", pierwszy.skipped === 1);

    const leady = await prisma.lead.findMany({
      where: { phone: { in: OCZEKIWANE_NUMERY } },
      select: { id: true, fullName: true, phone: true, rawData: true, status: true },
    });
    zalozone.push(...leady.map((l) => l.id));

    console.log("\n=== 2. Imiona i numery ===");
    sprawdz(
      "wszystkie numery sprowadzone do jednej postaci",
      leady.length === 7,
      `${leady.length}/7`,
    );
    const bezImienia = leady.filter((l) => !/\p{L}/u.test(l.fullName));
    sprawdz("żaden lead nie nazywa się numerem telefonu", bezImienia.length === 0);
    const kamila = leady.find((l) => l.phone === "+48571277686");
    sprawdz(
      'imię czytane z kolumny "Imię Nazwisko"',
      kamila?.fullName === "Kamila Drab",
      kamila?.fullName,
    );
    const holenderka = leady.find((l) => l.phone === "+31613737346");
    sprawdz("numer zagraniczny nie stał się polskim", Boolean(holenderka));
    sprawdz(
      "odpowiedź z formularza zachowana",
      String(
        (kamila?.rawData as Record<string, string>)?.["Dlaczego chcialbys trenowac boks?"] ?? "",
      ).includes("Wzmocnienie"),
    );

    console.log("\n=== 2b. Trafiaja do kolejki do obdzwonienia ===");
    // Kolejka pracy na /leady to statusy NEW + CALLBACK. Swiezy import musi tam
    // wpasc, inaczej nikt do tych ludzi nie zadzwoni.
    const doObdzwonienia = leady.filter((l) => l.status === "NEW" || l.status === "CALLBACK");
    sprawdz(
      "wszystkie zaimportowane czekaja na telefon",
      doObdzwonienia.length === leady.length,
      `${doObdzwonienia.length}/${leady.length}`,
    );

    console.log("\n=== 3. Ten sam plik drugi raz ===");
    const drugi = await importLeadsFromCsv({ csv: CSV, actorUserId: admin.id });
    console.log(`  utworzone=${drugi.created} dublety=${drugi.duplicates}`);
    sprawdz("nie zakłada niczego po raz drugi", drugi.created === 0);
    sprawdz("zgłasza wszystkich jako dublety", drugi.duplicates === 8);
    sprawdz(
      "mowi KTO byl juz w bazie, nie tylko ilu",
      drugi.duplicateNames.includes("Kamila Drab"),
      drugi.duplicateNames.slice(0, 3).join(", "),
    );

    console.log("\n=== 4. Odzyskanie imienia ze starego, zepsutego wpisu ===");
    const zepsuty = await prisma.lead.create({
      data: {
        source: "META_OTHER",
        fullName: "p:+48999888777",
        phone: "p:+48999888777",
        rawData: { "Imię Nazwisko": "Testowy Odzyskany", "Numer Telefonu": "p:+48999888777" },
      },
      select: { id: true, rawData: true },
    });
    zalozone.push(zepsuty.id);
    const odzyskane = leadFieldsFromRaw(zepsuty.rawData as Record<string, unknown>);
    sprawdz(
      "imię odzyskane z rawData",
      odzyskane.fullName === "Testowy Odzyskany",
      odzyskane.fullName ?? "",
    );
    sprawdz(
      "numer odzyskany i znormalizowany",
      odzyskane.phone === "+48999888777",
      odzyskane.phone ?? "",
    );
  } finally {
    if (zalozone.length > 0) {
      await prisma.leadActivity.deleteMany({ where: { leadId: { in: zalozone } } });
      await prisma.leadNote.deleteMany({ where: { leadId: { in: zalozone } } });
      await prisma.lead.deleteMany({ where: { id: { in: zalozone } } });
    }
    console.log(`\nPosprzątane: ${zalozone.length} leadów.`);
  }

  console.log(bledy === 0 ? "\nOK: import czyta plik z Meta poprawnie." : `\nBŁĘDÓW: ${bledy}`);
  if (bledy > 0) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
