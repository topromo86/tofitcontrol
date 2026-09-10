// SMS: nadawca, polskie znaki i liczenie segmentów.
//
// Czyste funkcje, bez sieci i bez bazy - to jedyna część wysyłki SMS, która
// da się sprawdzić testem, a jednocześnie ta, która decyduje o rachunku klubu.
//
// Dlaczego to w ogóle istnieje: operator rozlicza SEGMENTY, nie wiadomości.
// Wiadomość w alfabecie GSM mieści 160 znaków w jednym segmencie; wystarczy
// jedno "ż", żeby cała treść przeszła na UCS-2 i segment skurczył się do 70.
// Powitanie leada ma około 130 znaków, więc z ogonkami kosztuje DWA razy tyle
// co bez nich. Przy 300 wiadomościach miesięcznie to różnica 51 zł kontra
// 102 zł - większa niż różnica między najtańszym a najdroższym dostawcą.

// Alfabet GSM 03.38 (3GPP TS 23.038, tablica podstawowa). Każdy z tych znaków
// zajmuje jedną jednostkę segmentu.
const GSM_BASIC =
  "@£$¥èéùìòÇ\nØø\rÅå" +
  "Δ_ΦΓΛΩΠΨΣΘΞÆæßÉ" +
  " !\"#¤%&'()*+,-./0123456789:;<=>?" +
  "¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§" +
  "¿abcdefghijklmnopqrstuvwxyzäöñüà";

// Tablica rozszerzona: te znaki idą jako para (escape + znak), więc liczą się
// PODWÓJNIE. Enter w treści też - stąd wiadomość pisana "ładnie", z pustą
// linią przed podpisem, potrafi przeskoczyć próg bez widocznego powodu.
const GSM_EXTENDED = "^{}\\[~]|€";

const GSM_BASIC_SET = new Set(GSM_BASIC);
const GSM_EXTENDED_SET = new Set(GSM_EXTENDED);

// Zamienniki znaków spoza alfabetu GSM. Poza polskimi ogonkami są tu znaki,
// które wchodzą do treści niezauważone: cudzysłowy typograficzne z Worda,
// półpauza, wielokropek jako jeden znak, twarda spacja. Każdy z nich
// w milczeniu przełącza wiadomość na UCS-2 i podwaja rachunek.
const REPLACEMENTS: Record<string, string> = {
  ą: "a", // ą
  ć: "c", // ć
  ę: "e", // ę
  ł: "l", // ł
  ń: "n", // ń
  ó: "o", // ó
  ś: "s", // ś
  ź: "z", // ź
  ż: "z", // ż
  Ą: "A", // Ą
  Ć: "C", // Ć
  Ę: "E", // Ę
  Ł: "L", // Ł
  Ń: "N", // Ń
  Ó: "O", // Ó
  Ś: "S", // Ś
  Ź: "Z", // Ź
  Ż: "Z", // Ż
  "„": '"', // „
  "”": '"', // ”
  "“": '"', // “
  "‚": "'", // ‚
  "’": "'", // ’
  "‘": "'", // ‘
  "–": "-", // półpauza
  "—": "-", // pauza
  "…": "...", // wielokropek jednym znakiem
  "\u00a0": " ", // twarda spacja
  "\u202f": " ", // wąska twarda spacja
  "\u2011": "-", // myślnik niełamiący
};

// Sprowadzenie treści do alfabetu GSM.
//
// Robimy to U SIEBIE, choć SMSAPI ma własny parametr `normalize`. Powód jest
// jeden: w historii kontaktu z leadem ma być zapisane DOKŁADNIE to, co poszło
// na telefon. Gdyby ogonki ścinał dostawca, klub czytałby w systemie treść
// z ogonkami, a klient dostałby inną - i nikt by tego nie zauważył aż do
// reklamacji. Parametr `normalize` wysyłamy mimo to, ale jako zabezpieczenie
// przed znakiem, którego ta tablica nie zna, a nie jako główną drogę.
export function toGsmAlphabet(text: string): string {
  let out = "";
  for (const ch of text) {
    const replacement = REPLACEMENTS[ch];
    if (replacement !== undefined) {
      out += replacement;
      continue;
    }
    if (GSM_BASIC_SET.has(ch) || GSM_EXTENDED_SET.has(ch)) {
      out += ch;
      continue;
    }
    // Ostatnia deska ratunku: rozkład Unicode zdejmuje akcent z liter, których
    // nie ma w tablicy (á, ē, ů). Czego nie da się sprowadzić, leci jako znak
    // zapytania - cichy UCS-2 kosztowałby podwójnie.
    const stripped = ch.normalize("NFD").replace(/\p{Diacritic}/gu, "");
    out += stripped.length > 0 && GSM_BASIC_SET.has(stripped[0]!) ? stripped[0]! : "?";
  }
  return out;
}

export type SmsEncoding = "GSM" | "UCS2";

export type SmsCost = {
  encoding: SmsEncoding;
  // Ile jednostek liczy operator (znaki rozszerzone GSM idą po dwie).
  units: number;
  // Ile segmentów zostanie naliczonych - TO jest mnożnik ceny.
  segments: number;
};

// Ile segmentów naliczy operator za tę treść.
//
// Progi z regulaminu SMSAPI, identyczne u każdego dostawcy (to standard GSM):
// GSM 160 jednostek w jednym segmencie, 153 gdy segmentów jest więcej;
// UCS-2 odpowiednio 70 i 67. Wiadomość wieloczęściowa dociera do odbiorcy
// sklejona, ale klub płaci za każdą część osobno.
export function smsCost(text: string): SmsCost {
  const chars = [...text];
  const ucs2 = chars.some((ch) => !GSM_BASIC_SET.has(ch) && !GSM_EXTENDED_SET.has(ch));

  if (ucs2) {
    // W UCS-2 liczy się długość w jednostkach UTF-16: każdy znak zajmuje dwa
    // bajty, a emoji spoza podstawowej płaszczyzny - cztery, czyli dwie
    // jednostki. Dokładnie tak liczy operator.
    const units = chars.reduce((sum, ch) => sum + ch.length, 0);
    return {
      encoding: "UCS2",
      units,
      segments: Math.max(units <= 70 ? 1 : Math.ceil(units / 67), 1),
    };
  }

  const units = chars.reduce((sum, ch) => sum + (GSM_EXTENDED_SET.has(ch) ? 2 : 1), 0);
  return {
    encoding: "GSM",
    units,
    segments: Math.max(units <= 160 ? 1 : Math.ceil(units / 153), 1),
  };
}

// Nazwa nadawcy (pole "from"): operatorzy dopuszczają najwyżej 11 znaków
// i wyłącznie znaki bez ogonków. "CzaplaBoxing" ma dwanaście - dlatego klub
// wysyła jako "CzaplaBox".
export const SMS_SENDER_MAX_LENGTH = 11;
export const DEFAULT_SMS_SENDER = "CzaplaBox";

export function validateSmsSender(sender: string): string | null {
  const value = sender.trim();
  if (value.length === 0) return "Nazwa nadawcy nie może być pusta.";
  if (value.length > SMS_SENDER_MAX_LENGTH)
    return `Nazwa nadawcy może mieć najwyżej ${SMS_SENDER_MAX_LENGTH} znaków (ma ${value.length}).`;
  if (!/^[A-Za-z0-9 .\-_]+$/.test(value))
    return "Nazwa nadawcy może zawierać tylko litery bez ogonków, cyfry, spację, kropkę, myślnik i podkreślenie.";
  if (!/[A-Za-z]/.test(value))
    return "Nazwa nadawcy musi zawierać przynajmniej jedną literę - sama liczba zostanie potraktowana jak numer.";
  return null;
}

// Numer w postaci, którą przyjmuje bramka. W bazie numery leżą już jako
// "+48..." (lib/domain/phone.ts), więc jedyne, co robimy, to zdjęcie plusa
// i znaków rozdzielających - SMSAPI przyjmuje obie formy, ale sama cyfra nie
// ma jak zostać pomylona z parametrem zapytania.
export function smsRecipient(phone: string): string {
  return phone.replace(/\D/g, "");
}
