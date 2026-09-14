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
import { phoneKey } from "@/lib/domain/phone";

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

    console.log("\n=== 5. DOIMPORTOWANIE nowego pliku do istniejacych ===");
    // To jest realny scenariusz klubu: przychodzi kolejny plik z kampanii,
    // w ktorym CZESC ludzi juz jest w bazie - ale wpisanych INACZEJ. Meta raz
    // eksportuje `+48571277686`, raz `571277686`, raz ze spacjami. Porownywanie
    // numerow jako napisow przepuszczalo te osoby jako nowe; tak powstaly 923
    // leady na 183 osoby.
    //
    // Najpierw kladziemy na istniejacym leadzie PRACE KLUBU - status, termin
    // i notatke. Import nie ma prawa ich ruszyc.
    const kamilaId = leady.find((l) => l.phone === "+48571277686")!.id;
    await prisma.lead.update({
      where: { id: kamilaId },
      data: { status: "CALLBACK", reminderAt: new Date("2026-10-01T09:00:00Z") },
    });
    await prisma.leadNote.create({
      data: { leadId: kamilaId, authorUserId: admin.id, body: "Prosila o telefon po 17." },
    });

    const DRUGI_PLIK = [
      "Imie Nazwisko,Numer Telefonu",
      "Kamila Drab,571277686",
      "Grzegorz Szewczyk,+48 661 535 704",
      "Klaudyna,0048605687770",
      "Nowa Osoba,500111222",
      "Druga Nowa,+48500333444",
    ].join("\n");

    const trzeci = await importLeadsFromCsv({ csv: DRUGI_PLIK, actorUserId: admin.id });
    console.log(`  utworzone=${trzeci.created} dublety=${trzeci.duplicates}`);
    sprawdz("dopisuje WYLACZNIE nowe osoby", trzeci.created === 2, String(trzeci.created));
    sprawdz(
      "rozpoznaje znanych mimo INNEGO zapisu numeru",
      trzeci.duplicates === 3,
      String(trzeci.duplicates),
    );

    const nowe = await prisma.lead.findMany({
      where: { phone: { in: ["+48500111222", "+48500333444"] } },
      select: { id: true },
    });
    zalozone.push(...nowe.map((l) => l.id));
    sprawdz("nowe osoby sa w bazie", nowe.length === 2, `${nowe.length}/2`);

    console.log("\n=== 5b. Istniejacy lead NIE zostal nadpisany ===");
    const poImporcie = await prisma.lead.findUniqueOrThrow({
      where: { id: kamilaId },
      select: {
        fullName: true,
        phone: true,
        status: true,
        reminderAt: true,
        _count: { select: { notes: true } },
      },
    });
    sprawdz("status z pracy klubu zostal", poImporcie.status === "CALLBACK", poImporcie.status);
    sprawdz("umowiony termin zostal", poImporcie.reminderAt !== null);
    sprawdz("notatka zostala", poImporcie._count.notes === 1, String(poImporcie._count.notes));
    sprawdz("numer nie zostal cofniety do postaci z pliku", poImporcie.phone === "+48571277686");

    console.log("\n=== 5c. Po doimportowaniu NIE MA duplikatow ===");
    const wszystkie = await prisma.lead.findMany({ select: { phone: true } });
    const klucze = wszystkie.map((l) => phoneKey(l.phone)).filter((k): k is string => k !== null);
    sprawdz(
      "kazdy numer wystepuje dokladnie raz",
      new Set(klucze).size === klucze.length,
      `${klucze.length} leadow, ${new Set(klucze).size} numerow`,
    );

    console.log("\n=== 5d. Znany numer ZAPISANY W BAZIE po staremu ===");
    // TU siedzi prawdziwy blad, ktory zrobil 923 leady z 183 osob - i bez tego
    // kroku poprzednie sekcje przechodza nawet na zepsutym kodzie.
    //
    // Numery z PLIKU parser i tak sprowadza do `+48...`, wiec porownywanie
    // napisow trafia, dopoki baza jest czysta. Problem zaczyna sie, gdy w bazie
    // lezy wiersz zapisany STARYM parserem - `48777666555` bez plusa. Wtedy
    // `tel:48777666555` nie zrownuje sie z `tel:+48777666555` z nowego importu
    // i ten sam czlowiek wchodzi drugi raz.
    const poStaremu = await prisma.lead.create({
      data: {
        source: "META_OTHER",
        fullName: "Stary Wpis",
        // dokladnie tak zapisywal numer parser sprzed poprawki
        phone: "48777666555",
      },
      select: { id: true },
    });
    zalozone.push(poStaremu.id);

    const PLIK_Z_TYM_SAMYM = ["Imie Nazwisko,Numer Telefonu", "Stary Wpis,+48777666555"].join("\n");
    const czwarty = await importLeadsFromCsv({
      csv: PLIK_Z_TYM_SAMYM,
      actorUserId: admin.id,
    });
    sprawdz(
      "rozpoznaje leada zapisanego w bazie BEZ kierunkowego",
      czwarty.created === 0 && czwarty.duplicates === 1,
      `utworzone=${czwarty.created} dublety=${czwarty.duplicates}`,
    );
    const ilePoStaremu = await prisma.lead.count({
      where: { phone: { in: ["48777666555", "+48777666555"] } },
    });
    sprawdz("w bazie nadal JEDEN wiersz na ten numer", ilePoStaremu === 1, String(ilePoStaremu));
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
