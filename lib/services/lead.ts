import "server-only";
import { Prisma, type PrismaClient, type LeadActivityKind } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import {
  LEAD_SOURCE_LABEL,
  dedupeLeads,
  leadIdentity,
  parseLeadsCsv,
} from "@/lib/domain/lead-import";

type Tx = PrismaClient | Prisma.TransactionClient;

// Jedno miejsce zapisu historii aktywności leada (kiedy kontakt, co ustalono,
// zmiany statusu, przypomnienia, konwersja). Zostaje przy leadzie także po
// założeniu konta - dzięki temu pełną historię widać również z karty klienta.
export async function logLeadActivity(
  tx: Tx,
  params: { leadId: string; actorUserId: string | null; kind: LeadActivityKind; summary: string },
) {
  await tx.leadActivity.create({
    data: {
      leadId: params.leadId,
      actorUserId: params.actorUserId,
      kind: params.kind,
      summary: params.summary,
    },
  });
}

export type ImportResult = {
  created: number;
  duplicates: number;
  skipped: number;
  // Kto konkretnie byl juz w bazie. Sama liczba nie wystarcza: "duplikaty: 3"
  // nie mowi, czy to ci sami ludzie co ostatnio, czy klub wlasnie stracil
  // trzech nowych chetnych przez zla kolumne w pliku.
  duplicateNames: string[];
};

// Import leadów z pliku CSV (eksport z Meta). Każdy nowy lead dostaje wpis
// IMPORTED w historii.
//
// Deduplikacja idzie po NUMERZE TELEFONU (a gdy go brak - po e-mailu), nie po
// `externalId`. Powód jest z realnego pliku klubu: eksport z Ads Managera nie
// ma kolumny `lead_id`, więc `externalId` był pusty dla każdego wiersza i całe
// zabezpieczenie nie robiło nic. Wgranie tego samego pliku drugi raz zakładało
// komplet leadów od nowa - 185 osób do obdzwonienia po raz drugi, z zerowaną
// historią kontaktu.
//
// `externalId` zostaje jako pierwsze kryterium, bo gdy Meta go poda, jest
// pewniejszy niż numer (ta sama osoba może wypełnić dwa różne formularze).
//
// Istniejącego leada NIE nadpisujemy. Klub mógł już zmienić status, dopisać
// notatkę albo umówić termin - świeży wiersz z pliku cofnąłby to wszystko do
// stanu "Nowy".
export async function importLeadsFromCsv(input: {
  csv: string;
  actorUserId: string;
}): Promise<ImportResult> {
  const { leads, skipped } = parseLeadsCsv(input.csv);

  // Najpierw dublety wewnątrz pliku - inaczej ten sam numer wchodziłby dwa
  // razy, bo drugiego jeszcze nie ma w bazie w chwili sprawdzania.
  const { unique, duplicates: wPliku } = dedupeLeads(leads);

  // Jedno zapytanie zamiast jednego na wiersz: przy 185 leadach to różnica
  // między jedną podróżą do bazy a stu osiemdziesięcioma.
  const telefony = unique.map((l) => l.phone).filter((p): p is string => Boolean(p));
  const maile = unique.map((l) => l.email).filter((e): e is string => Boolean(e));
  const znane = await prisma.lead.findMany({
    where: { OR: [{ phone: { in: telefony } }, { email: { in: maile } }] },
    select: { phone: true, email: true },
  });
  const wBazie = new Set(znane.map((l) => leadIdentity(l)).filter((k): k is string => k !== null));

  const zewnetrzne = unique.map((l) => l.externalId).filter((id): id is string => Boolean(id));
  const znaneZewnetrzne = new Set(
    zewnetrzne.length > 0
      ? (
          await prisma.lead.findMany({
            where: { externalId: { in: zewnetrzne } },
            select: { source: true, externalId: true },
          })
        ).map((l) => `${l.source}:${l.externalId}`)
      : [],
  );

  let created = 0;
  let duplicates = wPliku;
  const duplicateNames: string[] = [];

  for (const l of unique) {
    if (l.externalId && znaneZewnetrzne.has(`${l.source}:${l.externalId}`)) {
      duplicates++;
      duplicateNames.push(l.fullName);
      continue;
    }
    const key = leadIdentity(l);
    if (key && wBazie.has(key)) {
      duplicates++;
      duplicateNames.push(l.fullName);
      continue;
    }

    await prisma.$transaction(async (tx) => {
      const lead = await tx.lead.create({
        data: {
          source: l.source,
          externalId: l.externalId,
          fullName: l.fullName,
          email: l.email,
          phone: l.phone,
          campaign: l.campaign,
          rawData: l.rawData as Prisma.InputJsonValue,
        },
      });
      await logLeadActivity(tx, {
        leadId: lead.id,
        actorUserId: input.actorUserId,
        kind: "IMPORTED",
        summary: `Zaimportowano z: ${LEAD_SOURCE_LABEL[l.source]}${l.campaign ? ` · ${l.campaign}` : ""}`,
      });
    });
    // Numer dopisujemy do zbioru od razu: dwa wiersze bez numeru, ale z tym
    // samym e-mailem, też są jedną osobą.
    if (key) wBazie.add(key);
    created++;
  }

  return { created, duplicates, skipped, duplicateNames };
}
