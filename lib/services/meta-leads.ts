import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";
import { prisma } from "@/lib/prisma";
import {
  extractLeadFields,
  parseLeadgenWebhook,
  placeholderName,
  type MetaFieldEntry,
  type MetaLeadgenEntry,
} from "@/lib/domain/meta-leads";
import { parseLeadPhone } from "@/lib/domain/lead-import";
import { logLeadActivity } from "@/lib/services/lead";

// Automatyczny import leadów z Meta zamiast wklejania CSV.
//
// Konfiguracja siedzi w zmiennych środowiskowych, bo to sekrety wdrożenia,
// a nie ustawienie klubu:
//   META_VERIFY_TOKEN  - hasło do jednorazowej weryfikacji adresu w Meta
//   META_APP_SECRET    - do sprawdzania podpisu każdego wywołania
//   META_ACCESS_TOKEN  - token strony, do pobrania treści zgłoszenia z Graph API
//
// Poprzednia wersja tego gniazda odpytywała Graph API co jakiś czas. Webhook
// jest lepszy z dwóch powodów: lead trafia do kartoteki w sekundę po wysłaniu
// formularza (a nie po najbliższym przebiegu), i nie trzeba pilnować harmonogramu,
// który potrafi po cichu przestać chodzić.
//
// Bez tokenu strony nadal przyjmujemy zgłoszenia (zapisujemy sam fakt), bo
// zgubiony lead to zgubiony klient. Braki widać w kartotece jako "do
// uzupełnienia", zamiast znikać po cichu.

const GRAPH_VERSION = "v21.0";

export type MetaConfig = {
  verifyToken: string | null;
  appSecret: string | null;
  pageAccessToken: string | null;
};

export function readMetaConfig(): MetaConfig {
  return {
    verifyToken: process.env.META_VERIFY_TOKEN || null,
    appSecret: process.env.META_APP_SECRET || null,
    pageAccessToken: process.env.META_ACCESS_TOKEN || null,
  };
}

// Czy gniazdo jest gotowe przyjmować zgłoszenia. Komplet do WERYFIKACJI to
// token weryfikacyjny i sekret aplikacji; token strony dokłada tylko treść
// zgłoszenia, więc jego brak nie wyłącza gniazda.
export function isMetaWebhookReady(config: MetaConfig = readMetaConfig()): boolean {
  return Boolean(config.verifyToken && config.appSecret);
}

// Nazwa używana przez ekran leadów od pierwszej wersji gniazda.
export function isMetaLeadsConfigured(): boolean {
  return isMetaWebhookReady();
}

// Czy dane osoby przyjdą automatycznie, czy trzeba je uzupełniać ręcznie.
export function canFetchLeadDetails(config: MetaConfig = readMetaConfig()): boolean {
  return Boolean(config.pageAccessToken);
}

// Podpis Meta: HMAC-SHA256 z surowego ciała żądania, kluczem jest sekret
// aplikacji. Bez tego każdy, kto zna adres, mógłby wstrzykiwać leady.
export function verifyMetaSignature(rawBody: string, header: string | null): boolean {
  const { appSecret } = readMetaConfig();
  if (!appSecret || !header) return false;

  const expected = `sha256=${createHmac("sha256", appSecret).update(rawBody).digest("hex")}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(header);
  // Porównanie stałoczasowe - czas odpowiedzi nie może zdradzać, ile znaków
  // podpisu się zgadza.
  return a.length === b.length && timingSafeEqual(a, b);
}

type GraphLead = {
  field_data?: MetaFieldEntry[];
  created_time?: string;
  campaign_name?: string;
  ad_name?: string;
};

// Treść zgłoszenia z Graph API. Zwraca null, gdy nie ma tokenu albo Meta
// odmówiła - wywołujący zapisze wtedy sam fakt zgłoszenia.
async function fetchLeadDetails(leadgenId: string): Promise<GraphLead | null> {
  const { pageAccessToken } = readMetaConfig();
  if (!pageAccessToken) return null;

  const url = new URL(`https://graph.facebook.com/${GRAPH_VERSION}/${leadgenId}`);
  url.searchParams.set("access_token", pageAccessToken);
  url.searchParams.set("fields", "field_data,created_time,campaign_name,ad_name");

  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) {
      console.warn(`[meta] Graph API odmówiło dla ${leadgenId}: ${res.status}`);
      return null;
    }
    return (await res.json()) as GraphLead;
  } catch (cause) {
    console.warn(`[meta] Nie udało się pobrać ${leadgenId}:`, cause);
    return null;
  }
}

export type MetaImportResult = { created: number; duplicates: number; incomplete: number };

// Zapisuje zgłoszenia z webhooka. Dedup po (source, externalId) - Meta potrafi
// ponowić to samo wywołanie, gdy nie odpowiemy dość szybko, a podwójny lead
// w kartotece znaczy dwa telefony do tej samej osoby.
export async function importLeadgenEntries(
  entries: readonly MetaLeadgenEntry[],
): Promise<MetaImportResult> {
  const result: MetaImportResult = { created: 0, duplicates: 0, incomplete: 0 };

  for (const entry of entries) {
    const existing = await prisma.lead.findFirst({
      where: { source: "FACEBOOK", externalId: entry.leadgenId },
      select: { id: true },
    });
    if (existing) {
      result.duplicates++;
      continue;
    }

    const details = await fetchLeadDetails(entry.leadgenId);
    const fields = details?.field_data ? extractLeadFields(details.field_data) : null;
    const complete = Boolean(fields?.fullName);
    if (!complete) result.incomplete++;

    const lead = await prisma.lead.create({
      data: {
        source: "FACEBOOK",
        externalId: entry.leadgenId,
        fullName: fields?.fullName ?? placeholderName(entry.leadgenId),
        email: fields?.email ?? null,
        phone: fields?.phone ? parseLeadPhone(fields.phone) : null,
        campaign: details?.campaign_name ?? details?.ad_name ?? null,
        // Surowa odpowiedź zostaje: gdy formularz w Meta ma nietypowe pola,
        // klub odczyta je z karty leada, zamiast szukać w Menedżerze reklam.
        rawData: (details ?? { leadgen_id: entry.leadgenId }) as object,
        importedAt: entry.createdTime ?? new Date(),
      },
    });

    await logLeadActivity(prisma, {
      leadId: lead.id,
      actorUserId: null,
      kind: "IMPORTED",
      summary: complete
        ? "Zaimportowano automatycznie z Meta"
        : "Zgłoszenie z Meta - brak tokenu do pobrania danych, uzupełnij ręcznie",
    });

    result.created++;
  }

  return result;
}

export async function handleLeadgenWebhook(body: unknown): Promise<MetaImportResult> {
  return importLeadgenEntries(parseLeadgenWebhook(body));
}
