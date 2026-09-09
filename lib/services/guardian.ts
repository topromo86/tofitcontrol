import "server-only";

import { prisma } from "@/lib/prisma";
import { logActivity } from "@/lib/services/activity";
import { calculateAge } from "@/lib/domain/booking";

// Powiązanie dziecka z kontem rodzica - JEDYNE miejsce, które zapisuje
// `Member.guardianUserId`.
//
// Do tej pory zapisywało je zatwierdzenie prośby rodzica
// (`app/admin/zatwierdzenia/actions.ts`) i nic poza tym. Nie było też żadnej
// drogi ZMIANY ani ZDJĘCIA opiekuna, więc pomyłka przy powiązaniu była trwała
// i naprawialna wyłącznie ręcznym UPDATE na bazie klubu.
//
// Trzy rzeczy, których tamta droga nie sprawdzała, a które muszą być pewne,
// bo chodzi o dostęp do danych dziecka:
//
//   1. kartoteka należy do NIEPEŁNOLETNIEGO - bez tego jedno kliknięcie oddaje
//      obcej osobie pełny wgląd w kartotekę dorosłej klubowiczki,
//   2. kartoteka nie ma jeszcze opiekuna - podmiana idzie osobną drogą
//      (`unlinkGuardian`), świadomie i ze śladem,
//   3. opiekun to nie to samo konto, co konto dziecka - inaczej nastolatek
//      z własnym loginem stawał się swoim własnym opiekunem i podpisywał sobie
//      zgodę opiekuna prawnego.

export type GuardianError =
  | "NIE_MA_KARTOTEKI"
  | "PELNOLETNI"
  | "MA_JUZ_OPIEKUNA"
  | "NIE_MA_KONTA"
  | "TO_SAMO_KONTO"
  | "OPIEKUN_NIEPELNOLETNI"
  | "BEZ_OPIEKUNA";

export const GUARDIAN_MESSAGE: Record<GuardianError, string> = {
  NIE_MA_KARTOTEKI: "Nie znaleziono takiej kartoteki.",
  PELNOLETNI:
    "Ta kartoteka należy do osoby pełnoletniej - opiekuna przypisuje się wyłącznie niepełnoletnim.",
  MA_JUZ_OPIEKUNA:
    "Ta kartoteka ma już przypisanego opiekuna. Najpierw go odepnij, potem przypisz nowego.",
  NIE_MA_KONTA: "Nie znaleziono konta o tym adresie e-mail.",
  TO_SAMO_KONTO: "To jest konto logowania tego samego klubowicza - nie może być swoim opiekunem.",
  OPIEKUN_NIEPELNOLETNI: "Opiekunem może być wyłącznie osoba pełnoletnia.",
  BEZ_OPIEKUNA: "Ta kartoteka nie ma przypisanego opiekuna - nie ma czego odpinać.",
};

export type GuardianResult =
  | { ok: false; reason: GuardianError; message: string }
  | { ok: true; childName: string; guardianName: string };

function odmowa(reason: GuardianError): GuardianResult {
  return { ok: false, reason, message: GUARDIAN_MESSAGE[reason] };
}

export async function linkGuardian(input: {
  memberId: string;
  guardianUserId: string;
  actorUserId: string;
  now?: Date;
}): Promise<GuardianResult> {
  const now = input.now ?? new Date();

  const [member, guardian] = await Promise.all([
    prisma.member.findUnique({
      where: { id: input.memberId },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        birthDate: true,
        userId: true,
        guardianUserId: true,
      },
    }),
    prisma.user.findUnique({
      where: { id: input.guardianUserId },
      select: { id: true, name: true, email: true, memberAccount: { select: { birthDate: true } } },
    }),
  ]);

  if (!member) return odmowa("NIE_MA_KARTOTEKI");
  if (!guardian) return odmowa("NIE_MA_KONTA");
  if (calculateAge(member.birthDate, now) >= 18) return odmowa("PELNOLETNI");
  if (member.guardianUserId) return odmowa("MA_JUZ_OPIEKUNA");
  if (member.userId && member.userId === guardian.id) return odmowa("TO_SAMO_KONTO");
  // Gdy opiekun ma własną kartotekę, znamy jego wiek i możemy go sprawdzić.
  // Gdy nie ma - konto założone wyłącznie po to, żeby prowadzić dziecko - wieku
  // nie znamy i nie zgadujemy: klub widzi to konto i bierze za nie
  // odpowiedzialność, przypisując je ręcznie.
  if (guardian.memberAccount && calculateAge(guardian.memberAccount.birthDate, now) < 18) {
    return odmowa("OPIEKUN_NIEPELNOLETNI");
  }

  await prisma.$transaction(async (tx) => {
    await tx.member.update({
      where: { id: member.id },
      data: { guardianUserId: guardian.id },
    });

    // Zgoda opiekuna prawnego podpisana przez SAMO DZIECKO traci ważność:
    // podpisał ją ktoś, kto nie mógł. Rodzic zobaczy ją na swoim koncie jako
    // do udzielenia. Zostawiamy ślad przez `revokedAt`, nie kasujemy wiersza.
    await tx.consent.updateMany({
      where: {
        memberId: member.id,
        revokedAt: null,
        consentType: { forMinorsOnly: true },
        grantedByUserId: { not: guardian.id },
      },
      data: { revokedAt: now },
    });

    // Otwarte prośby o powiązanie tej kartoteki są już bezprzedmiotowe.
    await tx.guardianLinkRequest.updateMany({
      where: { memberId: member.id, status: "PENDING" },
      data: { status: "APPROVED", resolvedAt: now, resolvedByUserId: input.actorUserId },
    });

    await logActivity(tx, {
      actorUserId: input.actorUserId,
      action: "GUARDIAN_LINKED",
      memberId: member.id,
      summary:
        `Przypisano opiekuna: ${guardian.name} (${guardian.email}) ` +
        `do kartoteki ${member.firstName} ${member.lastName}`,
    });
  });

  return {
    ok: true,
    childName: `${member.firstName} ${member.lastName}`,
    guardianName: guardian.name,
  };
}

// Odpięcie opiekuna. Istnieje po to, żeby powiązanie dało się cofnąć - bez tego
// każda pomyłka przy przypisaniu jest trwała, a przypisanie to dostęp do danych
// dziecka. Zmiana opiekuna = odepnij, potem przypisz nowego; dwa świadome
// kroki, dwa wpisy w historii.
export async function unlinkGuardian(input: {
  memberId: string;
  actorUserId: string;
  reason: string;
}): Promise<GuardianResult> {
  const member = await prisma.member.findUnique({
    where: { id: input.memberId },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      guardianUser: { select: { id: true, name: true, email: true } },
    },
  });
  if (!member) return odmowa("NIE_MA_KARTOTEKI");
  if (!member.guardianUser) return odmowa("BEZ_OPIEKUNA");

  await prisma.$transaction(async (tx) => {
    await tx.member.update({ where: { id: member.id }, data: { guardianUserId: null } });
    await logActivity(tx, {
      actorUserId: input.actorUserId,
      action: "GUARDIAN_UNLINKED",
      memberId: member.id,
      summary:
        `Odpięto opiekuna: ${member.guardianUser!.name} (${member.guardianUser!.email}) ` +
        `od kartoteki ${member.firstName} ${member.lastName}` +
        (input.reason.trim() ? ` - ${input.reason.trim()}` : ""),
    });
  });

  return {
    ok: true,
    childName: `${member.firstName} ${member.lastName}`,
    guardianName: member.guardianUser.name,
  };
}
