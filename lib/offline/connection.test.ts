import { describe, expect, it } from "vitest";
import { isNetworkError } from "./connection";

// To jest rozstrzygnięcie, na którym stoi cały tryb offline: OFFLINE oznacza
// WYŁĄCZNIE brak kontaktu z serwerem. Gdyby wpadła tu odmowa serwera, kolejka
// przyjmowałaby zapisy, których baza i tak nie przyjmie - a wskaźnik kłamałby
// o stanie łącza.
describe("isNetworkError", () => {
  it("brak sieci z fetcha to brak łącza", () => {
    expect(isNetworkError(new TypeError("Failed to fetch"))).toBe(true);
  });

  it("wariant Safari też", () => {
    expect(isNetworkError(new Error("Load failed"))).toBe(true);
  });

  it("wariant Firefoksa też", () => {
    expect(isNetworkError(new Error("NetworkError when attempting to fetch resource."))).toBe(true);
  });

  it("odmowa serwera to NIE brak łącza", () => {
    expect(isNetworkError(new Error("Brak dostępu do tych zajęć."))).toBe(false);
  });

  it("wygasła sesja to NIE brak łącza", () => {
    expect(isNetworkError(new Error("Sesja wygasła - zaloguj się ponownie."))).toBe(false);
  });
});
