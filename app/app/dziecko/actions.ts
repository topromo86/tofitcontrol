"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/auth/guard";
import { calculateAge } from "@/lib/domain/booking";
import { selfRegistrationAllowed, validateChildProfile } from "@/lib/domain/registration";
import { logActivity } from "@/lib/services/activity";

// Założenie profilu dziecka z konta rodzica.
//
// To jest druga połowa reguły "niepełnoletni nie zakłada konta sam": skoro
// odmawiamy dziecku samodzielnej rejestracji, rodzic musi mieć czym je dodać.
// Bez tego blokada byłaby ślepym zaułkiem.
//
// Dziecko NIE dostaje własnego loginu. Kartoteka wisi przy koncie rodzica
// (`guardianUserId`) i to rodzic podpisuje zgody, odbiera powiadomienia
// i zapisuje je na zajęcia. Osobny login dla dziecka klub może założyć później
// z panelu, świadomie.

export type ChildState = { error?: string };

export async function createChildAction(
  _prev: ChildState,
  formData: FormData,
): Promise<ChildState> {
  const session = await requireSession();

  const firstName = String(formData.get("firstName") ?? "").trim();
  const lastName = String(formData.get("lastName") ?? "").trim();
  const birthDateStr = String(formData.get("birthDate") ?? "");
  const sex = String(formData.get("sex") ?? "");
  const homeLocationId = String(formData.get("homeLocationId") ?? "");
  const ownerTrainerId = String(formData.get("ownerTrainerId") ?? "");

  const now = new Date();
  const birthDate = new Date(birthDateStr);

  // Bez telefonu: kontaktem dziecka jest rodzic, a jego numer wisi przy koncie
  // rodzica. Dziecko nie ma wlasnego konta.
  const blad = validateChildProfile(
    { firstName, lastName, birthDate, sex, homeLocationId, ownerTrainerId },
    now,
  );
  if (blad === "MISSING_FIELDS") return { error: "Uzupełnij wszystkie pola." };
  if (blad === "INVALID_BIRTHDATE") return { error: "Podaj poprawną datę urodzenia dziecka." };

  // Ten ekran służy WYŁĄCZNIE do zakładania profili dzieci. Dorosły zakłada
  // sobie konto sam, przez rejestrację - inaczej dałoby się tędy dopisać
  // dorosłą osobę do cudzego konta i czytać jej dane.
  if (selfRegistrationAllowed(birthDate, now)) {
    return {
      error:
        "Ta osoba jest pełnoletnia - konto zakłada sobie sama przez rejestrację. " +
        "Tutaj dodaje się wyłącznie profile dzieci.",
    };
  }

  // Sala i trener z formularza muszą być prawdziwe i aktywne - ta sama
  // ostrożność co przy rejestracji: nie ufamy wartościom z <select>.
  const [trainer, location] = await Promise.all([
    prisma.trainer.findFirst({ where: { id: ownerTrainerId, active: true }, select: { id: true } }),
    prisma.location.findUnique({ where: { id: homeLocationId }, select: { id: true } }),
  ]);
  if (!trainer || !location) return { error: "Wybierz salę i trenera z listy." };

  await prisma.$transaction(async (tx) => {
    const child = await tx.member.create({
      data: {
        firstName,
        lastName,
        birthDate,
        isMinor: true,
        sex: sex as "MALE" | "FEMALE",
        homeLocationId,
        ownerTrainerId,
        // Opiekunem jest KONTO rodzica, nie jego kartoteka - rodzic nie musi
        // sam trenować, żeby prowadzić dziecko.
        guardianUserId: session.user.id,
        // Klub akceptuje dziecko tak samo jak przy samodzielnej rejestracji:
        // musi sprawdzić zgody i miejsce w grupie, zanim cokolwiek zarezerwuje.
        approvalStatus: "PENDING",
        joinedAt: null,
      },
      select: { id: true },
    });

    await logActivity(tx, {
      actorUserId: session.user.id,
      action: "MEMBER_CREATED",
      memberId: child.id,
      summary:
        `Rodzic dodał profil dziecka: ${firstName} ${lastName} ` +
        `(${calculateAge(birthDate, now)} lat) - oczekuje na zatwierdzenie przez klub`,
    });
  });

  revalidatePath("/app/dziecko");
  redirect("/app/dziecko?dodano=1");
}
