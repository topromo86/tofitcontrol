"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireRole } from "@/lib/auth/guard";
import { calculateAge } from "@/lib/domain/booking";
import { isValidEmail, normalizeEmail } from "@/lib/domain/registration";
import { logActivity } from "@/lib/services/activity";
import { provisionLoginAccount } from "@/lib/services/account";
import { confirmConsentDelivery } from "@/lib/services/consent-delivery";
import { linkGuardian, unlinkGuardian } from "@/lib/services/guardian";
import { Prisma } from "@/app/generated/prisma/client";
import type { MemberLevel, MemberStatus, Sex } from "@/app/generated/prisma/client";

const PROVISION_ERROR: Record<string, string> = {
  MEMBER_NOT_FOUND: "Nie znaleziono klienta.",
  ALREADY_HAS_ACCOUNT: "Ten klient ma już konto logowania.",
  EMAIL_TAKEN: "Konto z tym adresem już istnieje.",
  INVALID_EMAIL: "Podaj poprawny adres e-mail.",
};

// Zakłada konto logowania dla istniejącej kartoteki: generuje hasło, wysyła je
// mailem i pokazuje adminowi na ekranie (na wypadek, gdyby mail nie doszedł).
//
// Hasło przekazujemy przez ciasteczko, a NIE przez parametr w URL - inaczej
// wylądowałoby w historii przeglądarki i logach dostępu serwera.
export async function provisionLoginAccountAction(formData: FormData) {
  const session = await requireRole("ADMIN");
  const memberId = String(formData.get("memberId"));
  const email = normalizeEmail(String(formData.get("email") ?? ""));
  const back = `/admin/klienci/${memberId}`;

  if (!isValidEmail(email)) {
    redirect(`${back}?konto-blad=${encodeURIComponent(PROVISION_ERROR.INVALID_EMAIL)}`);
  }

  const result = await provisionLoginAccount({ memberId, email });
  if (!result.ok) {
    redirect(`${back}?konto-blad=${encodeURIComponent(PROVISION_ERROR[result.error])}`);
  }

  await logActivity(prisma, {
    actorUserId: session.user.id,
    action: "MEMBER_UPDATED",
    memberId,
    summary: `Założono konto logowania (${email})${result.emailed ? " - wysłano dane mailem" : " - mail nieaktywny, hasło przekazane ręcznie"}`,
  });

  const jar = await cookies();
  // Krótkie życie: hasło jest jednorazowe do przekazania, nie do trzymania.
  jar.set(
    "provisioned-account",
    JSON.stringify({ email, password: result.password, emailed: result.emailed }),
    {
      httpOnly: true,
      maxAge: 60,
      path: back,
    },
  );

  revalidatePath(back);
  redirect(`${back}?konto=utworzone`);
}

const LEVELS: readonly MemberLevel[] = ["WHITE", "YELLOW", "ORANGE", "GREEN"];
const STATUSES: readonly MemberStatus[] = ["ACTIVE", "FROZEN", "CHURNED"];

// Korekta danych klienta przez admina (literówki, zmiana trenera-opiekuna,
// przeniesienie lokalizacji domowej itp.) - osobno od zamrożenia karnetu
// (Pass.status), które ma własną akcję. Zmiana MemberStatus na CHURNED/z
// powrotem pilnuje churnedAt, tak jak zrobiłby to job (SPEC.md sekcja 1).
export async function updateMemberAction(formData: FormData) {
  const session = await requireRole("ADMIN");
  const memberId = String(formData.get("memberId"));

  const firstName = String(formData.get("firstName") ?? "").trim();
  const lastName = String(formData.get("lastName") ?? "").trim();
  const emailRaw = String(formData.get("email") ?? "").trim();
  const birthDateStr = String(formData.get("birthDate") ?? "");
  const sex = String(formData.get("sex") ?? "");
  const weightKgRaw = formData.get("weightKg");
  const goal = String(formData.get("goal") ?? "").trim();
  const level = String(formData.get("level") ?? "");
  const status = String(formData.get("status") ?? "");
  const homeLocationId = String(formData.get("homeLocationId") ?? "");
  const ownerTrainerId = String(formData.get("ownerTrainerId") ?? "");

  if (!firstName || !lastName || !birthDateStr || !homeLocationId || !ownerTrainerId) {
    throw new Error("Uzupełnij wszystkie wymagane pola.");
  }
  if (sex !== "MALE" && sex !== "FEMALE") {
    throw new Error("Nieprawidłowa płeć.");
  }
  if (!LEVELS.includes(level as MemberLevel)) {
    throw new Error("Nieprawidłowy poziom.");
  }
  if (!STATUSES.includes(status as MemberStatus)) {
    throw new Error("Nieprawidłowy status.");
  }

  const memberEmail = normalizeEmail(emailRaw);
  if (!memberEmail || !isValidEmail(memberEmail)) {
    throw new Error("Podaj poprawny adres e-mail.");
  }

  const birthDate = new Date(birthDateStr);
  const now = new Date();
  if (Number.isNaN(birthDate.getTime()) || birthDate > now) {
    throw new Error("Nieprawidłowa data urodzenia.");
  }
  const isMinor = calculateAge(birthDate, now) < 18;
  const weightKg = weightKgRaw && String(weightKgRaw).length > 0 ? Number(weightKgRaw) : null;

  const before = await prisma.member.findUniqueOrThrow({ where: { id: memberId } });

  await prisma.$transaction(async (tx) => {
    await tx.member.update({
      where: { id: memberId },
      data: {
        firstName,
        lastName,
        email: memberEmail,
        birthDate,
        isMinor,
        sex: sex as Sex,
        weightKg,
        goal: goal || null,
        level: level as MemberLevel,
        status: status as MemberStatus,
        homeLocationId,
        ownerTrainerId,
        churnedAt:
          status === "CHURNED"
            ? (before.churnedAt ?? now)
            : before.status === "CHURNED"
              ? null
              : before.churnedAt,
      },
    });

    await logActivity(tx, {
      actorUserId: session.user.id,
      action: "MEMBER_UPDATED",
      memberId,
      summary: `Zaktualizowano dane klienta ${firstName} ${lastName}`,
    });
  });

  redirect(`/admin/klienci/${memberId}`);
}

// Ręczne oznaczenie nagrody za polecenie jako przyznanej (rabat/prezent
// wydany poza systemem - brak automatycznego mechanizmu kuponów na Payment).
export async function markReferralRewardedAction(formData: FormData) {
  await requireRole("ADMIN");
  const referralId = String(formData.get("referralId"));
  const memberId = String(formData.get("memberId"));

  const referral = await prisma.referral.findUniqueOrThrow({ where: { id: referralId } });
  if (referral.status !== "CONVERTED") {
    throw new Error("Nagrodę można przyznać tylko po zrealizowanym poleceniu.");
  }

  await prisma.referral.update({
    where: { id: referralId },
    data: { status: "REWARDED", rewardedAt: new Date() },
  });

  revalidatePath(`/admin/klienci/${memberId}`);
}

// RODO - prawo do bycia zapomnianym. Czyści dane IDENTYFIKUJĄCE (imię,
// nazwisko, kontakt, cel, waga), ale NIE usuwa rekordów finansowych
// (Payment/Pass) ani obecności - te są już niezależne od danych osobowych
// (referencja przez memberId, nie przez nazwisko) i klub ma prawny obowiązek
// je zachować do celów księgowych. ❗️ Nie czyści historycznych wpisów w
// ActivityLog ani treści Note - te opisują działania klubu, nie samego
// klienta, i mogą wciąż zawierać stare imię w treści (patrz PLAN.md Faza 6).
export async function anonymizeMemberAction(formData: FormData) {
  const session = await requireRole("ADMIN");
  const memberId = String(formData.get("memberId"));
  const confirmed = formData.get("confirmed");
  if (confirmed !== "on") {
    throw new Error("Potwierdź żądanie usunięcia danych.");
  }

  const member = await prisma.member.findUniqueOrThrow({ where: { id: memberId } });

  await prisma.$transaction(async (tx) => {
    await tx.member.update({
      where: { id: memberId },
      data: {
        firstName: "Klient",
        lastName: "Usunięty",
        goal: null,
        weightKg: null,
        sex: null,
      },
    });

    if (member.userId) {
      await tx.user.update({
        where: { id: member.userId },
        data: {
          name: "Klient usunięty",
          email: `usuniety-${memberId}@anonimizowany.local`,
          phone: null,
          passwordHash: null,
          pushSubscription: Prisma.DbNull,
        },
      });
    }

    await tx.consent.updateMany({
      where: { memberId, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    await logActivity(tx, {
      actorUserId: session.user.id,
      action: "MEMBER_UPDATED",
      memberId,
      summary: "Zanonimizowano dane osobowe klienta na żądanie RODO",
    });
  });

  redirect(`/admin/klienci/${memberId}`);
}

// Potwierdzenie odbioru podpisanych zgód przez admina (np. dostarczone do
// recepcji). Zdejmuje bramę "tylko pierwsze zajęcia".
export async function confirmConsentDeliveryAction(formData: FormData) {
  const session = await requireRole("ADMIN");
  const memberId = String(formData.get("memberId"));
  await confirmConsentDelivery({ memberId, byUserId: session.user.id });
  revalidatePath(`/admin/klienci/${memberId}`);
}

// Przypisanie rodzica do kartoteki dziecka - po adresie e-mail jego KONTA
// logowania, bo to konto, a nie kartoteka, jest opiekunem (rodzic nie musi sam
// trenować).
//
// Cała reguła siedzi w lib/services/guardian.ts, żeby obie drogi - ta i
// "przepisz konto niepełnoletniego" z karty rodzica - nie miały jak się
// rozjechać.
export async function linkGuardianByEmailAction(formData: FormData) {
  const session = await requireRole("ADMIN");
  const memberId = String(formData.get("memberId"));
  const email = normalizeEmail(String(formData.get("guardianEmail") ?? ""));

  const wroc = (params: string) => redirect(`/admin/klienci/${memberId}?${params}`);
  if (!isValidEmail(email))
    wroc(`blad=${encodeURIComponent("Podaj poprawny adres e-mail konta rodzica.")}`);

  const konto = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (!konto) {
    wroc(
      `blad=${encodeURIComponent(
        "Nie ma konta o tym adresie. Rodzic musi najpierw założyć własne konto w aplikacji.",
      )}`,
    );
  }

  const wynik = await linkGuardian({
    memberId,
    guardianUserId: konto!.id,
    actorUserId: session.user.id,
  });
  if (!wynik.ok) wroc(`blad=${encodeURIComponent(wynik.message)}`);

  revalidatePath(`/admin/klienci/${memberId}`);
  wroc(`info=${encodeURIComponent(`Przypisano opiekuna: ${wynik.ok ? wynik.guardianName : ""}.`)}`);
}

// "Przepisz konto niepełnoletniego" - z karty RODZICA. Ta sama operacja
// z drugiej strony: admin siedzi w koncie rodzica i wskazuje dziecko.
export async function attachMinorAction(formData: FormData) {
  const session = await requireRole("ADMIN");
  const parentMemberId = String(formData.get("parentMemberId"));
  const childMemberId = String(formData.get("childMemberId"));

  const wroc = (params: string) => redirect(`/admin/klienci/${parentMemberId}?${params}`);

  const rodzic = await prisma.member.findUnique({
    where: { id: parentMemberId },
    select: { userId: true },
  });
  if (!rodzic?.userId) {
    wroc(
      `blad=${encodeURIComponent(
        "Ten klubowicz nie ma konta logowania, więc nie może być opiekunem. Załóż mu najpierw konto.",
      )}`,
    );
  }

  const wynik = await linkGuardian({
    memberId: childMemberId,
    guardianUserId: rodzic!.userId!,
    actorUserId: session.user.id,
  });
  if (!wynik.ok) wroc(`blad=${encodeURIComponent(wynik.message)}`);

  revalidatePath(`/admin/klienci/${parentMemberId}`);
  wroc(`info=${encodeURIComponent(`Przepisano konto: ${wynik.ok ? wynik.childName : ""}.`)}`);
}

// Odpięcie opiekuna. Zmiana rodzica idzie przez odpięcie i przypisanie od nowa -
// dwa swiadome kroki, dwa wpisy w historii.
export async function unlinkGuardianAction(formData: FormData) {
  const session = await requireRole("ADMIN");
  const memberId = String(formData.get("memberId"));
  const reason = String(formData.get("reason") ?? "");

  const wynik = await unlinkGuardian({ memberId, actorUserId: session.user.id, reason });

  revalidatePath(`/admin/klienci/${memberId}`);
  redirect(
    `/admin/klienci/${memberId}?${
      wynik.ok
        ? `info=${encodeURIComponent("Opiekun odpięty. Kartoteka czeka na przypisanie nowego.")}`
        : `blad=${encodeURIComponent(wynik.message)}`
    }`,
  );
}
