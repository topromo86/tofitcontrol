// Scalenie zdublowanych leadów.
//
//   npx tsx prisma/scal-leady.ts --env .env.vercel            <- PODGLĄD
//   npx tsx prisma/scal-leady.ts --env .env.vercel --usun     <- wykonanie
//
// Skąd wzięły się duplikaty: ten sam plik z Ads Managera wgrano kilka razy,
// zanim parser sprowadzał numer do jednej postaci. Deduplikacja importu
// porównuje numery jako NAPISY (`leadIdentity` -> `tel:${lead.phone}`), więc
// `48691041554` zapisane starym parserem nie zrównało się z `+48691041554`
// z poprawionego - i ten sam człowiek wchodził do klubu kolejny raz. Stąd
// 923 wiersze na 183 osoby.
//
// Grupujemy po CIĄGU CYFR, nie po napisie - to jedyne porównanie, które łapie
// `605687770`, `48605687770` i `+48 605 687 770` jako tę samą osobę.
//
// ZOSTAJE wiersz, który ma kanoniczny numer (`+48...`) ORAZ prawdziwe imię.
// Reszta w grupie to wiersze z zepsutego importu: numer bez plusa, a w miejscu
// nazwiska ten sam numer.
//
// Trzy odmowy, każda z powodu:
//
//   - grupa bez ani jednego dobrego wiersza -> POMIJAMY. Nie ma czego zostawić,
//     a zgadywanie, który wiersz jest "ten właściwy", kończy się skasowaniem
//     cudzej pracy,
//   - grupa z więcej niż jednym dobrym wierszem -> POMIJAMY. Dwa pełne wpisy
//     na jeden numer to albo dwie osoby pod jednym telefonem (rodzic i dziecko),
//     albo realny dublet do scalenia ręcznego - jedno i drugie jest decyzją
//     człowieka,
//   - wiersz do skasowania NIESIE PRACĘ (notatka, status inny niż "Nowy",
//     termin, przypisany opiekun, założone konto klienta) -> POMIJAMY CAŁĄ
//     GRUPĘ. Klub mógł już dzwonić akurat pod ten wpis.
//
// Kasowanie leada zabiera kaskadą jego notatki, historię kontaktu i zgody na
// SMS (`onDelete: Cascade`). Dlatego wiersz ze śladem pracy nie ma prawa
// zniknąć maszynowo.

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
const wykonaj = process.argv.includes("--usun");

if (!existsSync(envFile)) {
  console.error(`Nie znaleziono pliku z adresem bazy: ${envFile}`);
  process.exit(1);
}
dotenv.config({ path: envFile, override: true, quiet: true });

const connectionString = pickConnectionString(process.env);
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

// Tożsamość numeru - sam ciąg cyfr. Numeru zagranicznego nie ścinamy do
// dziewięciu cyfr: dwa kraje mogą mieć tę samą końcówkę.
function kluczNumeru(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cyfry = raw.replace(/\D/g, "");
  if (cyfry.length === 0) return null;
  let d = cyfry.startsWith("00") ? cyfry.slice(2) : cyfry;
  if (d.length === 11 && d.startsWith("48")) d = d.slice(2);
  else if (d.length === 10 && d.startsWith("0")) d = d.slice(1);
  return d.length === 9 ? `PL:${d}` : `INT:${d}`;
}

type Wiersz = {
  id: string;
  fullName: string;
  phone: string | null;
  status: string;
  reminderAt: Date | null;
  convertedMemberId: string | null;
  assignedToUserId: string | null;
  _count: { notes: number; activities: number; consents: number };
};

const maKanonicznyNumer = (l: Wiersz) => /^\+\d+$/.test(l.phone ?? "");
const maImie = (l: Wiersz) => /\p{L}/u.test(l.fullName);
const dobry = (l: Wiersz) => maKanonicznyNumer(l) && maImie(l);

// Import zapisuje jedno zdarzenie IMPORTED - dopiero drugie znaczy, że ktoś
// przy tym leadzie pracował.
function slodPracy(l: Wiersz): string[] {
  const p: string[] = [];
  if (l._count.notes > 0) p.push(`${l._count.notes} notatek`);
  if (l._count.activities > 1) p.push(`${l._count.activities - 1} zdarzeń`);
  if (l.status !== "NEW") p.push(`status ${l.status}`);
  if (l.reminderAt) p.push("umówiony termin");
  if (l.assignedToUserId) p.push("przypisany opiekun");
  if (l.convertedMemberId) p.push("ZAŁOŻONE KONTO KLIENTA");
  return p;
}

async function main() {
  console.log(`Baza: ${envFile}`);
  console.log(wykonaj ? "Tryb: WYKONANIE\n" : "Tryb: PODGLĄD (bez --usun nic nie skasuje)\n");

  const leady = (await prisma.lead.findMany({
    select: {
      id: true,
      fullName: true,
      phone: true,
      status: true,
      reminderAt: true,
      convertedMemberId: true,
      assignedToUserId: true,
      _count: { select: { notes: true, activities: true, consents: true } },
    },
    orderBy: { importedAt: "asc" },
  })) as Wiersz[];

  const grupy = new Map<string, Wiersz[]>();
  for (const l of leady) {
    const k = kluczNumeru(l.phone);
    if (!k) continue;
    const g = grupy.get(k);
    if (g) g.push(l);
    else grupy.set(k, [l]);
  }

  const doSkasowania: string[] = [];
  const pominiete: { klucz: string; powod: string; szczegol: string }[] = [];
  let grupNietknietych = 0;

  for (const [klucz, g] of grupy) {
    if (g.length === 1) {
      grupNietknietych++;
      continue;
    }
    const dobre = g.filter(dobry);
    if (dobre.length === 0) {
      pominiete.push({
        klucz,
        powod: "brak wiersza z numerem i imieniem",
        szczegol: g.map((l) => `${l.fullName} / ${l.phone}`).join(" | "),
      });
      continue;
    }
    if (dobre.length > 1) {
      pominiete.push({
        klucz,
        powod: "więcej niż jeden pełny wpis na ten numer",
        szczegol: dobre.map((l) => l.fullName).join(" | "),
      });
      continue;
    }

    const zostaje = dobre[0]!;
    const reszta = g.filter((l) => l.id !== zostaje.id);
    const zPraca = reszta.filter((l) => slodPracy(l).length > 0);
    if (zPraca.length > 0) {
      pominiete.push({
        klucz,
        powod: "wiersz do skasowania niesie pracę klubu",
        szczegol: zPraca.map((l) => `${l.fullName}: ${slodPracy(l).join(", ")}`).join(" | "),
      });
      continue;
    }

    doSkasowania.push(...reszta.map((l) => l.id));
  }

  console.log("=== CO WYCHODZI Z RACHUNKU ===");
  console.log(`  leadów w bazie:          ${leady.length}`);
  console.log(`  realnych osób (numerów): ${grupy.size}`);
  console.log(`  grup bez duplikatu:      ${grupNietknietych}`);
  console.log(`  wierszy DO SKASOWANIA:   ${doSkasowania.length}`);
  console.log(
    `  grup POMINIĘTYCH:        ${pominiete.length}  <- zostają nietknięte, do obejrzenia ręcznie`,
  );
  console.log(`  leadów zostanie:         ${leady.length - doSkasowania.length}`);

  if (pominiete.length > 0) {
    console.log("\n=== POMINIĘTE (nic im się nie stanie) ===");
    for (const p of pominiete.slice(0, 25)) {
      console.log(`  ${p.klucz}  [${p.powod}]`);
      console.log(`      ${p.szczegol.slice(0, 160)}`);
    }
    if (pominiete.length > 25) console.log(`  ... i ${pominiete.length - 25} innych`);
  }

  if (!wykonaj) {
    console.log("\nTo był podgląd. Dopisz --usun, żeby wykonać.");
    return;
  }

  if (doSkasowania.length === 0) {
    console.log("\nNie ma czego kasować.");
    return;
  }

  // Kasujemy partiami - jedno zapytanie na 740 identyfikatorów potrafi przekroczyć
  // limit parametrów sterownika.
  let skasowane = 0;
  const PARTIA = 200;
  for (let i = 0; i < doSkasowania.length; i += PARTIA) {
    const partia = doSkasowania.slice(i, i + PARTIA);
    const r = await prisma.lead.deleteMany({ where: { id: { in: partia } } });
    skasowane += r.count;
    console.log(`  skasowano ${skasowane}/${doSkasowania.length}`);
  }

  const zostalo = await prisma.lead.count();
  console.log(`\nGotowe. Skasowano ${skasowane}, w bazie zostało ${zostalo} leadów.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
