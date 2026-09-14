import { describe, expect, it } from "vitest";
import { formatPhone, parsePhone, phoneKey } from "./phone";

function phoneOf(raw: string): string | null {
  const result = parsePhone(raw);
  return "phone" in result ? result.phone : null;
}

function errorOf(raw: string): string | null {
  const result = parsePhone(raw);
  return "error" in result ? result.error : null;
}

describe("parsePhone - numer polski bez kierunkowego", () => {
  // Polak wpisuje dziewięć cyfr z pamięci i ma prawo nie myśleć o kierunkowym.
  it("dziewięć cyfr traktuje jako polski numer", () => {
    expect(phoneOf("500600700")).toBe("+48500600700");
    expect(phoneOf("500 600 700")).toBe("+48500600700");
    expect(phoneOf("500-600-700")).toBe("+48500600700");
    expect(phoneOf("(500) 600 700")).toBe("+48500600700");
  });

  it("rozumie zapis z zerem wiodącym z wizytówek", () => {
    expect(phoneOf("0500600700")).toBe("+48500600700");
  });

  it("zła liczba cyfr kieruje do właściwego wyjaśnienia", () => {
    expect(errorOf("50060070")).toBe("POLISH_WRONG_LENGTH");
    expect(errorOf("5006007001")).toBe("POLISH_WRONG_LENGTH");
  });
});

describe("parsePhone - numery zagraniczne", () => {
  // Sedno tej wersji: kadra i klubowicze bywają z zagranicy, więc obcy
  // kierunkowy nie może być powodem odrzucenia.
  it("przyjmuje numer ukraiński", () => {
    expect(phoneOf("+380671234567")).toBe("+380671234567");
    expect(phoneOf("+380 67 123 45 67")).toBe("+380671234567");
  });

  it("przyjmuje numer niemiecki", () => {
    expect(phoneOf("+49 151 12345678")).toBe("+4915112345678");
  });

  it("przyjmuje numer brytyjski i czeski", () => {
    expect(phoneOf("+44 7700 900123")).toBe("+447700900123");
    expect(phoneOf("+420 601 123 456")).toBe("+420601123456");
  });

  it("rozumie zapis 00 zamiast plusa", () => {
    expect(phoneOf("00380671234567")).toBe("+380671234567");
    expect(phoneOf("0048500600700")).toBe("+48500600700");
  });

  it("polski numer z kierunkowym zostaje bez zmian", () => {
    expect(phoneOf("+48500600700")).toBe("+48500600700");
    expect(phoneOf("+48 500 600 700")).toBe("+48500600700");
  });

  it("odrzuca numer za krótki albo absurdalnie długi", () => {
    expect(errorOf("+4812")).toBe("WRONG_LENGTH");
    expect(errorOf("+4812345678901234567")).toBe("WRONG_LENGTH");
  });
});

describe("parsePhone - odrzucenia", () => {
  it("pusty numer", () => {
    expect(errorOf("")).toBe("EMPTY");
    expect(errorOf("   ")).toBe("EMPTY");
  });

  it("litery zamiast cyfr", () => {
    expect(errorOf("pięćset")).toBe("NOT_A_NUMBER");
    expect(errorOf("+48abcdefghi")).toBe("NOT_A_NUMBER");
  });
});

describe("formatPhone", () => {
  it("polski numer rozdziela do czytania", () => {
    expect(formatPhone("+48500600700")).toBe("+48 500 600 700");
  });

  // Każdy kraj grupuje inaczej - zgadywanie skończyłoby się gorzej niż brak
  // grupowania.
  it("zagranicznego nie grupuje", () => {
    expect(formatPhone("+380671234567")).toBe("+380671234567");
    expect(formatPhone("+4915112345678")).toBe("+4915112345678");
  });
});

describe("phoneKey - tożsamość numeru po ciągu cyfr", () => {
  it("ten sam numer w pięciu zapisach to JEDNA osoba", () => {
    // Dokładnie te postacie leżały obok siebie w bazie klubu i przez
    // porównywanie napisów dały 923 leady na 183 osoby.
    const ten_sam = [
      "605687770",
      "48605687770",
      "+48605687770",
      "+48 605 687 770",
      "0048605687770",
    ];
    const klucze = new Set(ten_sam.map((n) => phoneKey(n)));
    expect(klucze.size).toBe(1);
    expect([...klucze][0]).toBe("PL:605687770");
  });

  it("zna zapis z wiodącym zerem z wizytówki", () => {
    expect(phoneKey("0605687770")).toBe("PL:605687770");
  });

  it("numeru zagranicznego NIE ścina do dziewięciu cyfr", () => {
    // Holenderski numer kończy się inaczej niż polski, ale gdyby ścinać do
    // dziewięciu cyfr, dwa kraje zlałyby się w jedną osobę.
    expect(phoneKey("31613737346")).toBe("INT:31613737346");
    expect(phoneKey("+380671234567")).toBe("INT:380671234567");
  });

  it("różne numery zostają różne", () => {
    expect(phoneKey("605687770")).not.toBe(phoneKey("605687771"));
  });

  it("pusty i śmieciowy numer nie ma tożsamości", () => {
    expect(phoneKey(null)).toBeNull();
    expect(phoneKey("")).toBeNull();
    expect(phoneKey("brak")).toBeNull();
  });
});
