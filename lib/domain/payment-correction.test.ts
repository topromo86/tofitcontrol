import { describe, expect, it } from "vitest";
import {
  CANCEL_MESSAGE,
  MAX_BACKDATE_DAYS,
  isoDay,
  planCancellation,
  resolvePaymentDate,
} from "./payment-correction";

// Środa, 9 września 2026, 14:30 czasu klubu (12:30 UTC).
const TERAZ = new Date("2026-09-09T12:30:00Z");

describe("resolvePaymentDate", () => {
  it("brak daty znaczy dziś - pole może nie dojść i sprzedaż ma iść dalej", () => {
    const r = resolvePaymentDate(null, TERAZ);
    expect(r.ok && r.today).toBe(true);
    expect(r.ok && r.at).toEqual(TERAZ);
  });

  it("dzisiejsza data zapisuje realną godzinę, nie południe", () => {
    const r = resolvePaymentDate("2026-09-09", TERAZ);
    expect(r.ok && r.at).toEqual(TERAZ);
  });

  it("dzień wsteczny ląduje w południe czasu klubu, czyli w środku doby", () => {
    const r = resolvePaymentDate("2026-09-07", TERAZ);
    expect(r.ok).toBe(true);
    // 12:00 w Warszawie (CEST, UTC+2) = 10:00 UTC. Południe, a nie północ,
    // żeby wpłata nie przeskoczyła do sąsiedniego dnia kasowego.
    expect(r.ok && r.at.toISOString()).toBe("2026-09-07T10:00:00.000Z");
  });

  it("odrzuca przyszłość", () => {
    const r = resolvePaymentDate("2026-09-10", TERAZ);
    expect(r).toEqual({ ok: false, reason: "Z_PRZYSZLOSCI" });
  });

  it(`pozwala cofnąć się o ${MAX_BACKDATE_DAYS} dni, ale nie dalej`, () => {
    expect(resolvePaymentDate("2026-09-02", TERAZ).ok).toBe(true);
    expect(resolvePaymentDate("2026-09-01", TERAZ)).toEqual({ ok: false, reason: "ZA_DAWNO" });
  });

  it("odrzuca śmieci zamiast zgadywać", () => {
    for (const zle of ["09.09.2026", "2026-13-01", "wczoraj", "2026-09-9"]) {
      expect(resolvePaymentDate(zle, TERAZ)).toEqual({ ok: false, reason: "NIEPOPRAWNA" });
    }
  });

  it("działa przez zmianę czasu - ostatnia niedziela października", () => {
    const poZmianie = new Date("2026-10-26T11:00:00Z");
    const r = resolvePaymentDate("2026-10-24", poZmianie);
    expect(r.ok).toBe(true);
    // 24.10.2026 jest jeszcze w czasie letnim (UTC+2).
    expect(r.ok && r.at.toISOString()).toBe("2026-10-24T10:00:00.000Z");
  });
});

describe("isoDay", () => {
  it("dopełnia zerami, żeby pole daty to przyjęło", () => {
    expect(isoDay({ year: 2026, month: 9, day: 7 })).toBe("2026-09-07");
  });
});

describe("planCancellation", () => {
  const wplata = { amountGross: 20000, correctsPaymentId: null };

  it("odwraca całą kwotę, gdy nic wcześniej nie korygowano", () => {
    expect(planCancellation({ payment: wplata, corrections: [], note: "pomyłka" })).toEqual({
      ok: true,
      deltaGross: -20000,
    });
  });

  it("liczy od SALDA, nie od kwoty pierwotnej", () => {
    // 200 zł wpłaty, 50 zł już zwrócone -> do wyzerowania zostaje 150 zł.
    const plan = planCancellation({
      payment: wplata,
      corrections: [{ amountGross: -5000 }],
      note: "pomyłka przy kasie",
    });
    expect(plan).toEqual({ ok: true, deltaGross: -15000 });
  });

  it("nie pozwala anulować drugi raz - to zrobiłoby z klienta dłużnika", () => {
    const plan = planCancellation({
      payment: wplata,
      corrections: [{ amountGross: -20000 }],
      note: "pomyłka przy kasie",
    });
    expect(plan).toEqual({ ok: false, reason: "JUZ_ANULOWANA" });
    expect(CANCEL_MESSAGE.JUZ_ANULOWANA).toContain("dłużnika");
  });

  it("nie pozwala anulować wpisu korygującego", () => {
    const plan = planCancellation({
      payment: { amountGross: -5000, correctsPaymentId: "abc" },
      corrections: [],
      note: "pomyłka przy kasie",
    });
    expect(plan).toEqual({ ok: false, reason: "TO_JEST_KOREKTA" });
  });

  it("wymaga powodu - to jedyny ślad, dlaczego kwota zniknęła", () => {
    expect(planCancellation({ payment: wplata, corrections: [], note: "ups" })).toEqual({
      ok: false,
      reason: "BRAK_POWODU",
    });
  });
});
