import { describe, expect, it } from "vitest";
import {
  DEFAULT_SMS_SENDER,
  SMS_SENDER_MAX_LENGTH,
  smsCost,
  smsRecipient,
  toGsmAlphabet,
  validateSmsSender,
} from "./sms";
import { buildWelcomeSms } from "./lead-import";

describe("toGsmAlphabet", () => {
  it("zdejmuje polskie ogonki, zostawiając czytelny tekst", () => {
    expect(toGsmAlphabet("Cześć Michał, zapraszamy na zajęcia!")).toBe(
      "Czesc Michal, zapraszamy na zajecia!",
    );
  });

  it("zna wielkie litery", () => {
    expect(toGsmAlphabet("ŻÓŁW ŁĄKA ŚĆ")).toBe("ZOLW LAKA SC");
  });

  it("nie rusza tego, co i tak jest w alfabecie GSM", () => {
    const tekst = "Karnet 30 dni - 200 zl. Czekamy! (Czapla Boxing)";
    expect(toGsmAlphabet(tekst)).toBe(tekst);
  });

  it("łapie znaki, które wyglądają zwyczajnie, a nie są", () => {
    // Cudzysłowy z Worda, półpauza i twarda spacja - każde z nich w milczeniu
    // przełącza wiadomość na UCS-2 i podwaja rachunek.
    expect(toGsmAlphabet("„Trening” – dziś o 18")).toBe('"Trening" - dzis o 18');
  });

  it("obce litery sprowadza do gołych, a czego nie da się - do pytajnika", () => {
    // Litery, których w tablicy GSM nie ma (czeskie i łotewskie).
    expect(toGsmAlphabet("Škoda")).toBe("Skoda");
    expect(toGsmAlphabet("Kūkas")).toBe("Kukas");
    expect(toGsmAlphabet("智")).toBe("?");
  });

  it("nie rusza liter, które w alfabecie GSM SĄ", () => {
    // é, ü i à mieszczą się w tablicy GSM, więc nie kosztują ani grosza
    // więcej - kaleczenie ich byłoby psuciem treści bez powodu.
    expect(toGsmAlphabet("José à Zürich")).toBe("José à Zürich");
    expect(smsCost("José à Zürich").encoding).toBe("GSM");
  });
});

describe("smsCost", () => {
  it("krótka wiadomość bez ogonków to jeden segment", () => {
    expect(smsCost("Czekamy na treningu!")).toEqual({ encoding: "GSM", units: 20, segments: 1 });
  });

  it("160 znakow to jeszcze jeden segment, 161 to juz dwa", () => {
    expect(smsCost("a".repeat(160)).segments).toBe(1);
    expect(smsCost("a".repeat(161)).segments).toBe(2);
  });

  it("jeden ogonek przestawia całą wiadomość na UCS-2", () => {
    const cost = smsCost("Do zobaczenia na zajęciach");
    expect(cost.encoding).toBe("UCS2");
    expect(cost.segments).toBe(1);
  });

  it("w UCS-2 próg spada ze 160 na 70 znaków", () => {
    // Ta sama treść: z ogonkami dwa segmenty, bez ogonków jeden. To jest
    // dokładnie ten mechanizm, przez który rachunek klubu potrafi się podwoić.
    const zOgonkami = "ą".repeat(71);
    expect(smsCost(zOgonkami).segments).toBe(2);
    expect(smsCost(toGsmAlphabet(zOgonkami)).segments).toBe(1);
  });

  it("znaki z tablicy rozszerzonej GSM liczą się podwójnie", () => {
    // Nawias klamrowy i Enter zajmują po dwie jednostki, choć na ekranie
    // wyglądają na jeden znak.
    expect(smsCost("[]").units).toBe(4);
    expect(smsCost("€").units).toBe(2);
  });

  it("nigdy nie zwraca zera segmentów", () => {
    expect(smsCost("").segments).toBe(1);
  });
});

describe("powitanie leada", () => {
  it("po zdjęciu ogonków mieści się w jednym segmencie", () => {
    // To jest test o pieniądzach, nie o formatowaniu: powitanie idzie do
    // każdego obdzwonionego leada, więc drugi segment to podwojony rachunek
    // za całą kampanię.
    const tresc = buildWelcomeSms("Katarzyna");
    expect(smsCost(tresc).encoding).toBe("UCS2");
    expect(smsCost(tresc).segments).toBeGreaterThan(1);

    const doWyslania = toGsmAlphabet(tresc);
    expect(smsCost(doWyslania)).toEqual({
      encoding: "GSM",
      units: doWyslania.length,
      segments: 1,
    });
  });
});

describe("validateSmsSender", () => {
  it("domyślny nadawca klubu jest poprawny", () => {
    expect(validateSmsSender(DEFAULT_SMS_SENDER)).toBeNull();
    expect(DEFAULT_SMS_SENDER.length).toBeLessThanOrEqual(SMS_SENDER_MAX_LENGTH);
  });

  it("odrzuca pełną nazwę klubu - ma dwanaście znaków", () => {
    // Powód, dla którego klub wysyła jako "CzaplaBox", a nie "CzaplaBoxing".
    expect(validateSmsSender("CzaplaBoxing")).toContain("11 znaków");
  });

  it("odrzuca ogonki - operatorzy ich nie przyjmują", () => {
    expect(validateSmsSender("CzaplaBoks!")).not.toBeNull();
    expect(validateSmsSender("Ćwiczenia")).not.toBeNull();
  });

  it("odrzuca pustą nazwę i samą liczbę", () => {
    expect(validateSmsSender("   ")).not.toBeNull();
    expect(validateSmsSender("48123")).not.toBeNull();
  });
});

describe("smsRecipient", () => {
  it("zdejmuje plus i separatory z numeru z bazy", () => {
    expect(smsRecipient("+48601234567")).toBe("48601234567");
    expect(smsRecipient("+48 601 234 567")).toBe("48601234567");
  });
});
