import "server-only";
import type { Prisma, PrismaClient } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import {
  SMS_CONSENT_VERSION,
  consentInForce,
  smsConsentState,
  type SmsConsentState,
} from "@/lib/domain/contact-consent";

type Tx = PrismaClient | Prisma.TransactionClient;

// Jedyne miejsce zapisu zgody na kanał kontaktu.
//
// Wpisy są nienaruszalne: cofnięcie zgody to NOWY wiersz z `granted: false`,
// nie edycja starego ani skasowanie. Trzeba udowodnić stan z konkretnego dnia
// ("czy wolno było wysłać SMS-a trzeciego marca"), a nie stan dzisiejszy - ta
// sama zasada, co przy księdze wpłat.
export async function recordContactConsent(
  tx: Tx,
  input: {
    leadId?: string | null;
    memberId?: string | null;
    channel: "SMS" | "EMAIL" | "PHONE_CALL";
    granted: boolean;
    // MOMENT OŚWIADCZENIA, nie moment wpisania do systemu.
    grantedAt: Date;
    source: "META_LEAD_ADS" | "ROZMOWA_TELEFONICZNA" | "FORMULARZ_WWW" | "PANEL_KLUBU";
    textSnapshot: string;
    textVersion?: string;
    recordedByUserId?: string | null;
    note?: string | null;
  },
): Promise<void> {
  await tx.contactConsent.create({
    data: {
      leadId: input.leadId ?? null,
      memberId: input.memberId ?? null,
      channel: input.channel,
      granted: input.granted,
      grantedAt: input.grantedAt,
      source: input.source,
      textSnapshot: input.textSnapshot,
      textVersion: input.textVersion ?? SMS_CONSENT_VERSION,
      recordedByUserId: input.recordedByUserId ?? null,
      note: input.note ?? null,
    },
  });
}

export type ConsentRow = {
  id: string;
  granted: boolean;
  grantedAt: Date;
  source: string;
  textSnapshot: string;
  note: string | null;
  recordedAt: Date;
};

// Historia zgód na SMS - do wyświetlenia na karcie leada i klubowicza.
// Najnowsze na górze, bo to one rozstrzygają, czy wolno wysłać.
export async function smsConsentHistory(where: {
  leadId?: string;
  memberId?: string;
}): Promise<ConsentRow[]> {
  const rows = await prisma.contactConsent.findMany({
    where: {
      channel: "SMS",
      ...(where.leadId ? { leadId: where.leadId } : {}),
      ...(where.memberId ? { memberId: where.memberId } : {}),
    },
    orderBy: { grantedAt: "desc" },
    select: {
      id: true,
      granted: true,
      grantedAt: true,
      source: true,
      textSnapshot: true,
      note: true,
      recordedAt: true,
    },
  });
  return rows;
}

export async function smsConsentFor(where: {
  leadId?: string;
  memberId?: string;
}): Promise<SmsConsentState> {
  return smsConsentState(await smsConsentHistory(where));
}

// Czy DZIŚ wolno wysłać SMS marketingowy. Osobno od stanu, bo wywołujący
// pyta o decyzję ("wysyłać?"), a nie o etykietę na ekranie.
export async function mayReceiveMarketingSms(where: {
  leadId?: string;
  memberId?: string;
}): Promise<boolean> {
  return consentInForce(await smsConsentHistory(where));
}

// Zgody leada przechodzą na kartotekę przy konwersji na klienta.
//
// Nie przepisujemy ich na nowe wiersze, tylko DOPINAMY `memberId` do
// istniejących: data oświadczenia i treść klauzuli mają zostać takie, jakie
// były. Kopia z nową datą byłaby cofnięciem dowodu do dnia konwersji.
export async function attachLeadConsentsToMember(
  tx: Tx,
  input: { leadId: string; memberId: string },
): Promise<void> {
  await tx.contactConsent.updateMany({
    where: { leadId: input.leadId, memberId: null },
    data: { memberId: input.memberId },
  });
}
