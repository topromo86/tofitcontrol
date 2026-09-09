// Numery telefonu.
//
// Klub stoi w Polsce, ale kadra i klubowicze bywają z Ukrainy, Niemiec czy
// skądkolwiek indziej - numer zagraniczny musi przejść. Dlatego zasada jest
// taka: numer z kierunkowym (+380, +49, +48...) przyjmujemy taki, jaki jest,
// a numer bez kierunkowego traktujemy jako polski i dopisujemy +48. To pokrywa
// oba realne przypadki: Polak wpisujący dziewięć cyfr z pamięci i obcokrajowiec
// wklejający pełny numer.
//
// Do bazy zawsze trafia jedna postać (+ i same cyfry), bo dopiero wtedy
// odnośnik `tel:` działa wszędzie tak samo, a dwa zapisy tego samego numeru
// nie wyglądają w kartotece jak dwie osoby.

export const PHONE_PREFIX = "+48";
export const PHONE_HINT =
  "Numer polski wystarczy podać jako dziewięć cyfr. Zagraniczny - z kierunkowym, np. +380 67 123 45 67.";

// Zakres długości numeru międzynarodowego według E.164: od 8 cyfr (z
// kierunkowym) do 15. Poniżej i powyżej to na pewno pomyłka, a nie egzotyczny
// kraj.
const MIN_INTERNATIONAL_DIGITS = 8;
const MAX_INTERNATIONAL_DIGITS = 15;
const POLISH_DIGITS = 9;

export type PhoneError = "EMPTY" | "NOT_A_NUMBER" | "WRONG_LENGTH" | "POLISH_WRONG_LENGTH";

export const PHONE_ERROR_MESSAGE: Record<PhoneError, string> = {
  EMPTY: "Podaj numer telefonu.",
  NOT_A_NUMBER: "Numer może zawierać tylko cyfry, spacje, myślniki i kierunkowy.",
  WRONG_LENGTH: `Numer z kierunkowym ma od ${MIN_INTERNATIONAL_DIGITS} do ${MAX_INTERNATIONAL_DIGITS} cyfr.`,
  POLISH_WRONG_LENGTH: `Polski numer ma ${POLISH_DIGITS} cyfr (np. 500 600 700). Numer zagraniczny podaj z kierunkowym, np. +380 67 123 45 67.`,
};

export type PhoneResult = { phone: string } | { error: PhoneError };

// Zwraca numer w postaci +<kierunkowy><numer> albo powód odrzucenia.
// Przyjmuje to, co ludzie realnie wpisują: ze spacjami, myślnikami, w
// nawiasach, z zerami wiodącymi (0048, 00380) i bez kierunkowego.
export function parsePhone(raw: string): PhoneResult {
  const cleaned = raw.replace(/[\s()-]/g, "");
  if (cleaned.length === 0) return { error: "EMPTY" };

  // Kierunkowy podany wprost albo przez 00 (zapis z klawiatury telefonu).
  const international = cleaned.startsWith("+")
    ? cleaned.slice(1)
    : cleaned.startsWith("00")
      ? cleaned.slice(2)
      : null;

  if (international !== null) {
    if (!/^\d+$/.test(international)) return { error: "NOT_A_NUMBER" };
    if (
      international.length < MIN_INTERNATIONAL_DIGITS ||
      international.length > MAX_INTERNATIONAL_DIGITS
    ) {
      return { error: "WRONG_LENGTH" };
    }
    return { phone: `+${international}` };
  }

  // Bez kierunkowego = numer krajowy. "0 500 600 700" to zapis z czasów
  // wybierania międzymiastowego, wciąż spotykany na wizytówkach.
  let digits = cleaned;
  if (digits.startsWith("0") && digits.length === POLISH_DIGITS + 1) digits = digits.slice(1);

  if (!/^\d+$/.test(digits)) return { error: "NOT_A_NUMBER" };
  if (digits.length !== POLISH_DIGITS) return { error: "POLISH_WRONG_LENGTH" };

  return { phone: `${PHONE_PREFIX}${digits}` };
}

// Ta sama reguła, ale dla dróg, na których nie ma komu pokazać powodu odmowy:
// import pliku z leadami i webhook z Meta. Tam numer albo jest, albo leada
// obdzwoni się bez numeru - zatrzymywanie całego importu przez jeden śmieciowy
// wpis byłoby gorsze niż jego brak.
export function parsePhoneOrNull(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const result = parsePhone(raw);
  return "phone" in result ? result.phone : null;
}

// Do wyświetlania. Polskie numery rozdzielamy po trzy cyfry (+48 500 600 700),
// bo tak się je u nas czyta. Zagranicznych nie grupujemy - każdy kraj robi to
// inaczej i zgadywanie skończyłoby się gorzej niż brak grupowania.
export function formatPhone(phone: string): string {
  if (!phone.startsWith(PHONE_PREFIX)) return phone;
  const digits = phone.slice(PHONE_PREFIX.length);
  if (digits.length !== POLISH_DIGITS) return phone;
  return `${PHONE_PREFIX} ${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6)}`;
}
