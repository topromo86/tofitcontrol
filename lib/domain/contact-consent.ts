// Zgoda na kanał kontaktu (na razie: SMS).
//
// Do wiadomości SERWISOWEJ - odwołane zajęcia, zaległa wpłata, kończące się
// badania, reset hasła - żadna zgoda nie jest potrzebna: to nie jest
// informacja handlowa w rozumieniu art. 2 pkt 2 ustawy o świadczeniu usług
// drogą elektroniczną, do której odsyła art. 398 Prawa komunikacji
// elektronicznej. Wiadomość obsługuje coś, co już się wydarzyło.
//
// Do wiadomości MARKETINGOWEJ - powitanie leada, oferta, promocja, zaproszenie
// na trening - zgoda jest potrzebna i musi być UPRZEDNIA, czyli udzielona
// zanim wyjdzie pierwsza wiadomość. Zgody nie da się dobrać treścią samego
// SMS-a: "napisz TAK, jeśli chcesz dostawać naszą ofertę" jest już wysyłką
// w celu przesłania informacji handlowej.
//
// Zgoda na e-mail nie obejmuje SMS-a i odwrotnie - stąd kanał jest osobnym
// polem, a nie jedną flagą "zgoda marketingowa".

export const SMS_CONSENT_VERSION = "2026-09-10";

// Test na to, czy wiadomość wymaga zgody, jest jednozdaniowy i warto go mieć
// przed oczami przy pisaniu nowej treści.
export const SMS_MARKETING_TEST =
  "Czy ta wiadomość zmierza do tego, żeby odbiorca coś kupił? Jeśli tak - choćby pośrednio - to informacja handlowa i potrzeba zgody na SMS.";

// Klauzula, którą klub przedstawia przed zebraniem zgody. Do bazy trafia
// DOSŁOWNIE ta treść (`textSnapshot`), a nie odsyłacz do niej - klauzula na
// stronie się zmieni, a udowodnić trzeba to, co człowiek wtedy usłyszał.
//
// Bez identyfikacji administratora klauzula jest niekonkretna, więc wadliwa -
// dlatego nazwa podmiotu jest parametrem, a nie napisem w kodzie. Bierze się
// z ustawień klubu (ClubSettings.dataController).
export function buildSmsConsentText(dataController: string): string {
  const administrator = dataController.trim();
  return (
    `Wyrażam zgodę na otrzymywanie od ${administrator} informacji handlowych ` +
    "i marketingowych dotyczących oferty klubu (zajęcia, karnety, promocje) " +
    "w formie wiadomości SMS na podany przeze mnie numer telefonu. " +
    "Zgodę mogę wycofać w każdej chwili, kontaktując się z klubem; wycofanie " +
    "nie wpływa na zgodność z prawem działań podjętych przed jej wycofaniem."
  );
}

// To, co osoba dzwoniąca mówi w słuchawkę. Krótkie celowo: klauzula czytana
// w całości przez telefon kończy się tym, że nikt jej nie czyta, a pole i tak
// zostaje zaznaczone. Pełna treść idzie do bazy jako dowód, a rozmowa ma
// wystarczyć do świadomej odpowiedzi "tak" albo "nie".
export const SMS_CONSENT_SCRIPT =
  "Czy mogę wysyłać Panu/Pani SMS-y z informacjami o ofercie klubu na ten numer? Zgodę można wycofać w każdej chwili.";

// Zgoda leada z kampanii Meta.
//
// Lead z kampanii klubu NIE jest adresem kupionym ani pozyskanym z zewnątrz -
// człowiek sam zostawił numer w formularzu Czapla Boxing, odpowiadając na
// pytania o dojazd, cenę pierwszego treningu i powód, dla którego chce
// trenować. To jest zgłoszenie chęci kontaktu w sprawie oferty i tak jest
// zapisywane: przy imporcie każdy nowy lead dostaje zgodę na SMS.
//
// Czego eksport z Ads Managera NIE niesie i o czym trzeba wiedzieć: nie ma
// w nim ani kolumny zgody, ani czasu zgłoszenia. Dowodem pozostaje więc treść
// samego formularza kampanii - dlatego klub wkleja ją raz w ustawieniach
// (ClubSettings.leadConsentText), a system zapisuje ją dosłownie przy każdym
// imporcie. Bez tego zapis mówiłby tylko tyle, ile nasz własny opis.
export function buildLeadConsentText(formText: string | null): string {
  const wypowiedz = formText?.trim();
  return wypowiedz && wypowiedz.length > 0
    ? `Zgłoszenie w formularzu kampanii reklamowej Czapla Boxing (Meta Lead Ads). Treść formularza: ${wypowiedz}`
    : "Zgłoszenie w formularzu kampanii reklamowej Czapla Boxing (Meta Lead Ads) - osoba sama zostawiła numer telefonu, prosząc o kontakt w sprawie oferty klubu. Treść formularza nie została uzupełniona w ustawieniach.";
}

export const LEAD_CONSENT_TEXT_MISSING =
  "Wklej treść pytań i klauzuli z formularza kampanii. Bez niej zapis zgody opiera się na opisie systemu, a nie na tym, co lead realnie przeczytał.";

export const SMS_CONSENT_MISSING_CONTROLLER =
  "Wpisz pełną nazwę podmiotu, formę prawną, NIP i adres. Bez nich klauzula zgody jest niekonkretna i nie stanowi dowodu.";

export type ConsentEntry = {
  granted: boolean;
  grantedAt: Date;
};

// Czy zgoda obowiązuje DZIŚ.
//
// Wpisy są nienaruszalne, a cofnięcie to nowy wiersz z `granted: false` -
// więc rozstrzyga NAJPÓŹNIEJSZE oświadczenie, nie istnienie jakiegokolwiek.
// Bez tego jedno "tak" sprzed roku przebijałoby wczorajsze "proszę przestać".
export function consentInForce(entries: readonly ConsentEntry[]): boolean {
  let latest: ConsentEntry | null = null;
  for (const entry of entries) {
    if (!latest || entry.grantedAt.getTime() >= latest.grantedAt.getTime()) latest = entry;
  }
  return latest?.granted ?? false;
}

export type SmsConsentState = "BRAK" | "UDZIELONA" | "WYCOFANA";

export function smsConsentState(entries: readonly ConsentEntry[]): SmsConsentState {
  if (entries.length === 0) return "BRAK";
  return consentInForce(entries) ? "UDZIELONA" : "WYCOFANA";
}

export const SMS_CONSENT_LABEL: Record<SmsConsentState, string> = {
  BRAK: "Brak zgody na SMS",
  UDZIELONA: "Zgoda na SMS udzielona",
  WYCOFANA: "Zgoda na SMS wycofana",
};

export const SMS_CONSENT_STYLE: Record<SmsConsentState, string> = {
  BRAK: "text-muted-brand",
  UDZIELONA: "text-jade",
  WYCOFANA: "text-red",
};
