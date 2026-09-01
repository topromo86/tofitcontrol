import { describe, expect, it } from "vitest";
import {
  applyFlushOutcomes,
  autoSendable,
  countLabel,
  MAX_OFFLINE_AGE_HOURS,
  offlineSinceLabel,
  rejectedEntries,
  resolveRecordedAt,
  type OfflineEntry,
} from "./offline-queue";

const NOW = new Date("2026-08-25T18:00:00Z");

function minutesAgo(minutes: number): string {
  return new Date(NOW.getTime() - minutes * 60_000).toISOString();
}

describe("resolveRecordedAt", () => {
  it("przyjmuje odbicie sprzed kilkunastu minut", () => {
    const result = resolveRecordedAt(minutesAgo(12), NOW);
    expect(result).toEqual({ ok: true, at: new Date(NOW.getTime() - 12 * 60_000) });
  });

  it("odmawia bez daty", () => {
    expect(resolveRecordedAt(null, NOW)).toEqual({ ok: false, reason: "BRAK_DATY" });
  });

  it("odmawia przy dacie nie do odczytania", () => {
    expect(resolveRecordedAt("wczoraj wieczorem", NOW)).toEqual({
      ok: false,
      reason: "BRAK_DATY",
    });
  });

  it("prostuje drobne wyprzedzenie zegara tabletu do teraz", () => {
    const result = resolveRecordedAt(minutesAgo(-2), NOW);
    expect(result).toEqual({ ok: true, at: NOW });
  });

  it("odmawia przy dacie wyraźnie z przyszłości", () => {
    expect(resolveRecordedAt(minutesAgo(-30), NOW)).toEqual({ ok: false, reason: "Z_PRZYSZLOSCI" });
  });

  it("przyjmuje zapis tuż przed granicą wieku", () => {
    const result = resolveRecordedAt(minutesAgo(MAX_OFFLINE_AGE_HOURS * 60 - 1), NOW);
    expect(result.ok).toBe(true);
  });

  it("odmawia zapisowi starszemu niż doba", () => {
    expect(resolveRecordedAt(minutesAgo(MAX_OFFLINE_AGE_HOURS * 60 + 1), NOW)).toEqual({
      ok: false,
      reason: "ZA_STARY",
    });
  });
});

describe("countLabel", () => {
  it.each([
    [1, "1 zapis"],
    [2, "2 zapisy"],
    [4, "4 zapisy"],
    [5, "5 zapisów"],
    [12, "12 zapisów"],
    [22, "22 zapisy"],
    [25, "25 zapisów"],
  ])("odmienia %i", (n, expected) => {
    expect(countLabel(n)).toBe(expected);
  });
});

describe("offlineSinceLabel", () => {
  it("nic nie mówi, gdy łącze jest", () => {
    expect(offlineSinceLabel(null, NOW.getTime())).toBe("");
  });

  it("pierwsza minuta to „przed chwilą”", () => {
    expect(offlineSinceLabel(NOW.getTime() - 30_000, NOW.getTime())).toBe("przed chwilą");
  });

  it("dalej liczy minuty", () => {
    expect(offlineSinceLabel(NOW.getTime() - 12 * 60_000, NOW.getTime())).toBe("od 12 min");
  });
});

describe("applyFlushOutcomes", () => {
  const entries: OfflineEntry[] = [
    {
      id: "a",
      op: "WEJSCIE_NA_SALE",
      recordedAtIso: minutesAgo(10),
      detail: "Jan Kowalski",
      payload: {},
    },
    {
      id: "b",
      op: "OBECNOSC_RECZNA",
      recordedAtIso: minutesAgo(8),
      detail: "Anna Nowak",
      payload: {},
    },
  ];

  it("zdejmuje z kolejki to, co się dopisało", () => {
    const left = applyFlushOutcomes(entries, [
      { id: "a", ok: true },
      { id: "b", ok: true },
    ]);
    expect(left).toEqual([]);
  });

  it("zostawia nieudane z powodem odmowy", () => {
    const left = applyFlushOutcomes(entries, [
      { id: "a", ok: true },
      { id: "b", ok: false, error: "Kod wygasł." },
    ]);
    expect(left).toHaveLength(1);
    expect(left[0]).toMatchObject({ id: "b", error: "Kod wygasł." });
  });

  it("zostawia nietknięte to, o czym serwer nic nie powiedział", () => {
    const left = applyFlushOutcomes(entries, [{ id: "a", ok: true }]);
    expect(left).toEqual([entries[1]]);
  });
});

describe("autoSendable", () => {
  const swiezy: OfflineEntry = {
    id: "a",
    op: "WEJSCIE_NA_SALE",
    recordedAtIso: minutesAgo(5),
    detail: "Jan Kowalski",
    payload: {},
  };
  const odrzucony: OfflineEntry = {
    id: "b",
    op: "OBECNOSC_RECZNA",
    recordedAtIso: minutesAgo(9),
    detail: "Anna Nowak",
    payload: {},
    error: "Rezerwacja zniknęła.",
  };

  it("automat bierze tylko to, czego baza jeszcze nie odrzuciła", () => {
    expect(autoSendable([swiezy, odrzucony])).toEqual([swiezy]);
  });

  it("odrzucone zostaje do decyzji człowieka", () => {
    // Bez tego przy każdym pingu leciałby ten sam odrzucany zapis.
    expect(rejectedEntries([swiezy, odrzucony])).toEqual([odrzucony]);
  });

  it("po samych odmowach nie ma czego wysyłać automatem", () => {
    expect(autoSendable([odrzucony])).toEqual([]);
  });
});
