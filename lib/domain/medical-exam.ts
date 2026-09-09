// Badania lekarskie zawodnika.
//
// Bez ważnych badań zawodnik nie wystartuje w zawodach, a klub dowiaduje się
// o tym zwykle na wadze, dzień przed walką. Dlatego termin jest w systemie,
// widoczny dla zawodnika i przypominany z wyprzedzeniem.
//
// Czyste funkcje, bez bazy - reguła "kiedy przypomnieć" ma dać się sprawdzić
// testem, a nie dopiero na kliencie klubu.

import { todayInTimeZone, type CalendarDate } from "@/lib/domain/time";

// Ile dni przed końcem przypominamy. Dwa tygodnie to realny czas na umówienie
// się do lekarza sportowego i dojechanie - przypomnienie na trzy dni przed
// byłoby informacją, że jest już za późno.
export const MEDICAL_EXAM_REMINDER_DAYS = 14;

export type ExamState = "BRAK" | "WAZNE" | "KONCZY_SIE" | "WYGASLO";

export const EXAM_LABEL: Record<ExamState, string> = {
  BRAK: "Brak wpisanych badań",
  WAZNE: "Badania ważne",
  KONCZY_SIE: "Badania wkrótce wygasną",
  WYGASLO: "Badania nieważne",
};

// Kolory z palety klubu - ta sama zasada co przy karnetach: czerwony znaczy
// "nie wolno startować", pomarańczowy "zajmij się tym w tym tygodniu".
export const EXAM_STYLE: Record<ExamState, string> = {
  BRAK: "text-muted-brand",
  WAZNE: "text-jade",
  KONCZY_SIE: "text-amber",
  WYGASLO: "text-red",
};

function toDays(d: CalendarDate): number {
  return Math.floor(Date.UTC(d.year, d.month - 1, d.day) / 86_400_000);
}

// Ile dni zostało do końca ważności. Liczone w DNIACH KALENDARZOWYCH czasu
// klubu, nie w różnicy milisekund: badania ważne "do 20 września" są ważne
// przez cały ten dzień, niezależnie od godziny, o której ktoś patrzy na ekran.
export function daysLeft(validUntil: Date, now: Date): number {
  return toDays(todayInTimeZone(validUntil)) - toDays(todayInTimeZone(now));
}

export function examState(validUntil: Date | null, now: Date): ExamState {
  if (!validUntil) return "BRAK";
  const dni = daysLeft(validUntil, now);
  if (dni < 0) return "WYGASLO";
  if (dni <= MEDICAL_EXAM_REMINDER_DAYS) return "KONCZY_SIE";
  return "WAZNE";
}

// Czy DZIŚ wysłać przypomnienie.
//
// Okno, nie pojedynczy dzień: gdyby warunek brzmiał "dokładnie 14 dni przed",
// jedno nieudane uruchomienie nocnego zadania (albo przerwa w działaniu
// hostingu) kasowałoby przypomnienie na zawsze. Powtórkom zapobiega
// idempotencja wysyłki (`notify` po `subjectId`), a nie wąskie okno.
//
// Dzień wygaśnięcia jeszcze się liczy - badania są ważne do końca tego dnia.
export function shouldRemind(validUntil: Date | null, now: Date): boolean {
  if (!validUntil) return false;
  const dni = daysLeft(validUntil, now);
  return dni >= 0 && dni <= MEDICAL_EXAM_REMINDER_DAYS;
}

// Treść przypomnienia. Jedno miejsce, bo ta sama wiadomość idzie do zawodnika
// i - w innej formie - do właściciela.
export function reminderForAthlete(input: { name: string; validUntil: Date; now: Date }): {
  title: string;
  body: string;
} {
  const dni = daysLeft(input.validUntil, input.now);
  const kiedy =
    dni === 0 ? "kończą się dzisiaj" : dni === 1 ? "kończą się jutro" : `kończą się za ${dni} dni`;
  return {
    title: "Badania lekarskie do zawodów",
    body:
      `Twoje badania ${kiedy} (${isoDay(input.validUntil)}). ` +
      "Bez ważnych badań nie wystartujesz w zawodach - umów się na wizytę i podaj nowy termin trenerowi.",
  };
}

export function isoDay(date: Date): string {
  const d = todayInTimeZone(date);
  return `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;
}
