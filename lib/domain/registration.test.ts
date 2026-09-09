import { describe, expect, it } from "vitest";
import {
  isValidEmail,
  normalizeEmail,
  requiresApproval,
  selfRegistrationAllowed,
  MINOR_SELF_REGISTER_MESSAGE,
  SELF_REGISTER_MIN_AGE,
  validatePassword,
  validateProfile,
  validateChildProfile,
  validateRegistration,
  type ProfileInput,
  type RegistrationInput,
} from "./registration";

const NOW = new Date("2026-07-21T10:00:00Z");

function adultBirthDate(): Date {
  return new Date("2000-01-01T00:00:00Z");
}

function baseInput(over: Partial<RegistrationInput> = {}): RegistrationInput {
  return {
    firstName: "Jan",
    lastName: "Kowalski",
    email: "jan@example.com",
    phone: "500600700",
    password: "haslo1234",
    confirmPassword: "haslo1234",
    birthDate: adultBirthDate(),
    sex: "MALE",
    homeLocationId: "loc1",
    ownerTrainerId: "tr1",
    ...over,
  };
}

describe("normalizeEmail", () => {
  it("przycina i sprowadza do małych liter", () => {
    expect(normalizeEmail("  JAN@Example.PL ")).toBe("jan@example.pl");
  });
});

describe("isValidEmail", () => {
  it("przyjmuje poprawne adresy", () => {
    expect(isValidEmail("jan@example.pl")).toBe(true);
  });
  it("odrzuca bez małpy albo bez domeny", () => {
    expect(isValidEmail("jan.example.pl")).toBe(false);
    expect(isValidEmail("jan@localhost")).toBe(false);
    expect(isValidEmail("")).toBe(false);
  });
});

describe("validatePassword", () => {
  it("przyjmuje długość + litera + cyfra", () => {
    expect(validatePassword("haslo1234")).toBeNull();
  });
  it("odrzuca za krótkie", () => {
    expect(validatePassword("ab1")).toBe("TOO_SHORT");
  });
  it("odrzuca bez litery", () => {
    expect(validatePassword("12345678")).toBe("NO_LETTER");
  });
  it("odrzuca bez cyfry", () => {
    expect(validatePassword("bezcyfry")).toBe("NO_DIGIT");
  });
});

describe("validateRegistration", () => {
  it("przepuszcza poprawny formularz", () => {
    expect(validateRegistration(baseInput(), NOW)).toBeNull();
  });

  it("wymaga wszystkich pól", () => {
    expect(validateRegistration(baseInput({ firstName: "" }), NOW)).toBe("MISSING_FIELDS");
    expect(validateRegistration(baseInput({ ownerTrainerId: "" }), NOW)).toBe("MISSING_FIELDS");
  });

  it("odrzuca zły e-mail", () => {
    expect(validateRegistration(baseInput({ email: "zly" }), NOW)).toBe("INVALID_EMAIL");
  });

  it("odrzuca datę z przyszłości", () => {
    const future = new Date(NOW.getTime() + 86_400_000);
    expect(validateRegistration(baseInput({ birthDate: future }), NOW)).toBe("INVALID_BIRTHDATE");
  });

  // Zmiana reguły: małoletni MOŻE zarejestrować się sam - walidacja przechodzi,
  // a osobno requiresApproval kieruje konto do zatwierdzenia przez klub.
  it("przepuszcza osobę niepełnoletnią (do zatwierdzenia)", () => {
    const minor = new Date("2015-01-01T00:00:00Z"); // ~11 lat w 2026
    expect(validateRegistration(baseInput({ birthDate: minor }), NOW)).toBeNull();
    expect(requiresApproval(minor, NOW)).toBe(true);
  });

  it("dorosły nie wymaga zatwierdzenia", () => {
    expect(requiresApproval(adultBirthDate(), NOW)).toBe(false);
  });

  it("dokładnie na progu wieku przechodzi", () => {
    const exactly = new Date(NOW);
    exactly.setUTCFullYear(exactly.getUTCFullYear() - SELF_REGISTER_MIN_AGE);
    expect(validateRegistration(baseInput({ birthDate: exactly }), NOW)).toBeNull();
  });

  it("zwraca błąd hasła jako obiekt", () => {
    const result = validateRegistration(
      baseInput({ password: "abc", confirmPassword: "abc" }),
      NOW,
    );
    expect(result).toEqual({ password: "TOO_SHORT" });
  });

  it("odrzuca niezgodne powtórzenie hasła", () => {
    const result = validateRegistration(
      baseInput({ password: "haslo1234", confirmPassword: "haslo9999" }),
      NOW,
    );
    expect(result).toBe("PASSWORD_MISMATCH");
  });

  // Zbyt krótkie, ale zgodne hasło ma zgłosić słabość, nie niezgodność.
  it("słabość hasła ma pierwszeństwo przed zgodnością", () => {
    const result = validateRegistration(
      baseInput({ password: "abc", confirmPassword: "xyz" }),
      NOW,
    );
    expect(result).toEqual({ password: "TOO_SHORT" });
  });
});

describe("validateProfile", () => {
  function profile(over: Partial<ProfileInput> = {}): ProfileInput {
    return {
      firstName: "Jan",
      lastName: "Kowalski",
      phone: "500600700",
      birthDate: adultBirthDate(),
      sex: "MALE",
      homeLocationId: "loc1",
      ownerTrainerId: "tr1",
      ...over,
    };
  }

  it("przepuszcza kompletny profil", () => {
    expect(validateProfile(profile(), NOW)).toBeNull();
  });

  it("wymaga trenera i lokalizacji", () => {
    expect(validateProfile(profile({ ownerTrainerId: "" }), NOW)).toBe("MISSING_FIELDS");
    expect(validateProfile(profile({ homeLocationId: "" }), NOW)).toBe("MISSING_FIELDS");
  });

  it("przepuszcza małoletniego (do zatwierdzenia)", () => {
    const minor = new Date("2015-01-01T00:00:00Z");
    expect(validateProfile(profile({ birthDate: minor }), NOW)).toBeNull();
    expect(requiresApproval(minor, NOW)).toBe(true);
  });

  it("dokładnie na progu wieku przechodzi", () => {
    const exactly = new Date(NOW);
    exactly.setUTCFullYear(exactly.getUTCFullYear() - SELF_REGISTER_MIN_AGE);
    expect(validateProfile(profile({ birthDate: exactly }), NOW)).toBeNull();
  });
});

describe("selfRegistrationAllowed", () => {
  const TERAZ = new Date("2026-09-09T12:00:00Z");

  it("dorosły zakłada konto sam", () => {
    expect(selfRegistrationAllowed(new Date("2000-01-01"), TERAZ)).toBe(true);
  });

  it("niepełnoletni nie - profil dziecka zakłada rodzic", () => {
    expect(selfRegistrationAllowed(new Date("2012-05-20"), TERAZ)).toBe(false);
  });

  it("w dniu 18. urodzin już wolno", () => {
    expect(selfRegistrationAllowed(new Date("2008-09-09"), TERAZ)).toBe(true);
  });

  it("dzień przed osiemnastką jeszcze nie", () => {
    expect(selfRegistrationAllowed(new Date("2008-09-10"), TERAZ)).toBe(false);
  });

  it("komunikat mówi, co zrobić, a nie tylko odmawia", () => {
    expect(MINOR_SELF_REGISTER_MESSAGE).toContain("Załóż najpierw konto na siebie");
    expect(MINOR_SELF_REGISTER_MESSAGE).toContain("Moje dziecko");
  });
});

describe("telefon wymagany przy rejestracji", () => {
  const TERAZ = new Date("2026-09-09T12:00:00Z");

  it("brak numeru mówi wprost o numerze, a nie ogólne 'uzupełnij pola'", () => {
    expect(validateRegistration(baseInput({ phone: "" }), TERAZ)).toEqual({ phone: "EMPTY" });
  });

  it("śmieciowy numer ma własny komunikat, nie ogólne 'uzupełnij pola'", () => {
    const wynik = validateRegistration(baseInput({ phone: "123" }), TERAZ);
    expect(wynik).toEqual({ phone: "POLISH_WRONG_LENGTH" });
  });

  it("dziewięć cyfr wystarczy - tak numer podaje Polak z pamięci", () => {
    expect(validateRegistration(baseInput({ phone: "500 600 700" }), TERAZ)).toBeNull();
  });

  it("numer zagraniczny z kierunkowym przechodzi", () => {
    expect(validateRegistration(baseInput({ phone: "+380671234567" }), TERAZ)).toBeNull();
  });

  it("ta sama reguła obowiązuje przy dokończeniu profilu po Google", () => {
    const bezNumeru = validateProfile(
      {
        firstName: "Jan",
        lastName: "Kowalski",
        phone: "",
        birthDate: new Date("2000-01-01"),
        sex: "MALE",
        homeLocationId: "loc1",
        ownerTrainerId: "tr1",
      },
      TERAZ,
    );
    expect(bezNumeru).toEqual({ phone: "EMPTY" });
  });

  it("profil DZIECKA nie wymaga numeru - kontaktem jest rodzic", () => {
    const dziecko = validateChildProfile(
      {
        firstName: "Zosia",
        lastName: "Kowalska",
        birthDate: new Date("2014-05-10"),
        sex: "FEMALE",
        homeLocationId: "loc1",
        ownerTrainerId: "tr1",
      },
      TERAZ,
    );
    expect(dziecko).toBeNull();
  });
});
