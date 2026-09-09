"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireOwnsSession, requireSession } from "@/lib/auth/guard";
import {
  RECORDED_AT_MESSAGE,
  resolveRecordedAt,
  type FlushOutcome,
  type OfflineEntry,
} from "@/lib/domain/offline-queue";
import { confirmSessionAttendance, markManualAttendance } from "@/lib/services/attendance";

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

function opis(blad: unknown): string {
  return blad instanceof Error ? blad.message : "Nie udało się dopisać tego zapisu.";
}

async function dopisz(entry: OfflineEntry, at: Date): Promise<void> {
  switch (entry.op) {
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
  revalidatePath("/kod-zajec");

  return wyniki;
}
