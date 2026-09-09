"use server";

import { AuthError } from "next-auth";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { signIn } from "@/auth";
import { prisma } from "@/lib/prisma";
import { calculateAge } from "@/lib/domain/booking";
import {
  normalizeEmail,
  PASSWORD_ERROR_MESSAGE,
  requiresApproval,
  validateRegistration,
  type RegistrationError,
  MINOR_SELF_REGISTER_MESSAGE,
  selfRegistrationAllowed,
} from "@/lib/domain/registration";
import { PHONE_ERROR_MESSAGE, parsePhone } from "@/lib/domain/phone";
import { hashPassword } from "@/lib/services/password-reset";
import { startEmailVerification } from "@/lib/services/email-verification";
import { logActivity } from "@/lib/services/activity";
import type { Sex } from "@/app/generated/prisma/client";

// Adres aplikacji z nagłówków - link weryfikacyjny wskazuje na ten sam host.
async function baseUrl(): Promise<string> {
  const h = await headers();
  const host = h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

export type RegisterState = { error?: string };

const ERROR_MESSAGE: Record<
  Exclude<RegistrationError, { password: unknown } | { phone: unknown }>,
  string
> = {
  MISSING_FIELDS: "Uzupełnij wszystkie pola.",
  INVALID_EMAIL: "Podaj poprawny adres e-mail.",
  INVALID_BIRTHDATE: "Podaj poprawną datę urodzenia.",
  PASSWORD_MISMATCH: "Hasła nie są takie same.",
};

export async function registerAction(
  _prev: RegisterState,
  formData: FormData,
): Promise<RegisterState> {
  const email = normalizeEmail(String(formData.get("email") ?? ""));
  const phoneRaw = String(formData.get("phone") ?? "");
  const password = String(formData.get("password") ?? "");
  const confirmPassword = String(formData.get("confirmPassword") ?? "");
  const firstName = String(formData.get("firstName") ?? "").trim();
  const lastName = String(formData.get("lastName") ?? "").trim();
  const birthDateStr = String(formData.get("birthDate") ?? "");
  const sex = String(formData.get("sex") ?? "");
  const homeLocationId = String(formData.get("homeLocationId") ?? "");
  const ownerTrainerId = String(formData.get("ownerTrainerId") ?? "");

  const now = new Date();
  const birthDate = new Date(birthDateStr);

  const validation = validateRegistration(
    {
      firstName,
      lastName,
      email,
      phone: phoneRaw,
      password,
      confirmPassword,
      birthDate,
      sex,
      homeLocationId,
      ownerTrainerId,
    },
    now,
  );
  if (validation) {
    if (typeof validation === "object") {
      return {
        error:
          "password" in validation
            ? PASSWORD_ERROR_MESSAGE[validation.password]
            : PHONE_ERROR_MESSAGE[validation.phone],
      };
    }
    return { error: ERROR_MESSAGE[validation] };
  }

  // Numer zapisujemy w jednej postaci (+48...), tej samej co wszędzie indziej -
  // inaczej ten sam człowiek miałby w bazie dwa różne zapisy swojego numeru.
  const numer = parsePhone(phoneRaw);
  const phone = "phone" in numer ? numer.phone : null;

  // Trener i lokalizacja z formularza muszą być prawdziwe i aktywne - inaczej
  // ktoś podrobiłby ownerTrainerId i osierocił kartotekę u nieistniejącego
  // opiekuna. Sprawdzamy po stronie serwera, nie ufając <select>.
  const [trainer, location] = await Promise.all([
    prisma.trainer.findFirst({ where: { id: ownerTrainerId, active: true } }),
    prisma.location.findUnique({ where: { id: homeLocationId } }),
  ]);
  if (!trainer || !location) {
    return { error: "Wybierz lokalizację i trenera z listy." };
  }

  const existing = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (existing) {
    return {
      error: "Konto z tym adresem już istnieje. Spróbuj się zalogować albo zresetuj hasło.",
    };
  }

  // Konto dla niepelnoletniego zaklada rodzic ze swojego konta - patrz
  // selfRegistrationAllowed w lib/domain/registration.ts. Sprawdzamy PO
  // walidacji formularza, zeby czlowiek nie dostal tego komunikatu przy okazji
  // literowki w hasle, i PRZED zalozeniem czegokolwiek w bazie.
  if (!selfRegistrationAllowed(birthDate, now)) {
    return { error: MINOR_SELF_REGISTER_MESSAGE };
  }

  const passwordHash = await hashPassword(password);
  const isMinor = calculateAge(birthDate, now) < 18;
  // Nieletni rejestrujący się sam trafia do zatwierdzenia przez klub; dorosły
  // wchodzi od razu jako APPROVED. Ta sama reguła co isMinor (próg 18), ale
  // wyrażona przez requiresApproval, bo to ona jest bramą rezerwacji.
  const pendingApproval = requiresApproval(birthDate, now);

  const createdUserId = await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        email,
        name: `${firstName} ${lastName}`,
        role: "MEMBER",
        phone,
        passwordHash,
      },
    });
    const member = await tx.member.create({
      data: {
        userId: user.id,
        firstName,
        lastName,
        email,
        birthDate,
        isMinor,
        approvalStatus: pendingApproval ? "PENDING" : "APPROVED",
        sex: sex as Sex,
        homeLocationId,
        ownerTrainerId,
        joinedAt: null,
      },
    });
    await logActivity(tx, {
      actorUserId: user.id,
      action: "MEMBER_CREATED",
      memberId: member.id,
      summary: `Samodzielna rejestracja: ${firstName} ${lastName} (opiekun: ${trainer.id})${
        pendingApproval ? " - NIELETNI, oczekuje na zatwierdzenie" : ""
      }`,
    });
    return user.id;
  });

  // Weryfikacja adresu: link idzie mailem, gdy poczta działa; bez SMTP konto
  // jest od razu zweryfikowane, żeby brak poczty nie blokował rejestracji.
  // Poza transakcją - nieudany mail nie może cofnąć założenia konta.
  await startEmailVerification({
    userId: createdUserId,
    email,
    name: `${firstName} ${lastName}`,
    baseUrl: await baseUrl(),
  });

  try {
    await signIn("credentials", { email, password, redirect: false });
  } catch (err) {
    if (err instanceof AuthError) {
      // Konto powstało, ale auto-logowanie się nie powiodło - klient po prostu
      // zaloguje się ręcznie. Nie blokujemy, kierujemy na logowanie.
      redirect("/login?zarejestrowano=1");
    }
    throw err;
  }

  redirect("/app");
}
