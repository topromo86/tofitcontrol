// Stan połączenia z bazą - to, co widać w pasku jako ONLINE / OFFLINE.
//
// Trzy źródła prawdy, w tej kolejności:
//   1. zdarzenia przeglądarki `online`/`offline` - łapią wyciągnięty kabel
//      i wyłączone wifi natychmiast, bez czekania na cokolwiek,
//   2. wynik realnego zapisu - każda udana/nieudana Server Action mówi nam,
//      jak jest naprawdę, szybciej i taniej niż kolejne pytanie,
//   3. ping /api/zdrowie w tle - jedyny, który odróżnia "wifi klubu jest, ale
//      nie przepuszcza ruchu" od prawdziwego połączenia.
//
// OFFLINE oznacza WYŁĄCZNIE brak kontaktu z serwerem. Błąd 401/403/500 to
// problem sesji albo aplikacji, nie łącza - gdybyśmy go liczyli, wskaźnik
// kłamałby i ludzie przestaliby mu wierzyć.
import { OFFLINE_CHECK_PATH } from "@/lib/domain/offline-paths";

export type ConnectionMode = "nieznany" | "online" | "offline";

const PING_MS = 20_000;
// Po zerwaniu pytamy częściej: powrót łącza ma być widoczny od razu, bo dopiero
// wtedy pojawia się przycisk "Dopisz do bazy".
const PING_PO_BLEDZIE_MS = 5_000;

export type ConnectionState = {
  mode: ConnectionMode;
  // Od kiedy nie ma łącza (ms). Do podpisu "OFFLINE · od 12 min".
  offlineSince: number | null;
};

const SERWEROWY: ConnectionState = { mode: "nieznany", offlineSince: null };

let state: ConnectionState = SERWEROWY;
const listeners = new Set<() => void>();

export function getState(): ConnectionState {
  return state;
}

// SSR nie wie nic o łączu. Renderujemy "nieznany", żeby pierwszy render na
// serwerze i na kliencie się zgadzały, a prawdziwy stan dochodzi po hydratacji.
export function getServerState(): ConnectionState {
  return SERWEROWY;
}

function ustaw(mode: ConnectionMode): void {
  if (state.mode === mode) return;
  state = {
    mode,
    offlineSince: mode === "offline" ? (state.offlineSince ?? Date.now()) : null,
  };
  for (const listener of listeners) listener();
}

// Czy błąd wygląda na brak łącza. Wywołanie Server Action bez sieci kończy się
// TypeError z fetcha - to jedyna rodzina błędów, którą wolno czytać jako OFFLINE.
export function isNetworkError(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /Failed to fetch|NetworkError|Load failed|network error/i.test(message);
}

export function reportSuccess(): void {
  ustaw("online");
}

export function reportError(error: unknown): void {
  if (isNetworkError(error)) ustaw("offline");
}

export function isOffline(): boolean {
  return state.mode === "offline";
}

export async function checkNow(): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    ustaw("offline");
    return false;
  }
  try {
    const odp = await fetch(OFFLINE_CHECK_PATH, { cache: "no-store" });
    const dane: unknown = await odp.json().catch(() => null);
    const baza = Boolean(
      dane && typeof dane === "object" && (dane as { baza?: unknown }).baza === true,
    );
    ustaw(odp.ok && baza ? "online" : "offline");
  } catch {
    ustaw("offline");
  }
  return state.mode === "online";
}

let uruchomione = 0;
let rytm: ReturnType<typeof setTimeout> | null = null;

function zaplanuj(): void {
  if (rytm) clearTimeout(rytm);
  rytm = setTimeout(
    () => {
      void checkNow().finally(zaplanuj);
    },
    state.mode === "offline" ? PING_PO_BLEDZIE_MS : PING_MS,
  );
}

const onOffline = () => ustaw("offline");
const onOnline = () => {
  void checkNow();
};

// Wskaźnik i pasek montują się na kilku ekranach naraz - licznik pilnuje, żeby
// pingów było tyle co jeden, niezależnie od liczby komponentów.
export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  uruchomione += 1;
  if (uruchomione === 1) {
    window.addEventListener("offline", onOffline);
    window.addEventListener("online", onOnline);
    void checkNow().finally(zaplanuj);
  }
  return () => {
    listeners.delete(listener);
    uruchomione -= 1;
    if (uruchomione === 0) {
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("online", onOnline);
      if (rytm) clearTimeout(rytm);
      rytm = null;
    }
  };
}
