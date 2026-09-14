// Audyt bazy leadów - TYLKO CZYTA, niczego nie zmienia.
//
//   npx tsx prisma/audyt-leadow.ts                     <- baza deweloperska
//   npx tsx prisma/audyt-leadow.ts --env .env.vercel   <- produkcja
//   npx tsx prisma/audyt-leadow.ts --env .env.vercel --pelna   <- wszystkie grupy
//
// Po co osobne narzędzie, skoro import ma deduplikację: deduplikacja porównuje
// numery jako NAPISY (`leadIdentity` -> `tel:${lead.phone}`). Leady wgrane, zanim
// parser sprowadzał numer do jednej postaci, leżą w bazie jako `605687770`,
// `48661535704` albo `p:+48571277686` - i żaden z nich nie zrówna się
// z `+48605687770` z nowego importu. Ten sam człowiek wchodzi wtedy drugi raz.
//
// Dlatego tutaj porównujemy po CIĄGU CYFR, nie po napisie:
//
//   605687770  ->  PL:605687770
//   48605687770 -> PL:605687770
//   +48 605 687 770 -> PL:605687770
//   0048605687770 -> PL:605687770
//   31613737346 -> INT:31613737346   (numer holenderski zostaje osobno)
//
// Numeru zagranicznego NIE ścinamy do dziewięciu cyfr - dwa różne kraje mogą
// mieć taką samą końcówkę i zlepilibyśmy obcych ludzi w jedną osobę.

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
const pelna = process.argv.includes("--pelna");

if (!existsSync(envFile)) {
  console.error(`Nie znaleziono pliku z adresem bazy: ${envFile}`);
  process.exit(1);
}
dotenv.config({ path: envFile, override: true, quiet: true });

const connectionString = pickConnectionString(process.env);
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

// Klucz tożsamości numeru: sam ciąg cyfr, sprowadzony do postaci krajowej tam,
// gdzie da się to zrobić bez zgadywania.
export function kluczNumeru(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cyfry = raw.replace(/\D/g, "");
  if (cyfry.length === 0) return null;

  // "00" to zapis kierunkowego z klawiatury telefonu (0048..., 0031...).
  let d = cyfry.startsWith("00") ? cyfry.slice(2) : cyfry;

  // Polski numer w trzech postaciach, które realnie leżą w bazie.
  if (d.length === 11 && d.startsWith("48")) d = d.slice(2);
  else if (d.length === 10 && d.startsWith("0")) d = d.slice(1);

  if (d.length === 9) return `PL:${d}`;
  return `INT:${d}`;
}

// Lead "bez imienia" to taki, którego nazwa nie zawiera ANI JEDNEJ litery -
// czyli w miejsce nazwiska wszedł numer albo pusty ciąg.
function bezImienia(fullName: string): boolean {
  return !/\p{L}/u.test(fullName);
}

// Czy w tym leadzie siedzi już czyjaś praca. To rozstrzyga, czy wolno go
// skasować przy scalaniu, czy trzeba go obejrzeć ręcznie.
type Praca = {
  notatki: number;
  zdarzenia: number;
  status: string;
  termin: boolean;
  konto: boolean;
};

function maPrace(p: Praca): boolean {
  return p.notatki > 0 || p.zdarzenia > 0 || p.status !== "NEW" || p.termin || p.konto;
}

async function main() {
  console.log(`Baza: ${envFile}\n`);

  const leady = await prisma.lead.findMany({
    select: {
      id: true,
      fullName: true,
      phone: true,
      email: true,
      status: true,
      campaign: true,
      source: true,
      reminderAt: true,
      convertedMemberId: true,
      importedAt: true,
      rawData: true,
      _count: { select: { notes: true, activities: true, consents: true } },
    },
    orderBy: { importedAt: "asc" },
  });

  console.log(`=== 1. ILE ICH JEST ===`);
  console.log(`  leadów razem:            ${leady.length}`);
  const zNumerem = leady.filter((l) => kluczNumeru(l.phone) !== null);
  const bezNumeru = leady.filter((l) => kluczNumeru(l.phone) === null);
  console.log(`  z numerem telefonu:      ${zNumerem.length}`);
  console.log(`  BEZ numeru telefonu:     ${bezNumeru.length}`);
  const zMailem = bezNumeru.filter((l) => l.email && l.email.includes("@"));
  console.log(`    z tego z e-mailem:     ${zMailem.length}`);
  console.log(`    bez numeru i bez maila:${bezNumeru.length - zMailem.length}`);

  console.log(`\n=== 2. POSTAĆ NUMERU W BAZIE ===`);
  const postacie = new Map<string, number>();
  for (const l of leady) {
    if (!l.phone) continue;
    const p = /^\+\d+$/.test(l.phone)
      ? "kanoniczna (+48...)"
      : /^\d+$/.test(l.phone)
        ? "same cyfry, bez plusa"
        : "inna (spacje, p:, znaki)";
    postacie.set(p, (postacie.get(p) ?? 0) + 1);
  }
  for (const [p, n] of [...postacie.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${p.padEnd(26)} ${n}`);
  }

  console.log(`\n=== 3. IMIONA ===`);
  const bezNazwiska = leady.filter((l) => bezImienia(l.fullName));
  console.log(`  bez imienia i nazwiska:  ${bezNazwiska.length}`);
  const doOdzyskania = bezNazwiska.filter((l) => {
    const raw = (l.rawData ?? {}) as Record<string, unknown>;
    return Object.values(raw).some((v) => typeof v === "string" && /\p{L}{2,}/u.test(v));
  });
  console.log(`    da się odzyskać z rawData: ${doOdzyskania.length}`);

  console.log(`\n=== 4. DUPLIKATY PO CIĄGU CYFR ===`);
  const grupy = new Map<string, typeof leady>();
  for (const l of leady) {
    const k = kluczNumeru(l.phone);
    if (!k) continue;
    const g = grupy.get(k);
    if (g) g.push(l);
    else grupy.set(k, [l]);
  }
  const dublety = [...grupy.entries()].filter(([, g]) => g.length > 1);
  const nadmiar = dublety.reduce((s, [, g]) => s + g.length - 1, 0);
  console.log(`  unikalnych numerów:      ${grupy.size}`);
  console.log(`  numerów zdublowanych:    ${dublety.length}`);
  console.log(`  WIERSZY DO SCALENIA:     ${nadmiar}  (tyle leadów jest nadmiarowych)`);

  // Ile z tych duplikatów powstało przez ROZJECHANY ZAPIS numeru - czyli takich,
  // których deduplikacja po napisie nie miała jak złapać.
  const przezZapis = dublety.filter(([, g]) => new Set(g.map((l) => l.phone)).size > 1);
  console.log(`    w tym przez różny zapis tego samego numeru: ${przezZapis.length}`);
  console.log(
    `    przez powtórny import identycznego numeru:  ${dublety.length - przezZapis.length}`,
  );

  console.log(`\n=== 5. CZY SCALANIE JEST BEZPIECZNE ===`);
  let grupyZPraca = 0;
  let doSkasowaniaBezpiecznie = 0;
  for (const [, g] of dublety) {
    const zPraca = g.filter((l) =>
      maPrace({
        notatki: l._count.notes,
        // Sam import zapisuje jedno zdarzenie IMPORTED - dopiero drugie znaczy,
        // że ktoś przy tym leadzie coś robił.
        zdarzenia: Math.max(0, l._count.activities - 1),
        status: l.status,
        termin: l.reminderAt !== null,
        konto: l.convertedMemberId !== null,
      }),
    );
    if (zPraca.length > 0) grupyZPraca++;
    else doSkasowaniaBezpiecznie += g.length - 1;
  }
  console.log(`  grup, w których ktoś już pracował: ${grupyZPraca}  <- te trzeba obejrzeć ręcznie`);
  console.log(
    `  wierszy nadmiarowych bez śladu pracy: ${doSkasowaniaBezpiecznie}  <- te da się scalić maszynowo`,
  );

  console.log(`\n=== 6. DUPLIKATY PO E-MAILU (leady bez numeru) ===`);
  const poMailu = new Map<string, number>();
  for (const l of bezNumeru) {
    const m = l.email?.trim().toLowerCase();
    if (!m || !m.includes("@")) continue;
    poMailu.set(m, (poMailu.get(m) ?? 0) + 1);
  }
  const dubleMail = [...poMailu.entries()].filter(([, n]) => n > 1);
  console.log(`  zdublowanych adresów:    ${dubleMail.length}`);
  console.log(`  wierszy nadmiarowych:    ${dubleMail.reduce((s, [, n]) => s + n - 1, 0)}`);

  console.log(`\n=== 7. SKĄD SIĘ WZIĘŁY ===`);
  const wgDnia = new Map<string, number>();
  for (const l of leady) {
    const d = l.importedAt.toISOString().slice(0, 10);
    wgDnia.set(d, (wgDnia.get(d) ?? 0) + 1);
  }
  for (const [d, n] of [...wgDnia.entries()].sort()) console.log(`  ${d}  ${n}`);

  console.log(`\n=== 8. PRZYKŁADY GRUP ===`);
  const doPokazania = pelna ? dublety : dublety.slice(0, 12);
  for (const [klucz, g] of doPokazania) {
    const zapisy = [...new Set(g.map((l) => l.phone))].join(" | ");
    console.log(`\n  ${klucz}  (${g.length} wierszy)  zapisy w bazie: ${zapisy}`);
    for (const l of g) {
      const praca: string[] = [];
      if (l._count.notes > 0) praca.push(`${l._count.notes} notatek`);
      if (l._count.activities > 1) praca.push(`${l._count.activities - 1} zdarzeń`);
      if (l.status !== "NEW") praca.push(`status ${l.status}`);
      if (l.reminderAt) praca.push("ma termin");
      if (l.convertedMemberId) praca.push("MA KONTO KLIENTA");
      if (l._count.consents > 0) praca.push(`${l._count.consents} zgód`);
      console.log(
        `    ${l.importedAt.toISOString().slice(0, 10)}  ${(l.fullName || "(bez nazwiska)").slice(0, 28).padEnd(28)} ${praca.length ? praca.join(", ") : "bez śladu pracy"}`,
      );
    }
  }
  if (!pelna && dublety.length > doPokazania.length) {
    console.log(
      `\n  ... i ${dublety.length - doPokazania.length} innych grup (--pelna pokaże wszystkie)`,
    );
  }

  console.log(`\n--- To był audyt. Nic nie zostało zmienione. ---`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
