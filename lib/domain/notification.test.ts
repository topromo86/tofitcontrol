import { describe, expect, it } from "vitest";
import {
  isNotificationType,
  NOTIFICATION_TYPES,
  parsePreferenceForm,
  visibleTypes,
  wantsNotification,
  type StoredPreference,
} from "./notification";

describe("visibleTypes", () => {
  it("klient bez podopiecznych nie widzi powiadomienia o dziecku", () => {
    const types = visibleTypes(false).map((t) => t.type);
    expect(types).not.toContain("CHECK_IN");
    expect(types).toContain("SESSION_REMINDER");
  });

  it("opiekun widzi wszystkie", () => {
    expect(visibleTypes(true)).toHaveLength(NOTIFICATION_TYPES.length);
  });
});

describe("wantsNotification", () => {
  it("bez zapisanej preferencji bierze wartość domyślną", () => {
    expect(wantsNotification([], "SESSION_REMINDER", "PUSH")).toBe(true);
    expect(wantsNotification([], "BOOKING_SUGGESTION", "PUSH")).toBe(false);
  });

  // SMS kosztuje - nikt go nie dostaje, dopóki sam nie włączy.
  it("SMS domyślnie wyłączony dla każdego typu", () => {
    for (const meta of NOTIFICATION_TYPES) {
      expect(wantsNotification([], meta.type, "SMS")).toBe(false);
    }
  });

  it("zapisana preferencja wygrywa z domyślną", () => {
    const prefs: StoredPreference[] = [
      { type: "SESSION_REMINDER", push: false, email: false, sms: true },
    ];
    expect(wantsNotification(prefs, "SESSION_REMINDER", "PUSH")).toBe(false);
    expect(wantsNotification(prefs, "SESSION_REMINDER", "SMS")).toBe(true);
  });

  it("preferencja jednego typu nie wpływa na inny", () => {
    const prefs: StoredPreference[] = [
      { type: "SESSION_REMINDER", push: false, email: false, sms: false },
    ];
    expect(wantsNotification(prefs, "CHECK_IN", "PUSH")).toBe(true);
  });
});

describe("parsePreferenceForm", () => {
  it("niezaznaczone typy zapisują się jako wyłączone", () => {
    const result = parsePreferenceForm(["SESSION_REMINDER:PUSH"], false);
    // Bez wypisywania listy typow na sztywno: dodanie nowego powiadomienia nie
    // ma wywracac testu o tym, ze NIEZAZNACZONE zapisuja sie jako wylaczone.
    expect(result.find((r) => r.type === "SESSION_REMINDER")).toEqual({
      type: "SESSION_REMINDER",
      push: true,
      email: false,
      sms: false,
    });
    for (const r of result.filter((x) => x.type !== "SESSION_REMINDER")) {
      expect(r).toEqual({ type: r.type, push: false, email: false, sms: false });
    }
  });

  it("obsługuje oba kanały naraz", () => {
    const result = parsePreferenceForm(["SESSION_REMINDER:PUSH", "SESSION_REMINDER:SMS"], false);
    expect(result.find((r) => r.type === "SESSION_REMINDER")).toEqual({
      type: "SESSION_REMINDER",
      push: true,
      email: false,
      sms: true,
    });
  });

  // Bez tego klient mógłby podrobić formularz i włączyć sobie powiadomienie
  // o cudzym dziecku.
  it("odrzuca typ niedostępny dla tej roli", () => {
    const result = parsePreferenceForm(["CHECK_IN:PUSH"], false);
    expect(result.some((r) => r.type === "CHECK_IN")).toBe(false);
  });

  it("opiekun może włączyć powiadomienie o dziecku", () => {
    const result = parsePreferenceForm(["CHECK_IN:PUSH"], true);
    expect(result.find((r) => r.type === "CHECK_IN")?.push).toBe(true);
  });

  it("ignoruje śmieci w formularzu", () => {
    const result = parsePreferenceForm(["NIE_ISTNIEJE:PUSH", "SESSION_REMINDER:TELEPATIA"], false);
    expect(result.every((r) => !r.push && !r.email && !r.sms)).toBe(true);
  });
});

describe("kanał e-mail", () => {
  // Poczta transakcyjna (potwierdzenie i przypomnienie zapisu) idzie mailem
  // domyślnie - klient zostawia klubowi adres po to, by ją dostawać (opt-out).
  it("potwierdzenie i przypomnienie zapisu domyślnie włączone (opt-out)", () => {
    expect(wantsNotification([], "BOOKING_CONFIRMATION", "EMAIL")).toBe(true);
    expect(wantsNotification([], "SESSION_REMINDER", "EMAIL")).toBe(true);
  });

  // Zachęty (sugestie) i wejście dziecka na salę - bez maila domyślnie.
  it("sugestie zapisu domyślnie bez maila (opt-in)", () => {
    expect(wantsNotification([], "BOOKING_SUGGESTION", "EMAIL")).toBe(false);
  });

  it("klient może wyłączyć mail zapisaną preferencją (opt-out)", () => {
    const prefs: StoredPreference[] = [
      { type: "BOOKING_CONFIRMATION", push: true, email: false, sms: false },
    ];
    expect(wantsNotification(prefs, "BOOKING_CONFIRMATION", "EMAIL")).toBe(false);
  });

  it("włączony zapisaną preferencją", () => {
    const prefs: StoredPreference[] = [
      { type: "SESSION_REMINDER", push: false, email: true, sms: false },
    ];
    expect(wantsNotification(prefs, "SESSION_REMINDER", "EMAIL")).toBe(true);
  });

  // "Dziecko weszło na salę" ma sens wyłącznie natychmiast - mail przeczytany
  // po godzinie jest bezwartościowy.
  it("CHECK_IN nie idzie mailem nawet z zapisaną preferencją", () => {
    const prefs: StoredPreference[] = [{ type: "CHECK_IN", push: true, email: true, sms: false }];
    expect(wantsNotification(prefs, "CHECK_IN", "EMAIL")).toBe(false);
    expect(wantsNotification(prefs, "CHECK_IN", "PUSH")).toBe(true);
  });

  it("formularz nie włączy maila tam, gdzie go nie wysyłamy", () => {
    const result = parsePreferenceForm(["CHECK_IN:EMAIL"], true);
    expect(result.find((r) => r.type === "CHECK_IN")?.email).toBe(false);
  });

  it("formularz włącza mail tam, gdzie jest wspierany", () => {
    const result = parsePreferenceForm(["SESSION_REMINDER:EMAIL"], false);
    expect(result.find((r) => r.type === "SESSION_REMINDER")?.email).toBe(true);
  });

  it("push i e-mail są niezależne - można mieć oba", () => {
    const result = parsePreferenceForm(["SESSION_REMINDER:PUSH", "SESSION_REMINDER:EMAIL"], false);
    const pref = result.find((r) => r.type === "SESSION_REMINDER")!;
    expect(pref.push).toBe(true);
    expect(pref.email).toBe(true);
  });
});

describe("isNotificationType", () => {
  it("rozpoznaje znane typy", () => {
    expect(isNotificationType("SESSION_REMINDER")).toBe(true);
    expect(isNotificationType("CO_TO")).toBe(false);
  });
});
