// Poprawianie pomyłek w kasie: anulowanie wpłaty i data wpłaty inna niż dziś.
//
// Czyste funkcje, bez bazy - reguły pieniężne mają dać się sprawdzić testem,
// a nie dopiero na kliencie klubu.
//
// Dlaczego anulowanie, a nie usunięcie: `Payment` jest w tym systemie
// append-only i nie jest to zasada dla zasady. Na wpłatę wskazują cztery
// referencje (karnet, korekta, karta podarunkowa, realizacja karty) i WSZYSTKIE
// są `SetNull` - baza nie zablokuje skasowania wiersza, tylko po cichu zostawi
// kartę podarunkową bez zapisu przychodu i osieroconą korektę. Dlatego
// "usunięcie" robimy tak, jak robi się je w kasie fiskalnej: wpisem
// odwracającym na dokładnie tę samą kwotę, ze wskazaniem oryginału.

import { todayInTimeZone, zonedTimeToUtc, type CalendarDate } from "@/lib/domain/time";

// Jak daleko wstecz wolno datować wpłatę. Tydzień pokrywa realny przypadek
// ("wpisuję w poniedziałek to, co było w piątek"), a nie otwiera drogi do
// dosypywania gotówki do rozliczeń sprzed miesięcy.
export const MAX_BACKDATE_DAYS = 7;

export type PaymentDateError = "NIEPOPRAWNA" | "Z_PRZYSZLOSCI" | "ZA_DAWNO";

export const PAYMENT_DATE_MESSAGE: Record<PaymentDateError, string> = {
  NIEPOPRAWNA: "Podaj poprawną datę wpłaty.",
  Z_PRZYSZLOSCI: "Data wpłaty nie może być z przyszłości.",
  ZA_DAWNO: `Wpłatę można cofnąć najwyżej o ${MAX_BACKDATE_DAYS} dni. Starsze poprawki zrób korektą.`,
};

export type PaymentDateResult =
  | { ok: true; at: Date; date: CalendarDate; today: boolean }
  | { ok: false; reason: PaymentDateError };

function parseIsoDay(raw: string): CalendarDate | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim());
  if (!m) return null;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { year, month, day };
}

function toUtcDays(d: CalendarDate): number {
  return Math.floor(Date.UTC(d.year, d.month - 1, d.day) / 86_400_000);
}

// Zamienia dzień wybrany przez człowieka (`YYYY-MM-DD` z pola daty) na moment
// zapisu. Pusta wartość znaczy "dziś" - formularz podstawia dzisiejszą datę,
// ale gdyby pole nie doszło, brak daty nie ma prawa wywrócić sprzedaży.
//
// Godzina: dla dzisiejszego dnia bierzemy realne "teraz", żeby kolejność wpłat
// na liście odpowiadała kolejności w kasie. Dla dnia wstecznego - południe
// czasu klubu: leży bezpiecznie w środku doby, więc wpłata nie przeskoczy do
// sąsiedniego dnia kasowego ani przy zmianie czasu, ani przy przeliczaniu na
// UTC. To jest ten sam problem, który w kolejce offline rozwiązuje
// `resolveRecordedAt`.
export function resolvePaymentDate(raw: string | null | undefined, now: Date): PaymentDateResult {
  const dzis = todayInTimeZone(now);
  if (!raw || raw.trim().length === 0) return { ok: true, at: now, date: dzis, today: true };

  const wybrany = parseIsoDay(raw);
  if (!wybrany) return { ok: false, reason: "NIEPOPRAWNA" };

  const roznica = toUtcDays(dzis) - toUtcDays(wybrany);
  if (roznica < 0) return { ok: false, reason: "Z_PRZYSZLOSCI" };
  if (roznica > MAX_BACKDATE_DAYS) return { ok: false, reason: "ZA_DAWNO" };

  if (roznica === 0) return { ok: true, at: now, date: dzis, today: true };
  return {
    ok: true,
    at: zonedTimeToUtc(wybrany.year, wybrany.month, wybrany.day, 12, 0),
    date: wybrany,
    today: false,
  };
}

// Format dla atrybutów `value` / `max` pola <input type="date">.
export function isoDay(date: CalendarDate): string {
  return `${date.year}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`;
}

export type CancelError = "TO_JEST_KOREKTA" | "JUZ_ANULOWANA" | "ZEROWA" | "BRAK_POWODU";

export const CANCEL_MESSAGE: Record<CancelError, string> = {
  TO_JEST_KOREKTA: "To jest wpis korygujący, a nie wpłata. Anuluj oryginał, do którego się odnosi.",
  JUZ_ANULOWANA: "Ta wpłata została już anulowana - druga korekta zrobiłaby z klienta dłużnika.",
  ZEROWA: "Ta wpłata jest już rozliczona do zera - nie ma czego anulować.",
  BRAK_POWODU: "Podaj powód anulowania (min. 5 znaków) - to jedyny ślad, dlaczego kwota zniknęła.",
};

export type CancelPlan = { ok: true; deltaGross: number } | { ok: false; reason: CancelError };

// Ile ma wynieść wpis odwracający i czy w ogóle wolno go zrobić.
//
// Kwota liczona jest od SALDA, nie od pierwotnej kwoty: wpłata 200 zł, do
// której zrobiono już zwrot 50 zł, ma się wyzerować wpisem -150 zł, a nie
// -200 zł. Bez tego dwa kliknięcia robią z klienta dłużnika na kwotę, której
// nikt od niego nie brał - a to jest błąd, którego klub nie ma jak zauważyć,
// bo obie liczby wyglądają poprawnie z osobna.
export function planCancellation(input: {
  payment: { amountGross: number; correctsPaymentId: string | null };
  corrections: { amountGross: number }[];
  note: string;
}): CancelPlan {
  if (input.payment.correctsPaymentId) return { ok: false, reason: "TO_JEST_KOREKTA" };
  if (input.note.trim().length < 5) return { ok: false, reason: "BRAK_POWODU" };

  const saldo =
    input.payment.amountGross + input.corrections.reduce((s, k) => s + k.amountGross, 0);

  if (saldo === 0) {
    return { ok: false, reason: input.corrections.length > 0 ? "JUZ_ANULOWANA" : "ZEROWA" };
  }
  return { ok: true, deltaGross: -saldo };
}
