// Zapisy zrobione bez łącza - czysta część, bez localStorage i bez bazy.
//
// Pomysł przeniesiony z toPROductive (src/sync/stanPolaczenia.js + kolejka
// w src/sync/dbServer.js), ale reguła jest ta sama i wzięła się z tego samego
// powodu: na sali sieć potrafi paść w środku zajęć, a odbicia muszą iść dalej.
// Zapis bez łącza NIE przepada i NIE idzie po cichu na serwer - ląduje
// w kolejce, a po powrocie sieci człowiek widzi listę i sam decyduje, czy ją
// dopisać. Automat byłby groźny: dwie osoby mogły offline ruszyć ten sam
// termin, a cichy zapis skasowałby cudzą zmianę bez śladu.
//
// Kolejkujemy wyłącznie zdarzenia z sali ("ten człowiek był tu o tej godzinie"),
// bo one się dopisują, a nie nadpisują - dwóch trenerów offline nie zrobi sobie
// nawzajem krzywdy. Reszta panelu bez sieci działa tylko do odczytu.

export type OfflineOp =
  // Stacja wejścia (/skaner): personel skanuje osobisty kod QR klubowicza.
  | "WEJSCIE_NA_SALE"
  // Kiosk (/kod-zajec): kamera czyta osobisty kod rotacyjny prowadzącego lub
  // klubowicza i odbija go na trwających zajęciach.
  | "ODBICIE_NA_ZAJECIACH"
  // Trener zaznacza obecność ręcznie na liście "Dziś".
  | "OBECNOSC_RECZNA"
  // Trener zatwierdza policzoną na sali liczbę obecnych.
  | "POTWIERDZENIE_OBECNOSCI"
  // Klubowicz melduje się sam z kodu na ścianie (/qr/[locationId]).
  | "MELDUNEK_KLUBOWICZA";

// Nagłówek pozycji na liście do zatwierdzenia. Ma dać się rozpoznać bez
// zaglądania w bazę - to jedyne, co człowiek zobaczy przed kliknięciem
// "Dopisz do bazy".
export const OP_LABEL: Record<OfflineOp, string> = {
  WEJSCIE_NA_SALE: "Wejście na salę",
  ODBICIE_NA_ZAJECIACH: "Odbicie na zajęciach",
  OBECNOSC_RECZNA: "Obecność zaznaczona ręcznie",
  POTWIERDZENIE_OBECNOSCI: "Potwierdzenie listy obecności",
  MELDUNEK_KLUBOWICZA: "Meldunek klubowicza",
};

export type OfflineEntry = {
  id: string;
  op: OfflineOp;
  // Moment, w którym rzecz WYDARZYŁA SIĘ na sali - nie moment wysyłki. To on
  // trafia do bazy, bo inaczej odbicie z 18:05 wylądowałoby o 21:30 i rozjechało
  // godziny obecności oraz okna ważności kodów.
  recordedAtIso: string;
  // Co pokazać na liście, np. "Kowalski Jan" albo "Boks 18:00".
  detail: string;
  payload: Record<string, string>;
  // Powód, dla którego serwer odmówił przy poprzedniej próbie wysyłki.
  error?: string;
};

// Ile czasu zapis może przeleżeć w kolejce. Doba to sensowna górna granica dla
// "sieć padła w trakcie zajęć": po tylu godzinach dopisanie obecności wstecz
// jest już decyzją kadrową, a nie synchronizacją - i ma iść przez panel, gdzie
// widać kto i co zmienił.
export const MAX_OFFLINE_AGE_HOURS = 24;

// Zegar tabletu bywa rozjechany o parę minut. Tyle wybaczamy w przód; więcej
// znaczy, że data jest podrobiona albo urządzenie ma zepsuty czas - w obu
// wypadkach lepiej odmówić niż zapisać obecność "z przyszłości".
const FUTURE_TOLERANCE_MINUTES = 5;

export type RecordedAtRejection = "BRAK_DATY" | "Z_PRZYSZLOSCI" | "ZA_STARY";

export type RecordedAtResult = { ok: true; at: Date } | { ok: false; reason: RecordedAtRejection };

export const RECORDED_AT_MESSAGE: Record<RecordedAtRejection, string> = {
  BRAK_DATY: "Zapis bez poprawnej daty zdarzenia - nie da się go dopisać wstecz.",
  Z_PRZYSZLOSCI: "Urządzenie podało datę z przyszłości - sprawdź zegar tabletu.",
  ZA_STARY: `Zapis starszy niż ${MAX_OFFLINE_AGE_HOURS} h - dopisz go ręcznie w panelu.`,
};

// Serwer NIGDY nie bierze daty z przeglądarki na wiarę. Data zdarzenia jest
// potrzebna (odbicie ma trafić w swoją godzinę), ale musi mieścić się
// w przedziale, w którym "sieć padła na treningu" jest w ogóle możliwe.
export function resolveRecordedAt(iso: string | null | undefined, now: Date): RecordedAtResult {
  if (!iso) return { ok: false, reason: "BRAK_DATY" };
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return { ok: false, reason: "BRAK_DATY" };

  const aheadMinutes = (at.getTime() - now.getTime()) / 60_000;
  if (aheadMinutes > FUTURE_TOLERANCE_MINUTES) return { ok: false, reason: "Z_PRZYSZLOSCI" };
  // Drobne wyprzedzenie prostujemy do "teraz" zamiast odmawiać - rozjechany
  // o minutę zegar tabletu nie jest powodem, żeby zgubić odbicie.
  if (at.getTime() > now.getTime()) return { ok: true, at: now };

  const ageHours = (now.getTime() - at.getTime()) / 3_600_000;
  if (ageHours > MAX_OFFLINE_AGE_HOURS) return { ok: false, reason: "ZA_STARY" };

  return { ok: true, at };
}

// "1 zapis", "2 zapisy", "5 zapisów" - odmiana po polsku, bo ten licznik wisi
// w pasku u góry i czyta go człowiek, a nie log.
export function countLabel(n: number): string {
  const abs = Math.abs(n);
  if (abs === 1) return "1 zapis";
  const last = abs % 10;
  const lastTwo = abs % 100;
  const few = last >= 2 && last <= 4 && (lastTwo < 12 || lastTwo > 14);
  return `${n} ${few ? "zapisy" : "zapisów"}`;
}

// Ile minut trwa brak łącza - do podpisu "OFFLINE · od 12 min".
export function offlineSinceLabel(since: number | null, now: number): string {
  if (since == null) return "";
  const minutes = Math.floor((now - since) / 60_000);
  if (minutes < 1) return "przed chwilą";
  return `od ${minutes} min`;
}

// Zapisy, które wolno wysłać SAMEMU, bez pytania człowieka: te, których baza
// jeszcze nie odrzuciła.
//
// Pozycja z powodem odmowy zostaje na ekranie i czeka na decyzję. Gdyby automat
// próbował jej dalej, przy każdym pingu leciałby ten sam odrzucany zapis -
// a odmowa zwykle nie jest chwilowa (wygasła rezerwacja, brak uprawnień,
// zapis starszy niż doba). Ponowną próbę odpala człowiek.
export function autoSendable(entries: OfflineEntry[]): OfflineEntry[] {
  return entries.filter((entry) => !entry.error);
}

export function rejectedEntries(entries: OfflineEntry[]): OfflineEntry[] {
  return entries.filter((entry) => Boolean(entry.error));
}

export type FlushOutcome = { id: string; ok: boolean; error?: string };

// Wynik wysyłki nanoszony na kolejkę: udane znikają, nieudane zostają z
// powodem odmowy przy sobie. Nieudany zapis, który po cichu wyparowuje, jest
// gorszy niż brak kolejki - dlatego zostaje na liście, aż ktoś go odrzuci.
export function applyFlushOutcomes(
  entries: OfflineEntry[],
  outcomes: FlushOutcome[],
): OfflineEntry[] {
  const byId = new Map(outcomes.map((o) => [o.id, o]));
  return entries
    .filter((entry) => byId.get(entry.id)?.ok !== true)
    .map((entry) => {
      const outcome = byId.get(entry.id);
      if (!outcome || outcome.ok) return entry;
      return { ...entry, error: outcome.error ?? "Nie udało się dopisać." };
    });
}
