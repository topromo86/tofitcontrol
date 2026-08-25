import "server-only";

import { prisma } from "@/lib/prisma";
import { isWithinCheckInWindow } from "@/lib/domain/booking";
import { logActivity } from "@/lib/services/activity";
import { markJoinedIfNeeded } from "@/lib/services/member";
import { notifyGuardianCheckIn } from "@/lib/services/notify";
import { decrementPassEntryIfLimited } from "@/lib/services/pass";

// Zapis obecności - jedno miejsce dla obu dróg: kliknięcia na żywo i zapisu
// dopisanego z kolejki offline po powrocie sieci.
//
// Każda z tych funkcji przyjmuje `at` - moment, w którym rzecz wydarzyła się
// NA SALI. Online to po prostu "teraz"; po powrocie łącza to godzina odbicia
// sprzed dwóch godzin. Bez tego obecność z 18:05 lądowałaby w bazie o 21:30
// i rozjeżdżała statystyki, okna zapisu i karnety.
//
// Autoryzacja nie należy tutaj - robią ją strażnicy w warstwie akcji
// (lib/auth/guard.ts). Ta warstwa zakłada, że wolno.

export async function markManualAttendance(input: {
  bookingId: string;
  byUserId: string;
  at: Date;
}): Promise<void> {
  const booking = await prisma.booking.findUniqueOrThrow({
    where: { id: input.bookingId },
    // Rodzaj zajęć decyduje, z którego karnetu zejdzie wejście.
    include: { session: { select: { kind: true } } },
  });

  await prisma.$transaction(async (tx) => {
    await tx.attendance.upsert({
      where: { sessionId_memberId: { sessionId: booking.sessionId, memberId: booking.memberId } },
      create: {
        sessionId: booking.sessionId,
        memberId: booking.memberId,
        checkedInAt: input.at,
        method: "MANUAL",
        recordedByUserId: input.byUserId,
      },
      update: {},
    });
    await tx.booking.update({ where: { id: input.bookingId }, data: { status: "ATTENDED" } });
    await decrementPassEntryIfLimited(tx, booking.memberId, booking.session.kind);
    await markJoinedIfNeeded(tx, booking.memberId, input.at);
  });
}

export type ConfirmAttendanceResult =
  { ok: false; reason: "BAD_COUNT" } | { ok: true; counted: number; scanned: number };

export async function confirmSessionAttendance(input: {
  sessionId: string;
  byUserId: string;
  // Pusto = tyle, ile odbić jest w bazie. Trener najczęściej zatwierdza to,
  // co widzi, i nie chce nic wpisywać.
  rawCount: string;
  at: Date;
}): Promise<ConfirmAttendanceResult> {
  const klasa = await prisma.session.findUniqueOrThrow({
    where: { id: input.sessionId },
    include: { attendances: { select: { id: true } } },
  });

  const scanned = klasa.attendances.length;
  const trimmed = input.rawCount.trim();
  const counted = trimmed ? Number(trimmed) : scanned;
  if (!Number.isInteger(counted) || counted < 0 || counted > 500)
    return { ok: false, reason: "BAD_COUNT" };

  await prisma.$transaction(async (tx) => {
    await tx.session.update({
      where: { id: input.sessionId },
      data: { attendanceConfirmedAt: input.at, attendanceConfirmedCount: counted },
    });
    await logActivity(tx, {
      actorUserId: input.byUserId,
      action: "SESSION_UPDATED",
      summary:
        counted === scanned
          ? `Potwierdzono obecność na "${klasa.name}": ${counted} os.`
          : `Potwierdzono obecność na "${klasa.name}": ${counted} os. (odbić: ${scanned})`,
    });
  });

  return { ok: true, counted, scanned };
}

export type SelfCheckInResult =
  { ok: false; reason: "WINDOW"; locationId: string } | { ok: true; locationId: string };

// Meldunek klubowicza z kodu na ścianie. Okno czasowe liczymy względem `at`,
// więc zapis zrobiony bez sieci o 17:58 przechodzi także wtedy, gdy trafia do
// bazy po zajęciach - i nadal odpada, jeśli ktoś kliknął go dzień wcześniej.
export async function selfCheckIn(input: {
  bookingId: string;
  at: Date;
}): Promise<SelfCheckInResult> {
  const booking = await prisma.booking.findUniqueOrThrow({
    where: { id: input.bookingId },
    include: { session: true, member: { include: { guardianUser: true } } },
  });
  const locationId = booking.session.locationId;

  if (booking.status !== "BOOKED" || !isWithinCheckInWindow(booking.session.startsAt, input.at)) {
    return { ok: false, reason: "WINDOW", locationId };
  }

  await prisma.$transaction(async (tx) => {
    await tx.attendance.upsert({
      where: { sessionId_memberId: { sessionId: booking.sessionId, memberId: booking.memberId } },
      create: {
        sessionId: booking.sessionId,
        memberId: booking.memberId,
        checkedInAt: input.at,
        method: "QR",
      },
      update: {},
    });
    await tx.booking.update({ where: { id: input.bookingId }, data: { status: "ATTENDED" } });
    await decrementPassEntryIfLimited(tx, booking.memberId, booking.session.kind);
    await markJoinedIfNeeded(tx, booking.memberId, input.at);
  });

  // "Dziecko weszło na salę" (SPEC.md sekcja 3) - tylko przy realnym check-inie
  // QR, nigdy przy ręcznym uzupełnieniu przez trenera. Best-effort: awaria
  // powiadomienia nigdy nie blokuje samego check-inu.
  if (booking.member.isMinor && booking.member.guardianUser) {
    try {
      await notifyGuardianCheckIn(
        booking.member.guardianUser.id,
        `${booking.member.firstName} ${booking.member.lastName}`,
        booking.sessionId,
      );
    } catch {
      // celowo połknięte - patrz komentarz wyżej
    }
  }

  return { ok: true, locationId };
}
