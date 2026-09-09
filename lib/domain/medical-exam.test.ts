import { describe, expect, it } from "vitest";
import {
  MEDICAL_EXAM_REMINDER_DAYS,
  daysLeft,
  examState,
  reminderForAthlete,
  shouldRemind,
} from "./medical-exam";

// Środa, 9 września 2026, 23:30 czasu klubu (21:30 UTC) - celowo późny wieczór,
// żeby złapać błędy liczenia dni różnicą milisekund zamiast dat.
const TERAZ = new Date("2026-09-09T21:30:00Z");
const dzien = (iso: string) => new Date(`${iso}T00:00:00Z`);

describe("daysLeft", () => {
  it("liczy DNI kalendarzowe, nie różnicę godzin", () => {
    // Badania ważne do jutra są ważne przez cały jutrzejszy dzień, choć od
    // "teraz" dzieli je mniej niż 24 godziny.
    expect(daysLeft(dzien("2026-09-10"), TERAZ)).toBe(1);
  });

  it("dzień wygaśnięcia to zero, nie minus", () => {
    expect(daysLeft(dzien("2026-09-09"), TERAZ)).toBe(0);
  });

  it("po terminie schodzi poniżej zera", () => {
    expect(daysLeft(dzien("2026-09-08"), TERAZ)).toBe(-1);
  });
});

describe("examState", () => {
  it("brak daty to brak badań", () => {
    expect(examState(null, TERAZ)).toBe("BRAK");
  });

  it("daleki termin jest po prostu ważny", () => {
    expect(examState(dzien("2027-03-01"), TERAZ)).toBe("WAZNE");
  });

  it(`${MEDICAL_EXAM_REMINDER_DAYS} dni przed - juz sie konczy`, () => {
    expect(examState(dzien("2026-09-23"), TERAZ)).toBe("KONCZY_SIE");
  });

  it("dzień przed progiem to jeszcze spokój", () => {
    expect(examState(dzien("2026-09-24"), TERAZ)).toBe("WAZNE");
  });

  it("dzień wygaśnięcia jeszcze się liczy", () => {
    expect(examState(dzien("2026-09-09"), TERAZ)).toBe("KONCZY_SIE");
  });

  it("po terminie - nieważne", () => {
    expect(examState(dzien("2026-09-08"), TERAZ)).toBe("WYGASLO");
  });
});

describe("shouldRemind", () => {
  it("przypomina w calym oknie, nie tylko dokladnie 14 dni przed", () => {
    // Wąskie okno kasowałoby przypomnienie na zawsze po jednym nieudanym
    // uruchomieniu nocnego zadania.
    for (const iso of ["2026-09-23", "2026-09-18", "2026-09-10", "2026-09-09"]) {
      expect(shouldRemind(dzien(iso), TERAZ)).toBe(true);
    }
  });

  it("nie przypomina za wcześnie", () => {
    expect(shouldRemind(dzien("2026-09-24"), TERAZ)).toBe(false);
  });

  it("nie przypomina po terminie - wtedy jest już inna rozmowa", () => {
    expect(shouldRemind(dzien("2026-09-08"), TERAZ)).toBe(false);
  });

  it("brak daty to brak przypomnienia", () => {
    expect(shouldRemind(null, TERAZ)).toBe(false);
  });
});

describe("reminderForAthlete", () => {
  it("mówi po ludzku, ile zostało", () => {
    expect(
      reminderForAthlete({ name: "Jan", validUntil: dzien("2026-09-09"), now: TERAZ }).body,
    ).toContain("kończą się dzisiaj");
    expect(
      reminderForAthlete({ name: "Jan", validUntil: dzien("2026-09-10"), now: TERAZ }).body,
    ).toContain("kończą się jutro");
    expect(
      reminderForAthlete({ name: "Jan", validUntil: dzien("2026-09-23"), now: TERAZ }).body,
    ).toContain("za 14 dni");
  });

  it("mówi, co z tym zrobić, a nie tylko że się kończy", () => {
    const { body } = reminderForAthlete({
      name: "Jan",
      validUntil: dzien("2026-09-20"),
      now: TERAZ,
    });
    expect(body).toContain("umów się na wizytę");
    expect(body).toContain("nie wystartujesz");
  });
});
