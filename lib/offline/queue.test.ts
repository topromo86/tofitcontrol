import { beforeEach, describe, expect, it, vi } from "vitest";

// Kolejka mieszka w localStorage przeglądarki. Testy chodzą w node, więc
// podstawiamy najprostszy możliwy magazyn - chodzi o zachowanie kolejki
// (co przetrwa, co znika, co zostaje z błędem), nie o samą przeglądarkę.
function fakeStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: () => null,
    length: 0,
  } as unknown as Storage;
}

async function freshQueue() {
  vi.resetModules();
  globalThis.localStorage = fakeStorage();
  return import("./queue");
}

describe("kolejka offline", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("zaczyna pusta", async () => {
    const queue = await freshQueue();
    expect(queue.getEntries()).toEqual([]);
  });

  it("zapamiętuje zapis wraz z godziną zdarzenia, nie godziną wysyłki", async () => {
    const queue = await freshQueue();
    const scannedAt = new Date("2026-08-25T16:03:00Z");
    queue.enqueue({
      op: "WEJSCIE_NA_SALE",
      detail: "Tychy · ···abc123",
      payload: { token: "t", locationId: "l" },
      recordedAt: scannedAt,
    });

    const entries = queue.getEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].recordedAtIso).toBe(scannedAt.toISOString());
    expect(entries[0].payload).toEqual({ token: "t", locationId: "l" });
  });

  it("przeżywa przeładowanie karty", async () => {
    const queue = await freshQueue();
    queue.enqueue({ op: "OBECNOSC_RECZNA", detail: "Jan Kowalski", payload: { bookingId: "b1" } });

    // Ten sam magazyn, moduł wczytany od nowa - tak wygląda odświeżenie strony.
    const storage = globalThis.localStorage;
    vi.resetModules();
    globalThis.localStorage = storage;
    const poPrzeladowaniu = await import("./queue");

    expect(poPrzeladowaniu.getEntries()).toHaveLength(1);
    expect(poPrzeladowaniu.getEntries()[0].detail).toBe("Jan Kowalski");
  });

  it("po wysyłce zdejmuje udane, a nieudane zostawia z powodem odmowy", async () => {
    const queue = await freshQueue();
    const a = queue.enqueue({ op: "OBECNOSC_RECZNA", detail: "A", payload: {} });
    const b = queue.enqueue({ op: "OBECNOSC_RECZNA", detail: "B", payload: {} });

    const zostaje = queue.applyOutcomes([
      { id: a.id, ok: true },
      { id: b.id, ok: false, error: "Kod wygasł." },
    ]);

    expect(zostaje).toHaveLength(1);
    expect(zostaje[0].id).toBe(b.id);
    expect(zostaje[0].error).toBe("Kod wygasł.");
    expect(queue.getEntries()).toEqual(zostaje);
  });

  it("odrzucenie czyści kolejkę", async () => {
    const queue = await freshQueue();
    queue.enqueue({ op: "OBECNOSC_RECZNA", detail: "A", payload: {} });
    queue.discardAll();
    expect(queue.getEntries()).toEqual([]);
  });

  it("uszkodzony wpis czyta się jak pusta kolejka, a nie jak wyjątek", async () => {
    vi.resetModules();
    const storage = fakeStorage();
    storage.setItem("tfc_kolejka_offline", "{to nie jest JSON");
    globalThis.localStorage = storage;
    const queue = await import("./queue");
    expect(queue.getEntries()).toEqual([]);
  });

  it("migawka nie zmienia tożsamości, dopóki kolejka się nie zmieni", async () => {
    const queue = await freshQueue();
    // useSyncExternalStore kręciłby się w kółko, gdyby każdy odczyt dawał nową
    // tablicę - to jest ten warunek, nie kosmetyka.
    expect(queue.getEntries()).toBe(queue.getEntries());
    queue.enqueue({ op: "OBECNOSC_RECZNA", detail: "A", payload: {} });
    expect(queue.getEntries()).toBe(queue.getEntries());
  });
});
