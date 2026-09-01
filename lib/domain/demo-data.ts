// Dane demonstracyjne - czysta część: co wolno założyć, w jakiej kolejności
// i jak to potem opisać człowiekowi.
//
// Po co to w ogóle istnieje: właściciel chce pokazać, co system potrafi, na
// pełnej bazie - kartoteka, karnety, wpłaty, historia obecności, retencja,
// oceny - a potem to usunąć. Cała trudność leży w słowie "usunąć": ma zniknąć
// dokładnie to, co powstało, i nic więcej. W tym schemacie kasowanie jednej
// kartoteki zabiera kaskadą dziesięć tabel, więc pomyłka o jeden rekord
// oznacza skasowaną historię prawdziwego klubowicza.
//
// Stąd trzy reguły, które ten moduł utrwala:
//   1. Wolno zakładać rekordy WYŁĄCZNIE w modelach z listy poniżej. Cokolwiek
//      spoza niej nie ma jak zostać potem usunięte, więc nie ma prawa powstać.
//   2. Kolejność listy to kolejność tworzenia. Kasujemy dokładnie wstecz, bo
//      klucze obce są tu w większości RESTRICT (Payment -> Member,
//      Member -> Trainer, Trainer -> Location) i kasowanie "od rodzica" by się
//      wywaliło.
//   3. Nic nie jest kasowane "po kształcie" (po nazwisku, po adresie e-mail).
//      Wyłącznie po identyfikatorach ze spisu (model DemoRecord).

// Modele, w których powstają dane demonstracyjne - W KOLEJNOŚCI TWORZENIA.
//
// Świadomie NIE ma tu:
//   ClubSettings  - jeden wiersz na cały klub; "na potrzeby pokazu" znaczyłoby
//                   zmianę reguły dla realnej sali,
//   CashDay       - zamknięcie kasy to dokument księgowy i nie ma w systemie
//                   drogi otwarcia zamkniętego dnia,
//   PromoCode,
//   GiftCard      - zużywają limity użyć i wchodzą w przychód,
//   ActivityLog   - nic go nie sprząta, a Restrict na autorze zablokowałby
//                   usunięcie konta demo,
//   ClassTemplate - szablon dosypywałby co noc nowe terminy (generate-sessions),
//                   których spis nie zna. Terminy demo powstają wprost, bez
//                   szablonu, więc nocny job nie ma czego rozwijać.
export const DEMO_MODELS = [
  "location",
  "plan",
  "user",
  "trainer",
  "session",
  "member",
  "consent",
  "pass",
  "payment",
  "booking",
  "attendance",
  "note",
  "onboardingStep",
  "retentionTask",
  "rating",
  "measurement",
  "churnSurvey",
  "floorCheckIn",
  "trainerScore",
] as const;

export type DemoModel = (typeof DEMO_MODELS)[number];

export function isDemoModel(value: string): value is DemoModel {
  return (DEMO_MODELS as readonly string[]).includes(value);
}

// Nazwy dla człowieka - to one trafiają na podsumowanie "co zniknie".
export const DEMO_MODEL_LABEL: Record<DemoModel, string> = {
  location: "Sala pokazowa",
  plan: "Rodzaje karnetów",
  user: "Konta",
  trainer: "Trenerzy",
  session: "Terminy zajęć",
  member: "Kartoteki klubowiczów",
  consent: "Zgody",
  pass: "Karnety",
  payment: "Wpłaty",
  booking: "Zapisy",
  attendance: "Obecności",
  note: "Notatki",
  onboardingStep: "Etapy wdrożenia",
  retentionTask: "Alerty retencyjne",
  rating: "Oceny zajęć",
  measurement: "Pomiary",
  churnSurvey: "Ankiety odejścia",
  floorCheckIn: "Wejścia na salę",
  trainerScore: "Wyniki trenerów",
};

// Kolejność kasowania: dokładnie odwrotna do tworzenia.
export function deletionOrder(): DemoModel[] {
  return [...DEMO_MODELS].reverse();
}

export type ManifestRow = { model: string; recordId: string; seq: number };

export type DemoSummaryLine = { model: DemoModel; label: string; count: number };

// Podsumowanie spisu w kolejności tworzenia - tak się to czyta najnaturalniej
// ("sala, konta, trenerzy, ... obecności"), a nie alfabetycznie.
export function summarizeManifest(rows: ManifestRow[]): DemoSummaryLine[] {
  const licznik = new Map<string, number>();
  for (const row of rows) licznik.set(row.model, (licznik.get(row.model) ?? 0) + 1);

  return DEMO_MODELS.filter((model) => (licznik.get(model) ?? 0) > 0).map((model) => ({
    model,
    label: DEMO_MODEL_LABEL[model],
    count: licznik.get(model) ?? 0,
  }));
}

// "412 rekordów" - odmiana po polsku, bo tę liczbę czyta właściciel, nie log.
export function recordCountLabel(n: number): string {
  const abs = Math.abs(n);
  if (abs === 1) return "1 rekord";
  const last = abs % 10;
  const lastTwo = abs % 100;
  const few = last >= 2 && last <= 4 && (lastTwo < 12 || lastTwo > 14);
  return `${n} ${few ? "rekordy" : "rekordów"}`;
}

// Przedrostek nazw widocznych na ekranach. Ma być widać z odległości, że to
// nie jest klient klubu - także wtedy, gdy ktoś zobaczy sam wydruk listy.
export const DEMO_PREFIX = "[DEMO]";

// Adres e-mail kont demonstracyjnych. Domena `.invalid` jest zarezerwowana
// (RFC 2606) i nigdy nie zostanie zarejestrowana, więc żadna wiadomość nie ma
// szans wyjść do prawdziwej skrzynki, choćby ktoś obszedł blokadę powiadomień.
export const DEMO_EMAIL_DOMAIN = "demo.invalid";

export function demoEmail(local: string, batchId: string): string {
  return `${local}.${batchId}@${DEMO_EMAIL_DOMAIN}`;
}

export function isDemoEmail(email: string | null | undefined): boolean {
  return typeof email === "string" && email.toLowerCase().endsWith(`@${DEMO_EMAIL_DOMAIN}`);
}

// --- Losowanie powtarzalne ---------------------------------------------------
//
// Osobny strumień na każdy blok generatora, każdy z własnym ziarnem. W seedzie
// (prisma/seed.ts) jest jeden wspólny strumień i ma to konkretną wadę: dopisanie
// jednego losowania w środku przesuwa WSZYSTKIE późniejsze, więc dane demo
// zmieniają się całe przy każdej zmianie kodu. Tutaj bloki są od siebie
// niezależne.
export function createRng(seed: number): () => number {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pickFrom<T>(rng: () => number, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length) % items.length];
}

export function chanceOf(rng: () => number, probability: number): boolean {
  return rng() < probability;
}

export function intBetween(rng: () => number, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

// --- Przeszkody w usuwaniu ---------------------------------------------------

// Coś prawdziwego doczepiło się do rekordu demonstracyjnego. Usuwanie musi
// wtedy ODMÓWIĆ, a nie kasować: Booking, Attendance i Rating lecą kaskadą
// z zajęć, więc gdyby prawdziwy klubowicz zapisał się na pokazowe zajęcia,
// skasowanie demo zabrałoby jego obecność bez śladu i bez pytania.
export type DemoBlocker = { co: string; ile: number };

export function blockerMessage(blockers: DemoBlocker[]): string {
  const lista = blockers.map((b) => `${b.co} (${b.ile})`).join(", ");
  return (
    `Nie usuwam danych demonstracyjnych: doczepiło się do nich coś prawdziwego - ${lista}. ` +
    "Skasowanie demo zabrałoby to ze sobą. Usuń najpierw te powiązania w panelu."
  );
}
