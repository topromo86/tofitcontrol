import { describe, expect, it } from "vitest";
import {
  buildLeadConsentText,
  buildSmsConsentText,
  consentInForce,
  smsConsentState,
} from "./contact-consent";

const dzien = (iso: string) => new Date(`${iso}T12:00:00Z`);

describe("consentInForce", () => {
  it("brak wpisów to brak zgody", () => {
    expect(consentInForce([])).toBe(false);
  });

  it("zgoda z formularza kampanii obowiązuje", () => {
    expect(consentInForce([{ granted: true, grantedAt: dzien("2026-09-01") }])).toBe(true);
  });

  it("rozstrzyga NAJPÓŹNIEJSZE oświadczenie, nie jakiekolwiek", () => {
    // Bez tego jedno "tak" sprzed roku przebijałoby wczorajsze "proszę
    // przestać" - czyli klub wysyłałby wiadomości komuś, kto ich odmówił.
    const wpisy = [
      { granted: true, grantedAt: dzien("2026-09-01") },
      { granted: false, grantedAt: dzien("2026-09-05") },
    ];
    expect(consentInForce(wpisy)).toBe(false);
    // Kolejność na wejściu nie ma znaczenia - decyduje data, nie pozycja.
    expect(consentInForce([...wpisy].reverse())).toBe(false);
  });

  it("zgodę da się udzielić ponownie po wycofaniu", () => {
    expect(
      consentInForce([
        { granted: true, grantedAt: dzien("2026-09-01") },
        { granted: false, grantedAt: dzien("2026-09-05") },
        { granted: true, grantedAt: dzien("2026-09-09") },
      ]),
    ).toBe(true);
  });
});

describe("smsConsentState", () => {
  it("rozróżnia brak zgody od zgody wycofanej", () => {
    // To nie jest kosmetyka na ekranie: "brak" znaczy "zapytaj", a "wycofana"
    // znaczy "nie pytaj więcej".
    expect(smsConsentState([])).toBe("BRAK");
    expect(smsConsentState([{ granted: false, grantedAt: dzien("2026-09-05") }])).toBe("WYCOFANA");
    expect(smsConsentState([{ granted: true, grantedAt: dzien("2026-09-05") }])).toBe("UDZIELONA");
  });
});

describe("buildSmsConsentText", () => {
  it("zawiera administratora, kanał, cel i prawo wycofania", () => {
    const tekst = buildSmsConsentText("Czapla Boxing sp. z o.o., NIP 000, Tychy");
    expect(tekst).toContain("Czapla Boxing sp. z o.o., NIP 000, Tychy");
    expect(tekst).toContain("SMS");
    expect(tekst).toContain("karnety");
    expect(tekst).toContain("wycofać");
  });
});

describe("buildLeadConsentText", () => {
  it("wkleja dosłownie treść formularza, gdy klub ją podał", () => {
    const tekst = buildLeadConsentText("Czy jesteś w stanie zapłacić 100 zł za trening próbny?");
    expect(tekst).toContain("Czy jesteś w stanie zapłacić 100 zł za trening próbny?");
  });

  it("bez treści formularza mówi wprost, że jej nie ma", () => {
    // Zapis, który udaje cytat, jest gorszy niż zapis, który przyznaje, czym
    // jest: opisem systemu, a nie wypowiedzią człowieka.
    const tekst = buildLeadConsentText(null);
    expect(tekst).toContain("nie została uzupełniona");
    expect(buildLeadConsentText("   ")).toBe(tekst);
  });
});
