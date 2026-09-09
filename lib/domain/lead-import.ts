// Parsowanie CSV z leadami (Meta Lead Ads / Ads Manager). Czyste funkcje, bez
// bazy - w pełni testowalne. Układ kolumn w eksportach Meta bywa różny (język,
// wersja formularza), więc mapujemy znane nagłówki elastycznie, a wszystko inne
// zachowujemy w rawData, żeby nic nie zgubić.

import type { LeadSource, LeadStatus } from "@/app/generated/prisma/client";
import { parsePhoneOrNull } from "@/lib/domain/phone";

export const LEAD_SOURCE_LABEL: Record<LeadSource, string> = {
  FACEBOOK: "Facebook",
  INSTAGRAM: "Instagram",
  META_OTHER: "Meta",
  MANUAL: "Ręcznie",
};

export const LEAD_STATUS_LABEL: Record<LeadStatus, string> = {
  NEW: "Nowy",
  IN_PROGRESS: "W kontakcie",
  CALLBACK: "Do oddzwonienia",
  CONFIRMED: "Potwierdzony",
  CONVERTED: "Konto założone",
  REJECTED: "Bez zainteresowania",
};

// Statusy w kolejności lejka - do filtrów i przycisków zmiany statusu.
export const LEAD_STATUS_ORDER: LeadStatus[] = [
  "NEW",
  "IN_PROGRESS",
  "CALLBACK",
  "CONFIRMED",
  "CONVERTED",
  "REJECTED",
];

export type ParsedLead = {
  fullName: string;
  email: string | null;
  phone: string | null;
  source: LeadSource;
  campaign: string | null;
  externalId: string | null;
  rawData: Record<string, string>;
};

export type ParseResult = { leads: ParsedLead[]; skipped: number };

// Rozbicie pełnego imienia z leada na imię i nazwisko dla kartoteki klienta
// (Member trzyma je osobno). Pierwsze słowo to imię, reszta to nazwisko -
// obsługuje wieloczłonowe nazwiska ("Anna Kowalska-Nowak"). To tylko wstępne
// wypełnienie formularza konwersji; obsługujący może poprawić przed zapisem.
export function splitFullName(fullName: string): { firstName: string; lastName: string } {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: "", lastName: "" };
  if (parts.length === 1) return { firstName: parts[0], lastName: "" };
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}

// Numer telefonu z leada. Meta poprzedza go w eksporcie CSV znacznikiem `p:`
// (`p:+48571277686`, `p:605687770`) - to nie jest część numeru, tylko marker
// typu pola, więc ścinamy go, zanim numer trafi do parsera.
//
// Samo rozstrzyganie oddajemy `parsePhone` (`lib/domain/phone.ts`), bo to
// jedyne miejsce w systemie, które wie, co jest numerem. Wcześniej import miał
// własną, słabszą wersję: przepuszczała `48661535704` i `605687770` bez zmian,
// więc ten sam człowiek lądował w bazie pod trzema różnymi zapisami
// (`+48605687770`, `605687770`, `48605687770`), nie dawał się odnaleźć przy
// powtórnym imporcie i wyglądał w kartotece jak trzy osoby. Dokładnie przed tym
// ostrzega komentarz w phone.ts - a import go omijał.
export function parseLeadPhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const bezMarkera = raw.replace(/^\s*p\s*:\s*/i, "").trim();
  const cyfry = bezMarkera.replace(/[\s()-]/g, "");

  // Meta pisze numer z kierunkowym, ale BEZ plusa: `48661535704`, `31613737346`.
  // Wspólny parser czyta numer bez plusa jako krajowy dziewięciocyfrowy, więc
  // odrzucał wszystko, co Meta wyeksportowała w tej postaci - na realnym pliku
  // klubu 171 numerów ze 185. Dokładamy plus tylko tutaj, bo to jest quirk
  // eksportu z Meta, a nie nowa reguła dla numerów wpisywanych w panelu: tam
  // „11 cyfr bez plusa” zwykle znaczy literówkę i ma się odbić o komunikat.
  const zKierunkowym =
    /^\d{10,15}$/.test(cyfry) && !cyfry.startsWith("0") ? `+${cyfry}` : bezMarkera;

  return parsePhoneOrNull(zKierunkowym);
}

// Treść SMS powitalnego po rozmowie z leadem. Krótko (jeden segment SMS to 160
// znaków), z imieniem, jeśli je znamy. Brand klienta to "Czapla Boxing".
export function buildWelcomeSms(firstName: string): string {
  const name = firstName.trim();
  const hello = name.length > 0 ? `Cześć ${name}!` : "Cześć!";
  return `${hello} Dziękujemy za rozmowę. Czekamy na Ciebie w Czapla Boxing - odezwij się, gdy zdecydujesz się na trening. Do zobaczenia!`;
}

// Parser CSV z obsługą cudzysłowów, przecinków i nowych linii w polach oraz
// podwojonego cudzysłowu ("") jako znaku dosłownego. Zwraca wiersze surowych pól.
export function parseCsv(input: string): string[][] {
  const s = input.replace(/\r\n?/g, "\n");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  row.push(field);
  rows.push(row);

  // Odsiewamy wiersze całkowicie puste (np. pusta linia na końcu pliku).
  return rows.filter((r) => r.some((cell) => cell.trim().length > 0));
}

// Nagłówki porównujemy BEZ polskich znaków, więc aliasy są tu w wersji ASCII.
// Powód z realnego pliku klubu: kolumna nazywa się "Imię Nazwisko" (bez "i"),
// a alias brzmiał "imię i nazwisko" - nie pasował, więc parser nie znajdował
// kolumny z nazwiskiem i podstawiał w to miejsce numer telefonu. Cały plik,
// 185 osób, wjeżdżałby do klubu z imieniem "p:+48571277686".
const NAME_ALIASES = [
  "full_name",
  "full name",
  "imie i nazwisko",
  "imie nazwisko",
  "imie i naz",
  "name",
  "nazwa",
  "imie",
];
const EMAIL_ALIASES = ["email", "e-mail", "adres e-mail"];
const PHONE_ALIASES = ["phone_number", "phone number", "phone", "numer telefonu", "telefon"];
const CAMPAIGN_ALIASES = ["campaign_name", "campaign", "kampania", "form_name", "formularz"];
const PLATFORM_ALIASES = ["platform", "zrodlo"];
const ID_ALIASES = ["lead_id", "id"];

// Bez ogonków, bez wielkości liter, bez podwójnych spacji. "ł" nie rozkłada się
// w NFD (to osobny znak, nie "l" z kreską), więc podmieniamy je wprost.
function normalize(h: string): string {
  return h
    .trim()
    .toLowerCase()
    .replace(/ł/g, "l")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ");
}

function findColumn(header: string[], aliases: string[], exact = false): number {
  return header.findIndex((h) => aliases.some((a) => (exact ? h === a : h.includes(a))));
}

function platformToSource(value: string | null): LeadSource {
  const v = (value ?? "").toLowerCase();
  if (v.includes("insta") || v === "ig") return "INSTAGRAM";
  if (v.includes("face") || v === "fb") return "FACEBOOK";
  return "META_OTHER";
}

// Mapuje sparsowany CSV (z wierszem nagłówka) na leady. Pomija wiersze bez
// żadnej treści (skipped). fullName ma fallback na e-mail/telefon, żeby lead
// bez podanego imienia nadal trafił na listę do obdzwonienia.
export function parseLeadsCsv(input: string): ParseResult {
  const rows = parseCsv(input);
  if (rows.length < 2) return { leads: [], skipped: 0 };

  const header = rows[0].map(normalize);
  const nameI = findColumn(header, NAME_ALIASES);
  const emailI = findColumn(header, EMAIL_ALIASES);
  const phoneI = findColumn(header, PHONE_ALIASES);
  const campaignI = findColumn(header, CAMPAIGN_ALIASES);
  const platformI = findColumn(header, PLATFORM_ALIASES);
  const idI = findColumn(header, ID_ALIASES, true);

  const leads: ParsedLead[] = [];
  let skipped = 0;

  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    const at = (i: number): string | null => {
      if (i < 0 || i >= cells.length) return null;
      const v = cells[i].trim();
      return v.length > 0 ? v : null;
    };

    const email = at(emailI);
    // Numer sprowadzamy do jednej postaci (+48...) OD RAZU, a nie dopiero przy
    // wysyłce: to on jest kluczem, po którym poznajemy, że ten sam człowiek
    // przyszedł drugi raz. Surowy zapis z pliku zostaje w rawData.
    const phoneRaw = at(phoneI);
    const phone = parseLeadPhone(phoneRaw);
    const fullName = at(nameI) ?? email ?? phone ?? phoneRaw;
    if (!fullName) {
      skipped++;
      continue;
    }

    const rawData: Record<string, string> = {};
    for (let c = 0; c < header.length; c++) {
      const key = rows[0][c]?.trim();
      const val = cells[c]?.trim();
      if (key && val) rawData[key] = val;
    }

    leads.push({
      fullName,
      email,
      phone,
      source: platformToSource(at(platformI)),
      campaign: at(campaignI),
      externalId: at(idI),
      rawData,
    });
  }

  return { leads, skipped };
}

// Odczyt imienia i numeru z `rawData` już zapisanego leada.
//
// Potrzebne do naprawy tego, co weszło do bazy, ZANIM parser nauczył się czytać
// nagłówek "Imię Nazwisko": takie leady mają w polu `fullName` numer telefonu.
// Nic nie zginęło - `rawData` od początku trzyma cały wiersz z pliku, więc
// nazwisko da się odzyskać bez ponownego wgrywania czegokolwiek.
//
// Ta sama tablica aliasów co przy imporcie, żeby naprawa i import nie miały jak
// się rozjechać.
export function leadFieldsFromRaw(raw: Record<string, unknown>): {
  fullName: string | null;
  phone: string | null;
} {
  const wpisy = Object.entries(raw).filter(
    (e): e is [string, string] => typeof e[1] === "string" && e[1].trim().length > 0,
  );
  const znajdz = (aliases: string[]): string | null => {
    const trafienie = wpisy.find(([klucz]) => {
      const k = normalize(klucz);
      return aliases.some((a) => k.includes(a));
    });
    return trafienie ? trafienie[1].trim() : null;
  };

  return {
    fullName: znajdz(NAME_ALIASES),
    phone: parseLeadPhone(znajdz(PHONE_ALIASES)),
  };
}

// Po czym poznajemy, że to ten sam człowiek.
//
// NIGDY po nazwisku. Klub ma prawdziwych Nowaków, a w eksportach Meta imiona
// bywają jednowyrazowe ("Karolina", "kuba"), ozdobne ("𝕵𝖚𝖗𝖆𝖓𝖉") albo są nazwą
// firmy - dwie różne osoby potrafią wyglądać identycznie.
//
// Rozstrzyga numer telefonu, bo to jedyna rzecz, którą Meta zbiera obowiązkowo
// i która należy do jednej osoby. E-mail jako zapas, gdy numeru brak. Bez
// obu - nie udajemy, że wiemy: lead wchodzi, a ewentualną dublę wyłapie
// człowiek na liście.
export function leadIdentity(lead: { phone: string | null; email: string | null }): string | null {
  if (lead.phone) return `tel:${lead.phone}`;
  if (lead.email) return `mail:${lead.email.trim().toLowerCase()}`;
  return null;
}

// Dublety WEWNĄTRZ jednego pliku. W realnym eksporcie klubu dwie osoby były
// wpisane dwa razy (ten sam numer, ta sama treść) - bez tego kroku klub
// dostałby je na liście podwójnie i obdzwaniał dwa razy.
export function dedupeLeads(leads: ParsedLead[]): { unique: ParsedLead[]; duplicates: number } {
  const widziane = new Set<string>();
  const unique: ParsedLead[] = [];
  let duplicates = 0;

  for (const lead of leads) {
    const key = leadIdentity(lead);
    if (key && widziane.has(key)) {
      duplicates++;
      continue;
    }
    if (key) widziane.add(key);
    unique.push(lead);
  }

  return { unique, duplicates };
}

// Treść e-maila powitalnego - alternatywa dla SMS-a. Ten sam moment kontaktu,
// inny kanał: SMS trafia szybciej, mail unosi więcej treści i nic nie kosztuje,
// dopóki klub nie ma bramki SMS.
export function buildWelcomeEmail(firstName: string): { subject: string; text: string } {
  const name = firstName.trim();
  const hello = name.length > 0 ? `Cześć ${name}!` : "Cześć!";
  return {
    subject: "Czapla Boxing - dziękujemy za rozmowę",
    text: [
      hello,
      "",
      "Dziękujemy za rozmowę. Cieszymy się, że myślisz o treningu u nas.",
      "",
      "Gdy zdecydujesz się przyjść, odezwij się - dobierzemy grupę i godzinę do Twojego planu.",
      "Pierwszy trening jest po to, żebyś sprawdził(a), czy to miejsce dla Ciebie.",
      "",
      "Do zobaczenia na sali,",
      "Czapla Boxing",
    ].join("\n"),
  };
}

// Kanał powitania wybrany przez obsługującego lead.
export type WelcomeChannel = "NONE" | "SMS" | "EMAIL" | "BOTH";

export function parseWelcomeChannel(raw: string | null | undefined): WelcomeChannel {
  return raw === "SMS" || raw === "EMAIL" || raw === "BOTH" ? raw : "NONE";
}

// Czego brakuje, żeby wysłać powitanie wybranym kanałem. null = da się wysłać.
// Sprawdzamy PRZED zapisem, bo komunikat "podaj numer" po fakcie jest bez
// wartości - podsumowanie już by się zapisało, a SMS nie poszedł.
export function missingWelcomeContact(
  channel: WelcomeChannel,
  contact: { phone: string | null; email: string | null },
): string | null {
  const needsPhone = channel === "SMS" || channel === "BOTH";
  const needsEmail = channel === "EMAIL" || channel === "BOTH";
  if (needsPhone && !contact.phone)
    return "Aby wysłać SMS powitalny, podaj poprawny numer telefonu.";
  if (needsEmail && !contact.email) return "Aby wysłać e-mail powitalny, podaj adres e-mail leada.";
  return null;
}
