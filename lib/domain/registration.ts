// Czyste funkcje rejestracji i haseł - bez dostępu do bazy, w pełni testowalne.

import { calculateAge } from "@/lib/domain/booking";
import { parsePhone, type PhoneError } from "@/lib/domain/phone";

export const PASSWORD_MIN_LENGTH = 8;

// Próg pełnoletności. Osoba poniżej może założyć konto samodzielnie, ale
// wchodzi ono w stan "oczekuje na zatwierdzenie" (ApprovalStatus.PENDING) i
// klub musi je zaakceptować, zanim cokolwiek zarezerwuje. Dorosły rejestruje
// się bez tego kroku. Patrz [[requiresApproval]] i booking.ts (NOT_APPROVED).
export const SELF_REGISTER_MIN_AGE = 18;

// Czy samodzielna rejestracja tej osoby wymaga zatwierdzenia przez admina.
// Jedno miejsce reguły "nieletni = zatwierdzenie", używane i przez UI (żeby
// od razu ostrzec), i przez akcje serwerowe (żeby ustawić PENDING).
export function requiresApproval(birthDate: Date, now: Date): boolean {
  return calculateAge(birthDate, now) < SELF_REGISTER_MIN_AGE;
}

// Czy ta osoba w ogóle może założyć sobie konto SAMA.
//
// Nie może, jeśli jest niepełnoletnia: profil dziecka zakłada rodzic ze swojego
// konta (/app/dziecko). Powód nie jest formalny - to rodzic podpisuje zgody,
// odbiera powiadomienia i odpowiada za dziecko, więc konto musi od pierwszej
// chwili wisieć przy nim, a nie być doczepiane później przez klub.
//
// Reguła siedzi TUTAJ, a nie w akcji ekranu, bo samodzielne konto powstaje
// dwiema drogami: formularzem rejestracji i dokończeniem profilu po logowaniu
// Google. Blokada w jednej zostawiałaby identyczne wejście w drugiej.
export function selfRegistrationAllowed(birthDate: Date, now: Date): boolean {
  return calculateAge(birthDate, now) >= SELF_REGISTER_MIN_AGE;
}

export const MINOR_SELF_REGISTER_MESSAGE =
  "Konto dla osoby niepełnoletniej zakłada rodzic lub opiekun prawny ze swojego konta. " +
  "Załóż najpierw konto na siebie, a potem w zakładce „Moje dziecko” dodaj profil dziecka.";

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

// Świadomie luźna walidacja: pełna zgodność z RFC nie odsiewa realnych błędów
// lepiej niż "jest małpa i kropka po niej", a odrzuca poprawne adresy.
export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export type PasswordError = "TOO_SHORT" | "NO_LETTER" | "NO_DIGIT";

// Minimum, które ma sens dla konta klubowicza: długość plus litera i cyfra.
// Nie wymuszamy znaków specjalnych - to zniechęca bardziej, niż pomaga, a
// klient i tak nie trzyma tu niczego wrażliwego poza własnym grafikiem.
export function validatePassword(password: string): PasswordError | null {
  if (password.length < PASSWORD_MIN_LENGTH) return "TOO_SHORT";
  if (!/[a-zA-Z]/.test(password)) return "NO_LETTER";
  if (!/[0-9]/.test(password)) return "NO_DIGIT";
  return null;
}

export const PASSWORD_ERROR_MESSAGE: Record<PasswordError, string> = {
  TOO_SHORT: `Hasło musi mieć co najmniej ${PASSWORD_MIN_LENGTH} znaków.`,
  NO_LETTER: "Hasło musi zawierać co najmniej jedną literę.",
  NO_DIGIT: "Hasło musi zawierać co najmniej jedną cyfrę.",
};

export type RegistrationError =
  | "MISSING_FIELDS"
  | "INVALID_EMAIL"
  | "INVALID_BIRTHDATE"
  | "PASSWORD_MISMATCH"
  | { password: PasswordError }
  | { phone: PhoneError };

export type RegistrationInput = {
  firstName: string;
  lastName: string;
  email: string;
  // Numer WYMAGANY. Klub dzwoni częściej, niż pisze: przy odwołanych zajęciach,
  // zaległej wpłacie i dziecku, po które nikt nie przyszedł, e-mail przeczyta
  // się wieczorem, a telefon odbiera się od razu.
  phone: string;
  password: string;
  confirmPassword: string;
  birthDate: Date;
  sex: string;
  homeLocationId: string;
  ownerTrainerId: string;
};

// Walidacja formularza rejestracji. Osobno od bazy (unikalność e-maila
// sprawdza akcja), żeby dało się przetestować bez Postgresa.
export function validateRegistration(
  input: RegistrationInput,
  now: Date,
): RegistrationError | null {
  if (
    !input.firstName ||
    !input.lastName ||
    !input.email ||
    !input.homeLocationId ||
    !input.ownerTrainerId
  ) {
    return "MISSING_FIELDS";
  }
  if (input.sex !== "MALE" && input.sex !== "FEMALE") return "MISSING_FIELDS";

  // Numer sprawdza `parsePhone` z lib/domain/phone.ts - jedyne miejsce
  // w systemie, które wie, co jest numerem. Druga, własna walidacja tutaj
  // skończyłaby się dwiema różnymi regułami dla tego samego pola.
  const numer = parsePhone(input.phone);
  if ("error" in numer) return { phone: numer.error };
  if (!isValidEmail(input.email)) return "INVALID_EMAIL";

  // Osoba niepełnoletnia MOŻE zarejestrować się sama - konto trafia wtedy do
  // zatwierdzenia przez klub (patrz requiresApproval + akcja rejestracji).
  // Tu pilnujemy tylko, że data urodzenia jest realna.
  if (Number.isNaN(input.birthDate.getTime()) || input.birthDate > now) {
    return "INVALID_BIRTHDATE";
  }

  const passwordError = validatePassword(input.password);
  if (passwordError) return { password: passwordError };

  // Sprawdzamy zgodność dopiero po walidacji siły - inaczej "hasła się nie
  // zgadzają" przy dwóch identycznych, ale za krótkich hasłach myliłoby.
  if (input.password !== input.confirmPassword) return "PASSWORD_MISMATCH";

  return null;
}

export type ProfileError = "MISSING_FIELDS" | "INVALID_BIRTHDATE" | { phone: PhoneError };

export type ProfileInput = {
  firstName: string;
  lastName: string;
  // Google daje e-mail, ale nie daje numeru - a numer jest wymagany tak samo
  // jak przy formularzu.
  phone: string;
  birthDate: Date;
  sex: string;
  homeLocationId: string;
  ownerTrainerId: string;
};

// Dokończenie profilu po logowaniu Google: tożsamość (e-mail, hasło) daje już
// Google, więc zostają pola, których nie zna - a których wymaga kartoteka.
// Nieletni też może dokończyć profil; konto trafia do zatwierdzenia (tak samo
// jak przy rejestracji formularzem, patrz requiresApproval).
export function validateProfile(input: ProfileInput, now: Date): ProfileError | null {
  const wspolne = validateChildProfile(input, now);
  if (wspolne) return wspolne;

  const numer = parsePhone(input.phone);
  if ("error" in numer) return { phone: numer.error };

  return null;
}

// Profil DZIECKA zakładany przez rodzica: te same pola, ale bez telefonu.
// Dziecko nie ma własnego konta ani numeru - kontaktem jest jego rodzic,
// a jego numer wisi przy koncie rodzica.
export function validateChildProfile(
  input: Omit<ProfileInput, "phone">,
  now: Date,
): ProfileError | null {
  if (
    !input.firstName ||
    !input.lastName ||
    !input.homeLocationId ||
    !input.ownerTrainerId ||
    (input.sex !== "MALE" && input.sex !== "FEMALE")
  ) {
    return "MISSING_FIELDS";
  }
  if (Number.isNaN(input.birthDate.getTime()) || input.birthDate > now) {
    return "INVALID_BIRTHDATE";
  }
  return null;
}
