// Kolejka zapisów offline po stronie przeglądarki.
//
// Trzymana w localStorage, bo brak sieci lubi zbiec się z odświeżeniem karty
// albo z uśpieniem tabletu - zapis, który znika przy przeładowaniu, byłby
// gorszy niż odmowa zapisu. Czysta logika (co wolno dopisać wstecz, jak to
// opisać człowiekowi) siedzi w lib/domain/offline-queue.ts.
//
// Moduł działa wyłącznie w przeglądarce - importują go komponenty klienckie.
import {
  applyFlushOutcomes,
  type FlushOutcome,
  type OfflineEntry,
  type OfflineOp,
} from "@/lib/domain/offline-queue";

const KLUCZ = "tfc_kolejka_offline";

const listeners = new Set<() => void>();

// useSyncExternalStore wymaga, żeby migawka nie zmieniała tożsamości przy
// każdym odczycie - inaczej React kręci się w kółko. Trzymamy więc jedną tablicę
// i podmieniamy ją dopiero, gdy kolejka naprawdę się zmieni.
let snapshot: OfflineEntry[] = [];
let wczytane = false;

const PUSTA: OfflineEntry[] = [];

function odczytaj(): OfflineEntry[] {
  try {
    const surowe = localStorage.getItem(KLUCZ);
    if (!surowe) return [];
    const dane: unknown = JSON.parse(surowe);
    return Array.isArray(dane) ? (dane as OfflineEntry[]) : [];
  } catch {
    // Uszkodzony wpis traktujemy jak pustą kolejkę - lepiej stracić listę niż
    // wywrócić każdy ekran, na którym wisi pasek.
    return [];
  }
}

function zapisz(entries: OfflineEntry[]): void {
  snapshot = entries;
  wczytane = true;
  try {
    localStorage.setItem(KLUCZ, JSON.stringify(entries));
  } catch {
    // Brak miejsca w localStorage. Kolejka zostaje w pamięci karty - do
    // przeładowania. Nic więcej nie da się tu zrobić.
  }
  for (const listener of listeners) listener();
}

// Migawka dla useSyncExternalStore. Pierwszy odczyt wciąga stan z localStorage.
export function getEntries(): OfflineEntry[] {
  if (!wczytane) {
    snapshot = odczytaj();
    wczytane = true;
  }
  return snapshot;
}

// Na serwerze kolejki nie ma - SSR renderuje pasek jako pusty, a po hydratacji
// dochodzi prawdziwy stan.
export function getServerEntries(): OfflineEntry[] {
  return PUSTA;
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // Druga karta tej samej aplikacji (kiosk bywa otwarty dwa razy) zmienia to
  // samo localStorage - bez tego jedna z nich pokazywałaby nieaktualny licznik.
  const onStorage = (event: StorageEvent) => {
    if (event.key !== null && event.key !== KLUCZ) return;
    snapshot = odczytaj();
    for (const l of listeners) l();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

function nowyId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export type NoweZgloszenie = {
  op: OfflineOp;
  detail: string;
  payload: Record<string, string>;
  // Moment zdarzenia na sali. Domyślnie "teraz", ale skaner podaje czas
  // odczytu kodu, a nie czas kliknięcia w przycisk wysyłki.
  recordedAt?: Date;
};

export function enqueue(zgloszenie: NoweZgloszenie): OfflineEntry {
  const entry: OfflineEntry = {
    id: nowyId(),
    op: zgloszenie.op,
    recordedAtIso: (zgloszenie.recordedAt ?? new Date()).toISOString(),
    detail: zgloszenie.detail,
    payload: zgloszenie.payload,
  };
  zapisz([...getEntries(), entry]);
  return entry;
}

export function applyOutcomes(outcomes: FlushOutcome[]): OfflineEntry[] {
  const zostaje = applyFlushOutcomes(getEntries(), outcomes);
  zapisz(zostaje);
  return zostaje;
}

// Odrzucenie całej kolejki. Nieodwracalne i tak jest podpisane w interfejsie -
// to jedyne miejsce w systemie, gdzie zapis znika bez śladu w bazie.
export function discardAll(): void {
  zapisz([]);
}

export function discardOne(id: string): void {
  zapisz(getEntries().filter((entry) => entry.id !== id));
}
