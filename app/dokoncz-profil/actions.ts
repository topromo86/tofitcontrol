"use server";

import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireRole } from "@/lib/auth/guard";
import { calculateAge } from "@/lib/domain/booking";
import {
  MINOR_SELF_REGISTER_MESSAGE,
  requiresApproval,
  selfRegistrationAllowed,
  validateProfile,
  type ProfileError,
} from "@/lib/domain/registration";
import { PHONE_ERROR_MESSAGE, parsePhone } from "@/lib/domain/phone";
import { logActivity } from "@/lib/services/activity";
import type { Sex } from "@/app/generated/prisma/client";

export type ProfileState = { error?: string };

const ERROR_MESSAGE: Record<Exclude<ProfileError, { phone: unknown }>, string> = {
  MISSING_FIELDS: "Uzupełnij wszystkie pola.",
  INVALID_BIRTHDATE: "Podaj poprawną datę urodzenia.",
};

export async function completeProfileAction(
  _prev: ProfileState,
  formData: FormData,
): Promise<ProfileState> {
  const session = await requireRole("MEMBER");

  // Konto mogło już mieć kartotekę (np. dwa razy otwarte okno) - wtedy nic nie
  // dublujemy, tylko kierujemy dalej.
  const existing = await prisma.member.findUnique({
    where: { userId: session.user.id },
    select: { id: true },
  });
  if (existing) redirect("/app");

  const firstName = String(formData.get("firstName") ?? "").trim();
  const lastName = String(formData.get("lastName") ?? "").trim();
  const sex = String(formData.get("sex") ?? "");
  const phoneRaw = String(formData.get("phone") ?? "");
  const homeLocationId = String(formData.get("homeLocationId") ?? "");
  const ownerTrainerId = String(formData.get("ownerTrainerId") ?? "");
  const now = new Date();
  const birthDate = new Date(String(formData.get("birthDate") ?? ""));

  const validation = validateProfile(
    { firstName, lastName, phone: phoneRaw, birthDate, sex, homeLocationId, ownerTrainerId },
    now,
  );
  if (validation) {
    return {
      error:
        typeof validation === "object"
          ? PHONE_ERROR_MESSAGE[validation.phone]
          : ERROR_MESSAGE[validation],
    };
  }

  // Numer w jednej postaci - tej samej co przy rejestracji formularzem.
  const numer = parsePhone(phoneRaw);
  const phone = "phone" in numer ? numer.phone : null;

  // Trener i lokalizacja muszą być realne i aktywne - nie ufamy wartości z
  // <select>, tak samo jak przy rejestracji.
  const [trainer, location] = await Promise.all([
    prisma.trainer.findFirst({ where: { id: ownerTrainerId, active: true } }),
    prisma.location.findUnique({ where: { id: homeLocationId } }),
  ]);
  if (!trainer || !location) {
    return { error: "Wybierz lokalizację i trenera z listy." };
  }

  // Ta sama regula co przy formularzu. Tutaj konto logowania JUZ istnieje
  // (zalozylo je Google), wiec nie odmawiamy "zaloz konto" - konto jest.
  // Mowimy, ze to konto staje sie kontem rodzica, a profil dziecka dodaje sie
  // z niego. Inaczej czlowiek zostawalby z kontem, ktorego nie da sie uzyc,
  // i z adresem e-mail zajetym na cudza kartoteke.
  if (!selfRegistrationAllowed(birthDate, now)) {
    return {
      error:
        MINOR_SELF_REGISTER_MESSAGE +
        " To konto zostaje Twoim kontem - uzupelnij tu wlasne dane, a dziecko dodasz osobno.",
    };
  }

  const isMinor = calculateAge(birthDate, now) < 18;
  const pendingApproval = requiresApproval(birthDate, now);

  await prisma.$transaction(async (tx) => {
    // Numer na koncie logowania - Google go nie daje, a klub go potrzebuje.
    await tx.user.update({ where: { id: session.user.id }, data: { phone } });

    const member = await tx.member.create({
      data: {
        userId: session.user.id,
        firstName,
        lastName,
        email: session.user.email ?? null,
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
      actorUserId: session.user.id,
      action: "MEMBER_CREATED",
      memberId: member.id,
      summary: `Dokończenie profilu (konto Google): ${firstName} ${lastName} (opiekun: ${trainer.id})${
        pendingApproval ? " - NIELETNI, oczekuje na zatwierdzenie" : ""
      }`,
    });
  });

  redirect("/app");
}
