// Klasyfikacja karnetu do wyświetlenia (kolor/status) na ekranach admina.
// Czysta funkcja - SPEC.md nie definiuje progu "kończy się wkrótce", przyjęty
// tu na życzenie klienta: 7 dni.

export const PASS_EXPIRING_SOON_DAYS = 7;

// SPEC.md: zamrożenie karnetu maks. 30 dni/rok. Uproszczenie: liczone per
// Pass (frozenDaysUsed), nie per klient/rok kalendarzowy - patrz PLAN.md
// Faza 3 ❗️.
export const MAX_FROZEN_DAYS = 30;

export type PassStatusBadge = "NONE" | "EXPIRING_SOON" | "ACTIVE";

export function classifyPassStatus(
  pass: { endsAt: Date } | null,
  now: Date,
  warningDays: number = PASS_EXPIRING_SOON_DAYS,
): PassStatusBadge {
  if (!pass) return "NONE";
  const warningThreshold = new Date(now.getTime() + warningDays * 86_400_000);
  if (pass.endsAt <= warningThreshold) return "EXPIRING_SOON";
  return "ACTIVE";
}

// --- Pilność: jeden stan karnetu na potrzeby kartoteki ----------------------
//
// Kartoteka (/admin) pokazuje przy każdym człowieku kolor, kropkę i tekst. Do
// niedawna liczyła to sama, wywołaniem `classifyPassStatus(!isFrozen ? pass : null)`
// - a dla karnetu zamrożonego podstawiała `null`, więc dostawała "NONE"
// i malowała OPŁACONY karnet na czerwono, czyli barwą "ten człowiek nie ma
// karnetu". Stąd jedna funkcja: z niej bierze się i kropka, i ton tekstu, i sam
// tekst, więc nie ma jak się rozjechać.
//
// Liczymy z NAJGORSZEGO karnetu, nie z pierwszego lepszego. Klub sprzedaje
// osobno karnet grupowy i indywidualny (patrz `pickPassForSession` niżej), więc
// klient potrafi mieć dwa naraz - a wtedy branie tego z dalszą datą pokazuje
// spokojny wiersz, choć grupowy wygasł wczoraj.

export type Pilnosc = "BRAK" | "KONCZY_SIE" | "ZAMROZONY" | "OK";

export type PassForUrgency = {
  endsAt: Date;
  status: string;
};

export function pilnosc(passes: readonly PassForUrgency[], now: Date): Pilnosc {
  if (passes.length === 0) return "BRAK";

  // Zamrożony karnet nie jest ani problemem, ani gotowością do wejścia na salę -
  // ma własny, stonowany stan. Dopiero gdy WSZYSTKIE są zamrożone, opisuje on
  // całego klubowicza.
  const czynne = passes.filter((p) => p.status !== "FROZEN");
  if (czynne.length === 0) return "ZAMROZONY";

  const najblizszyKoniec = czynne.reduce((a, b) => (a.endsAt <= b.endsAt ? a : b));
  return classifyPassStatus(najblizszyKoniec, now) === "EXPIRING_SOON" ? "KONCZY_SIE" : "OK";
}

// --- Który karnet obsługuje te zajęcia -------------------------------------
//
// Klub sprzedaje osobno karnety na zajęcia grupowe i na treningi indywidualne,
// więc klient potrafi mieć oba naraz. Wcześniej wejście schodziło zawsze
// z karnetu o najpóźniejszej dacie końca - czyli trening indywidualny umiał
// zjeść wejście z karnetu grupowego i odwrotnie.
//
// Reguła: najpierw karnet pasujący do rodzaju zajęć, a wśród pasujących ten,
// który kończy się najwcześniej. Inaczej klient, który dokupił kolejny karnet
// przed końcem starego, zużywałby nowy, a stary przepadałby z wejściami.

export type PassForSession = {
  id: string;
  endsAt: Date;
  entriesLeft: number | null;
  /** Z planu: czy to karnet na treningi indywidualne. */
  forIndividual: boolean;
};

export type SessionKindForPass = "GROUP" | "INDIVIDUAL";

// OPEN (entriesLeft null) jest zawsze do użycia; limitowany tylko dopóki ma
// wejścia. Karnet bez wejść nie może obsłużyć zapisu - schodzenie poniżej zera
// zamieniłoby limit w fikcję.
function hasEntriesLeft(pass: PassForSession): boolean {
  return pass.entriesLeft == null || pass.entriesLeft > 0;
}

export function pickPassForSession(
  passes: readonly PassForSession[],
  kind: SessionKindForPass,
): PassForSession | null {
  const wantsIndividual = kind === "INDIVIDUAL";
  const usable = passes.filter(hasEntriesLeft);

  // Karnet niepasujący do rodzaju zajęć jest ostatnią deską ratunku: lepiej
  // pobrać wejście z czegokolwiek niż wpuścić za darmo. Klub z jednym rodzajem
  // karnetu (tak było do tej pory) działa dzięki temu jak wcześniej.
  const matching = usable.filter((p) => p.forIndividual === wantsIndividual);
  const pool = matching.length > 0 ? matching : usable;

  return [...pool].sort((a, b) => a.endsAt.getTime() - b.endsAt.getTime())[0] ?? null;
}
