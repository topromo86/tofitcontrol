// Uzupełnienie zgód na SMS dla leadów wgranych, zanim system zaczął je zapisywać.
//
//   npx tsx prisma/zgody-leadow.ts                              <- dev, podgląd
//   npx tsx prisma/zgody-leadow.ts --ustaw                      <- dev, wykonanie
//   npx tsx prisma/zgody-leadow.ts --env .env.vercel            <- produkcja, podgląd
//   npx tsx prisma/zgody-leadow.ts --env .env.vercel --ustaw
//
// Po co: od teraz każdy importowany lead dostaje zgodę na kanał SMS w chwili
// importu - to on sam zostawił numer w formularzu kampanii Czapla Boxing,
// prosząc o kontakt w sprawie oferty. Leady wgrane WCZEŚNIEJ takiego wpisu nie
// mają, więc karta pokazywałaby "brak zgody", a powitanie SMS-em by nie wyszło.
// Skrypt dopisuje im wpis, którego nie było jak założyć w tamtej chwili.
//
// Data oświadczenia to `importedAt` leada, a nie dzisiejsza: eksport z Ads
// Managera nie ma kolumny z czasem zgłoszenia, więc import jest najwcześniejszym
// momentem, który klub jest w stanie wykazać. Wpisanie dzisiejszej daty
// twierdziłoby, że zgoda powstała dziś - a to nieprawda.
//
// Skrypt NIE rusza leadów, które już mają wpis o zgodzie - także tych z odmową.
// Ktoś, kto poprosił o zaprzestanie, ma tak zostać.
//
// Bez `--ustaw` niczego nie zmienia - wypisuje, co by zrobił.

import { existsSync } from "node:fs";
import dotenv from "dotenv";
import { PrismaClient } from "../app/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { pickConnectionString } from "../lib/domain/connection-string";
import { buildLeadConsentText, SMS_CONSENT_VERSION } from "../lib/domain/contact-consent";

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

async function main() {
  const settings = await prisma.clubSettings.findUnique({
    where: { id: "singleton" },
    select: { leadConsentText: true },
  });
  const tresc = buildLeadConsentText(settings?.leadConsentText ?? null);

  if (!settings?.leadConsentText) {
    console.warn(
      "UWAGA: treść formularza kampanii nie jest uzupełniona (Ustawienia → Wiadomości SMS).\n" +
        "Zapis zgody będzie się opierał na opisie systemu, a nie na tym, co lead realnie\n" +
        "przeczytał. Uzupełnij ją PRZED uruchomieniem z --ustaw - inaczej trzeba by\n" +
        "poprawiać wpisy, które z założenia są nienaruszalne.\n",
    );
  }

  const bezZgody = await prisma.lead.findMany({
    where: { consents: { none: { channel: "SMS" } } },
    select: { id: true, fullName: true, phone: true, campaign: true, importedAt: true },
    orderBy: { importedAt: "asc" },
  });

  const zZgoda = await prisma.contactConsent.count({ where: { channel: "SMS" } });

  console.log(`Leadów bez zapisanej zgody na SMS: ${bezZgody.length}`);
  console.log(`Zgód na SMS już w bazie: ${zZgoda}`);
  if (bezZgody.length === 0) {
    console.log("\nNie ma czego uzupełniać.");
    return;
  }

  console.log("\nPierwszych dziesięć:");
  for (const lead of bezZgody.slice(0, 10)) {
    console.log(
      `  ${lead.fullName} · ${lead.phone ?? "bez numeru"} · zgłoszenie z ${lead.importedAt.toISOString().slice(0, 10)}`,
    );
  }
  if (bezZgody.length > 10) console.log(`  … i ${bezZgody.length - 10} innych`);

  console.log(`\nTreść, która trafi do każdego wpisu:\n  ${tresc}`);

  if (!wykonaj) {
    console.log("\nTo był podgląd. Dopisz --ustaw, żeby zapisać zgody.");
    return;
  }

  // createMany, nie pętla z transakcją: to jeden rodzaj wpisu, bez zależności
  // między wierszami, a przy 185 leadach pętla to 185 podróży do bazy.
  const wynik = await prisma.contactConsent.createMany({
    data: bezZgody.map((lead) => ({
      leadId: lead.id,
      channel: "SMS" as const,
      granted: true,
      grantedAt: lead.importedAt,
      source: "META_LEAD_ADS" as const,
      textSnapshot: tresc,
      textVersion: SMS_CONSENT_VERSION,
      note: lead.campaign
        ? `Uzupełnione wstecz. Kampania: ${lead.campaign}`
        : "Uzupełnione wstecz dla leada wgranego przed wprowadzeniem zapisu zgód.",
    })),
  });

  console.log(`\nZapisano zgód: ${wynik.count}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
