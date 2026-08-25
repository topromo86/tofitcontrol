"use server";

import { requireRole } from "@/lib/auth/guard";
import { recordFloorCheckInByToken } from "@/lib/services/floor-checkin";
import { isVisitValid, minutesUntilValid } from "@/lib/domain/floor-checkin";
import { RECORDED_AT_MESSAGE, resolveRecordedAt } from "@/lib/domain/offline-queue";
import { getClubSettings } from "@/lib/services/settings";

const ROLE_LABEL: Record<string, string> = {
  ADMIN: "Właściciel",
  TRAINER: "Trener",
  MEMBER: "Klubowicz",
  GUARDIAN: "Opiekun",
};

export type ScanResult =
  | { ok: false; message: string }
  | {
      ok: true;
      alreadyOnFloor: boolean;
      name: string;
      roleLabel: string;
      enteredAtIso: string;
      valid: boolean;
      minutesLeft: number;
    };

// Wywoływana programowo z komponentu stacji (nie z formularza) - zwraca wynik,
// który stacja pokazuje obsłudze. Stację obsługuje zalogowany personel
// (ADMIN/TRENER) na zaufanym urządzeniu na sali - to jest gwarancja "odbicia
// tylko na miejscu", której nie daje kod na ścianie skanowany z domu.
//
// `scannedAtIso` podaje stacja, gdy odbicie zostało zrobione bez łącza i idzie
// z kolejki: liczy się godzina, o której kod stanął przed kamerą, a nie ta,
// o której wróciło wifi. Data z przeglądarki nie jest zaufana - przepuszcza ją
// resolveRecordedAt (nie z przyszłości, nie starsza niż doba).
export async function scanCheckInAction(
  token: string,
  locationId: string,
  scannedAtIso?: string,
): Promise<ScanResult> {
  const session = await requireRole("ADMIN", "TRAINER");

  const cleaned = token.trim();
  if (!cleaned) return { ok: false, message: "Pusty kod." };
  if (!locationId) return { ok: false, message: "Wybierz lokalizację stacji." };

  const now = new Date();
  let scannedAt = now;
  if (scannedAtIso) {
    const czas = resolveRecordedAt(scannedAtIso, now);
    if (!czas.ok) return { ok: false, message: RECORDED_AT_MESSAGE[czas.reason] };
    scannedAt = czas.at;
  }

  const result = await recordFloorCheckInByToken({
    token: cleaned,
    locationId,
    recordedByUserId: session.user.id,
    now: scannedAt,
  });

  if (!result.ok) {
    return { ok: false, message: "Nieznany kod - to nie jest kod wejścia z tej aplikacji." };
  }

  const { floorMinMinutes } = await getClubSettings();

  return {
    ok: true,
    alreadyOnFloor: result.outcome === "ALREADY_ON_FLOOR",
    name: result.user.name,
    roleLabel: ROLE_LABEL[result.user.role] ?? "Konto",
    enteredAtIso: result.enteredAt.toISOString(),
    valid: isVisitValid(result.enteredAt, now, floorMinMinutes),
    minutesLeft: minutesUntilValid(result.enteredAt, now, floorMinMinutes),
  };
}
