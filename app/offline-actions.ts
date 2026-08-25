"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import {
  requireMemberAccess,
  requireOwnsSession,
  requireRole,
  requireSession,
} from "@/lib/auth/guard";
import {
  RECORDED_AT_MESSAGE,
  resolveRecordedAt,
  type FlushOutcome,
  type OfflineEntry,
} from "@/lib/domain/offline-queue";
import { SCAN_REJECTION_MESSAGE } from "@/lib/domain/class-qr";
import { checkInAtStation } from "@/lib/services/class-qr";
import { recordFloorCheckInByToken } from "@/lib/services/floor-checkin";
import {
  confirmSessionAttendance,
  markManualAttendance,
  selfCheckIn,
} from "@/lib/services/attendance";

// Dopisanie do bazy zapisów zrobionych bez łącza.
//
// Odpala się WYŁĄCZNIE z kliknięcia człowieka w pasku "Połączenie wróciło" -
// nigdy sama z siebie. Powód jest ten sam co w toPROductive: dwie osoby mogły
// offline ruszyć to samo, a cichy zapis skasowałby cudzą zmianę bez śladu.
// Tutaj dochodzi drugi: odbicia dopisywane wstecz to godziny obecności, więc
// ktoś ma je zobaczyć, zanim wejdą do rozliczeń.
//
// Każda pozycja przechodzi PONOWNIE przez strażnika i przez tę samą regułę co
// przy zapisie na żywo. Kolejka leży w localStorage tabletu, więc jest tak
// samo niezaufana jak każde inne dane z przeglądarki - w szczególności data
// zdarzenia, którą prostuje resolveRecordedAt.

// Górna granica jednej wysyłki. Realna kolejka po zerwanym treningu to
// kilkanaście pozycji; tysiąc oznacza pomyłkę albo zabawę, a nie klub.
const MAX_POZYCJI = 200;

const CZAS_ODMOWY: Record<string, string> = {
  UNKNOWN_TOKEN: "Nieznany kod wejścia - konto mogło zostać w międzyczasie zmienione.",
  CODE_EXPIRED: "Kod był już nieważny w chwili skanowania.",
  CODE_INVALID: "To nie jest kod wejścia z tej aplikacji.",
  NO_OPEN_CLASS: "O tej godzinie w tej sali nie było zajęć z aktywnym kodem.",
};

function opis(blad: unknown): string {
  return blad instanceof Error ? blad.message : "Nie udało się dopisać tego zapisu.";
}

async function dopisz(entry: OfflineEntry, at: Date): Promise<void> {
  switch (entry.op) {
    case "WEJSCIE_NA_SALE": {
      const session = await requireRole("ADMIN", "TRAINER");
      const wynik = await recordFloorCheckInByToken({
        token: String(entry.payload.token ?? ""),
        locationId: String(entry.payload.locationId ?? ""),
        recordedByUserId: session.user.id,
        now: at,
      });
      if (!wynik.ok) throw new Error(CZAS_ODMOWY.UNKNOWN_TOKEN);
      return;
    }

    case "ODBICIE_NA_ZAJECIACH": {
      await requireRole("ADMIN", "TRAINER", "KIOSK");
      const wynik = await checkInAtStation({
        code: String(entry.payload.code ?? ""),
        locationId: String(entry.payload.locationId ?? ""),
        now: at,
      });
      if (!wynik.ok) {
        throw new Error(
          CZAS_ODMOWY[wynik.reason] ??
            SCAN_REJECTION_MESSAGE[wynik.reason as keyof typeof SCAN_REJECTION_MESSAGE] ??
            "Nie udało się odbić.",
        );
      }
      return;
    }

    case "OBECNOSC_RECZNA": {
      const bookingId = String(entry.payload.bookingId ?? "");
      const booking = await prisma.booking.findUnique({
        where: { id: bookingId },
        select: { sessionId: true },
      });
      if (!booking) throw new Error("Rezerwacja zniknęła - nie ma czego odhaczyć.");
      const session = await requireOwnsSession(booking.sessionId);
      await markManualAttendance({ bookingId, byUserId: session.user.id, at });
      return;
    }

    case "POTWIERDZENIE_OBECNOSCI": {
      const sessionId = String(entry.payload.sessionId ?? "");
      const session = await requireOwnsSession(sessionId);
      const wynik = await confirmSessionAttendance({
        sessionId,
        byUserId: session.user.id,
        rawCount: String(entry.payload.count ?? ""),
        at,
      });
      if (!wynik.ok) throw new Error("Liczba obecnych była poza zakresem.");
      return;
    }

    case "MELDUNEK_KLUBOWICZA": {
      const bookingId = String(entry.payload.bookingId ?? "");
      const booking = await prisma.booking.findUnique({
        where: { id: bookingId },
        select: { memberId: true },
      });
      if (!booking) throw new Error("Rezerwacja zniknęła - nie ma czego zameldować.");
      await requireMemberAccess(booking.memberId);
      const wynik = await selfCheckIn({ bookingId, at });
      if (!wynik.ok) {
        throw new Error("Meldunek był poza oknem czasowym zajęć (-30/+20 min).");
      }
      return;
    }
  }
}

export async function flushOfflineQueueAction(entries: OfflineEntry[]): Promise<FlushOutcome[]> {
  // Sama sesja wystarczy do wejścia; o tym, czy wolno DANY zapis, decyduje
  // strażnik przy każdej pozycji osobno.
  await requireSession();

  const doWyslania = Array.isArray(entries) ? entries.slice(0, MAX_POZYCJI) : [];
  const now = new Date();
  const wyniki: FlushOutcome[] = [];

  // Po kolei, nie równolegle: te zapisy schodzą z karnetów i ruszają te same
  // rezerwacje, a klub woli przewidywalną kolejność niż kilkaset milisekund.
  for (const entry of doWyslania) {
    const czas = resolveRecordedAt(entry.recordedAtIso, now);
    if (!czas.ok) {
      wyniki.push({ id: entry.id, ok: false, error: RECORDED_AT_MESSAGE[czas.reason] });
      continue;
    }
    try {
      await dopisz(entry, czas.at);
      wyniki.push({ id: entry.id, ok: true });
    } catch (blad) {
      wyniki.push({ id: entry.id, ok: false, error: opis(blad) });
    }
  }

  // Ekrany, na których te zapisy widać. Odświeżamy raz na całą wysyłkę.
  revalidatePath("/trainer");
  revalidatePath("/skaner");
  revalidatePath("/kod-zajec");

  return wyniki;
}
