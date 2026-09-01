import { describe, expect, it } from "vitest";
import {
  blockerMessage,
  chanceOf,
  createRng,
  DEMO_EMAIL_DOMAIN,
  DEMO_MODEL_LABEL,
  DEMO_MODELS,
  deletionOrder,
  demoEmail,
  intBetween,
  isDemoEmail,
  isDemoModel,
  pickFrom,
  recordCountLabel,
  summarizeManifest,
} from "./demo-data";

describe("lista modeli demonstracyjnych", () => {
  it("każdy model ma nazwę dla człowieka", () => {
    for (const model of DEMO_MODELS) {
      expect(DEMO_MODEL_LABEL[model]).toBeTruthy();
    }
  });

  it("nie ma duplikatów - kolejność tworzenia musi być jednoznaczna", () => {
    expect(new Set(DEMO_MODELS).size).toBe(DEMO_MODELS.length);
  });

  it("nie wpuszcza modelu spoza listy", () => {
    expect(isDemoModel("member")).toBe(true);
    // Te trzy są świadomie poza listą: dokument księgowy, ustawienia całego
    // klubu i historia zmian, której nic nie sprząta.
    expect(isDemoModel("cashDay")).toBe(false);
    expect(isDemoModel("clubSettings")).toBe(false);
    expect(isDemoModel("activityLog")).toBe(false);
    // Szablon zajęć też nie: nocny job rozwijałby go w terminy, o których
    // spis nic by nie wiedział.
    expect(isDemoModel("classTemplate")).toBe(false);
  });

  it("nie wpuszcza czegoś, co tylko wygląda jak nazwa modelu", () => {
    expect(isDemoModel("")).toBe(false);
    expect(isDemoModel("Member")).toBe(false);
    expect(isDemoModel("member; DROP TABLE")).toBe(false);
  });

  it("sala jest zakładana pierwsza, a kasowana ostatnia", () => {
    // Osiem tabel trzyma Location przez RESTRICT, więc odwrotna kolejność
    // wywaliłaby kasowanie na pierwszej z nich.
    expect(DEMO_MODELS[0]).toBe("location");
    expect(deletionOrder()[deletionOrder().length - 1]).toBe("location");
  });

  it("termin zajęć powstaje po trenerze i po sali", () => {
    expect(DEMO_MODELS.indexOf("session")).toBeGreaterThan(DEMO_MODELS.indexOf("trainer"));
    expect(DEMO_MODELS.indexOf("session")).toBeGreaterThan(DEMO_MODELS.indexOf("location"));
  });

  it("karnet powstaje po rodzaju karnetu", () => {
    expect(DEMO_MODELS.indexOf("pass")).toBeGreaterThan(DEMO_MODELS.indexOf("plan"));
  });

  it("kartoteka powstaje po trenerze i po sali", () => {
    const kolejnosc = DEMO_MODELS.indexOf("member");
    expect(kolejnosc).toBeGreaterThan(DEMO_MODELS.indexOf("trainer"));
    expect(kolejnosc).toBeGreaterThan(DEMO_MODELS.indexOf("location"));
  });

  it("wpłata i karnet powstają po kartotece - inaczej kasowanie utknie na RESTRICT", () => {
    expect(DEMO_MODELS.indexOf("pass")).toBeGreaterThan(DEMO_MODELS.indexOf("member"));
    expect(DEMO_MODELS.indexOf("payment")).toBeGreaterThan(DEMO_MODELS.indexOf("member"));
  });

  it("kasowanie idzie dokładnie wstecz", () => {
    expect(deletionOrder()).toEqual([...DEMO_MODELS].reverse());
  });
});

describe("summarizeManifest", () => {
  const spis = [
    { model: "member", recordId: "m1", seq: 10 },
    { model: "member", recordId: "m2", seq: 11 },
    { model: "location", recordId: "l1", seq: 1 },
    { model: "payment", recordId: "p1", seq: 20 },
  ];

  it("liczy rekordy po modelach", () => {
    expect(summarizeManifest(spis)).toEqual([
      { model: "location", label: "Sala pokazowa", count: 1 },
      { model: "member", label: "Kartoteki klubowiczów", count: 2 },
      { model: "payment", label: "Wpłaty", count: 1 },
    ]);
  });

  it("pomija modele bez rekordów", () => {
    expect(summarizeManifest(spis).some((l) => l.model === "rating")).toBe(false);
  });

  it("pusty spis to pusta lista", () => {
    expect(summarizeManifest([])).toEqual([]);
  });
});

describe("recordCountLabel", () => {
  it.each([
    [1, "1 rekord"],
    [2, "2 rekordy"],
    [4, "4 rekordy"],
    [5, "5 rekordów"],
    [12, "12 rekordów"],
    [22, "22 rekordy"],
    [412, "412 rekordów"],
  ])("odmienia %i", (n, oczekiwane) => {
    expect(recordCountLabel(n)).toBe(oczekiwane);
  });
});

describe("adresy kont demonstracyjnych", () => {
  it("idą na domenę, która nigdy nie zostanie zarejestrowana", () => {
    // RFC 2606: .invalid jest zarezerwowana. Nawet gdyby ktoś obszedł blokadę
    // powiadomień, wiadomość nie ma dokąd dojść.
    expect(DEMO_EMAIL_DOMAIN.endsWith(".invalid")).toBe(true);
    expect(demoEmail("jan.kowalski", "abc123")).toBe("jan.kowalski.abc123@demo.invalid");
  });

  it("rozpoznaje własny adres, także zapisany wielkimi literami", () => {
    expect(isDemoEmail("kto.abc@demo.invalid")).toBe(true);
    expect(isDemoEmail("KTO.ABC@DEMO.INVALID")).toBe(true);
  });

  it("nie bierze prawdziwego adresu za demonstracyjny", () => {
    expect(isDemoEmail("dpilc@wp.pl")).toBe(false);
    expect(isDemoEmail("ktos@demo.invalid.example.com")).toBe(false);
    expect(isDemoEmail(null)).toBe(false);
    expect(isDemoEmail(undefined)).toBe(false);
  });
});

describe("losowanie powtarzalne", () => {
  it("to samo ziarno daje ten sam ciąg", () => {
    const a = createRng(42);
    const b = createRng(42);
    const ciagA = [a(), a(), a(), a(), a()];
    const ciagB = [b(), b(), b(), b(), b()];
    expect(ciagA).toEqual(ciagB);
  });

  it("inne ziarno daje inny ciąg", () => {
    const a = createRng(1);
    const b = createRng(2);
    expect([a(), a(), a()]).not.toEqual([b(), b(), b()]);
  });

  it("mieści się w przedziale [0, 1)", () => {
    const rng = createRng(7);
    for (let i = 0; i < 500; i++) {
      const x = rng();
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });

  it("pickFrom zawsze trafia w tablicę", () => {
    const rng = createRng(9);
    const items = ["a", "b", "c"];
    for (let i = 0; i < 200; i++) {
      expect(items).toContain(pickFrom(rng, items));
    }
  });

  it("intBetween trzyma się granic włącznie", () => {
    const rng = createRng(11);
    let widzianoMin = false;
    let widzianoMax = false;
    for (let i = 0; i < 800; i++) {
      const x = intBetween(rng, 3, 6);
      expect(x).toBeGreaterThanOrEqual(3);
      expect(x).toBeLessThanOrEqual(6);
      if (x === 3) widzianoMin = true;
      if (x === 6) widzianoMax = true;
    }
    expect(widzianoMin && widzianoMax).toBe(true);
  });

  it("chanceOf(0) nigdy, chanceOf(1) zawsze", () => {
    const rng = createRng(13);
    for (let i = 0; i < 100; i++) {
      expect(chanceOf(rng, 0)).toBe(false);
      expect(chanceOf(rng, 1)).toBe(true);
    }
  });
});

describe("blockerMessage", () => {
  it("mówi, co konkretnie stoi na drodze", () => {
    const tekst = blockerMessage([
      { co: "zapisy prawdziwych klubowiczów na zajęcia demonstracyjne", ile: 2 },
    ]);
    expect(tekst).toContain("Nie usuwam");
    expect(tekst).toContain("zapisy prawdziwych klubowiczów");
    expect(tekst).toContain("(2)");
  });
});
