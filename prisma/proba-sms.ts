// Próba zgód na SMS i doboru odbiorców.
//
// Uruchamianie (tylko baza deweloperska - skrypt zakłada i kasuje dane):
//
//   Windows PowerShell:
//     $env:NODE_OPTIONS = "--conditions=react-server"
//     npx.cmd tsx prisma/proba-sms.ts
//
// Sprawdza to, czego nie złapie test jednostkowy, bo dzieje się między
// importem, bazą i konwersją leada na klubowicza:
//
//   1. zaimportowany lead ma zgodę na SMS OD RAZU - to on zostawił numer
//      w formularzu kampanii klubu, prosząc o kontakt w sprawie oferty,
//   2. treść formularza z ustawień wchodzi do zapisu DOSŁOWNIE,
//   3. wycofanie zgody w rozmowie zamyka kanał, a ponowna zgoda go otwiera -
//      rozstrzyga najpóźniejsze oświadczenie, nie istnienie jakiegokolwiek,
//   4. wpisy są nienaruszalne: po wycofaniu i ponownej zgodzie w bazie leżą
//      TRZY wiersze, a nie jeden podmieniony,
//   5. zgoda idzie za człowiekiem na kartotekę przy konwersji na klienta -
//      z zachowaniem pierwotnej daty oświadczenia.
//
// Czego ta próba NIE sprawdza: realnej wysyłki przez SMSAPI. To wymaga tokenu
// i kosztuje za sztukę; bramkę sprawdza się przyciskiem "Próba (bez wysyłki)"
// na ekranie Ustawienia -> Wiadomości SMS.

import "dotenv/config";

import { prisma } from "@/lib/prisma";
import { importLeadsFromCsv } from "@/lib/services/lead";
import {
  attachLeadConsentsToMember,
  mayReceiveMarketingSms,
  recordContactConsent,
  smsConsentHistory,
} from "@/lib/services/contact-consent";
import { buildSmsConsentText } from "@/lib/domain/contact-consent";

let bledy = 0;
function sprawdz(opis: string, warunek: boolean, szczegol = "") {
  console.log(`  ${warunek ? "OK  " : "BŁĄD"}  ${opis}${szczegol ? ` (${szczegol})` : ""}`);
  if (!warunek) bledy++;
}

const TRESC_FORMULARZA =
  "Treningi odbywaja sie w Czapla Boxing, Niepodleglosci 188 Tychy - czy Ci to pasuje?";

async function main() {
  const [trener, sala, admin] = await Promise.all([
    prisma.trainer.findFirst({ select: { id: true } }),
    prisma.location.findFirst({ where: { isDemo: false }, select: { id: true } }),
    prisma.user.findFirst({ where: { role: "ADMIN", isDemo: false }, select: { id: true } }),
  ]);
  if (!trener || !sala || !admin) {
    console.error("Baza deweloperska niekompletna. Uruchom: npm run db:setup");
    process.exitCode = 1;
    return;
  }

  // Numer spoza puli klubu - dziewięć cyfr zaczynających się od 5, jak numery
  // komórkowe, ale z sufiksem po znaczniku czasu, żeby nie trafić w prawdziwy
  // wpis w bazie deweloperskiej.
  const numer = `+485${String(Date.now()).slice(-8)}`;
  const csv = `Imię Nazwisko,Numer Telefonu\nPróba Zgody,${numer}\n`;

  const leadIds: string[] = [];
  const memberIds: string[] = [];
  // Ustawienie klubu zmieniamy na czas próby i przywracamy w `finally` -
  // baza deweloperska jest wspólna i ma zostać taka, jaka była.
  const ustawieniaPrzed = await prisma.clubSettings.findUnique({
    where: { id: "singleton" },
    select: { leadConsentText: true, dataController: true },
  });

  try {
    await prisma.clubSettings.upsert({
      where: { id: "singleton" },
      create: { id: "singleton", leadConsentText: TRESC_FORMULARZA },
      update: { leadConsentText: TRESC_FORMULARZA },
    });

    console.log("=== 1. Import leada z kampanii ===");
    const wynik = await importLeadsFromCsv({ csv, actorUserId: admin.id });
    sprawdz("wgrano jednego leada", wynik.created === 1, `created=${wynik.created}`);

    const lead = await prisma.lead.findFirstOrThrow({
      where: { phone: numer },
      select: { id: true, importedAt: true },
    });
    leadIds.push(lead.id);

    const poImporcie = await smsConsentHistory({ leadId: lead.id });
    sprawdz("zgoda powstała razem z leadem", poImporcie.length === 1, `${poImporcie.length} wpis.`);
    sprawdz("zgoda jest udzielona, nie odmowna", poImporcie[0]?.granted === true);
    sprawdz(
      "data oświadczenia to moment importu",
      poImporcie[0]?.grantedAt.getTime() === lead.importedAt.getTime(),
    );
    sprawdz("źródłem jest formularz kampanii", poImporcie[0]?.source === "META_LEAD_ADS");
    sprawdz(
      "treść formularza wpisana DOSŁOWNIE",
      poImporcie[0]?.textSnapshot.includes(TRESC_FORMULARZA) === true,
    );
    sprawdz("wolno wysłać powitanie", await mayReceiveMarketingSms({ leadId: lead.id }));

    console.log("\n=== 2. Rozmówca prosi o zaprzestanie ===");
    await recordContactConsent(prisma, {
      leadId: lead.id,
      channel: "SMS",
      granted: false,
      grantedAt: new Date(),
      source: "ROZMOWA_TELEFONICZNA",
      textSnapshot: buildSmsConsentText("Czapla Boxing (próba)"),
      recordedByUserId: admin.id,
      note: "Rozmówca poprosił o zaprzestanie wysyłania SMS-ów.",
    });
    sprawdz("kanał zamknięty", (await mayReceiveMarketingSms({ leadId: lead.id })) === false);
    sprawdz(
      "stara zgoda NIE została skasowana - wpisy są nienaruszalne",
      (await smsConsentHistory({ leadId: lead.id })).length === 2,
    );

    console.log("\n=== 3. Zmiana zdania w kolejnej rozmowie ===");
    await recordContactConsent(prisma, {
      leadId: lead.id,
      channel: "SMS",
      granted: true,
      grantedAt: new Date(Date.now() + 1000),
      source: "ROZMOWA_TELEFONICZNA",
      textSnapshot: buildSmsConsentText("Czapla Boxing (próba)"),
      recordedByUserId: admin.id,
    });
    sprawdz("kanał znów otwarty", await mayReceiveMarketingSms({ leadId: lead.id }));
    const historia = await smsConsentHistory({ leadId: lead.id });
    sprawdz("w bazie leżą wszystkie trzy oświadczenia", historia.length === 3);
    sprawdz("najnowsze jest na górze listy", historia[0]?.granted === true);

    console.log("\n=== 4. Konwersja leada na klubowicza ===");
    const member = await prisma.member.create({
      data: {
        firstName: "Próba",
        lastName: "Zgody",
        birthDate: new Date("1994-05-05"),
        isMinor: false,
        ownerTrainerId: trener.id,
        homeLocationId: sala.id,
      },
      select: { id: true },
    });
    memberIds.push(member.id);

    await attachLeadConsentsToMember(prisma, { leadId: lead.id, memberId: member.id });
    sprawdz(
      "zgoda poszła za człowiekiem na kartotekę",
      await mayReceiveMarketingSms({ memberId: member.id }),
    );
    const naKartotece = await smsConsentHistory({ memberId: member.id });
    sprawdz("komplet historii, nie ostatni wpis", naKartotece.length === 3);
    sprawdz(
      "data pierwszego oświadczenia nietknięta",
      naKartotece.at(-1)?.grantedAt.getTime() === lead.importedAt.getTime(),
    );
  } finally {
    await prisma.contactConsent.deleteMany({
      where: { OR: [{ leadId: { in: leadIds } }, { memberId: { in: memberIds } }] },
    });
    await prisma.leadActivity.deleteMany({ where: { leadId: { in: leadIds } } });
    await prisma.lead.deleteMany({ where: { id: { in: leadIds } } });
    await prisma.member.deleteMany({ where: { id: { in: memberIds } } });
    if (ustawieniaPrzed) {
      await prisma.clubSettings.update({
        where: { id: "singleton" },
        data: {
          leadConsentText: ustawieniaPrzed.leadConsentText,
          dataController: ustawieniaPrzed.dataController,
        },
      });
    }
    console.log("\nPosprzątane.");
  }

  console.log(
    bledy === 0
      ? "\nOK: zgoda na SMS powstaje z leadem, da się ją cofnąć i idzie za człowiekiem."
      : `\nBŁĘDÓW: ${bledy}`,
  );
  if (bledy > 0) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
