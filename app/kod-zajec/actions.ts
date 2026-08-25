"use server";

import { requireRole } from "@/lib/auth/guard";
import { checkInAtStation } from "@/lib/services/class-qr";
import { SCAN_REJECTION_MESSAGE } from "@/lib/domain/class-qr";
import { RECORDED_AT_MESSAGE, resolveRecordedAt } from "@/lib/domain/offline-queue";
import { formatTime } from "@/lib/format";

// Wynik skanu pokazywany na kiosku. Zwracamy gotowy komunikat, bo kiosk stoi
// na sali i ma mówić po ludzku, a nie kodami błędów.
export type StationScanView =
  { ok: false; message: string } | { ok: true; title: string; detail: string; warn: boolean };

const STATION_MESSAGE: Record<string, string> = {
  CODE_EXPIRED: "Kod wygasł. Odśwież go w telefonie i pokaż jeszcze raz.",
  CODE_INVALID: "To nie jest kod wejścia z tej aplikacji.",
  NO_OPEN_CLASS: "W tej sali nie ma teraz zajęć z aktywnym kodem.",
};

// `scannedAtIso` niesie godzinę odczytu kodu i pojawia się wyłącznie przy
// dopisywaniu odbić z kolejki offline. To ważne właśnie tutaj: kod rotacyjny
// żyje 30 sekund, więc sprawdzony wobec "teraz" po powrocie wifi zawsze byłby
// wygasły. Sprawdzamy go wobec momentu, w którym stanął przed kamerą - a ten
// moment i tak przechodzi przez resolveRecordedAt, bo pochodzi z przeglądarki.
export async function stationScanAction(
  code: string,
  locationId: string,
  scannedAtIso?: string,
): Promise<StationScanView> {
  // Skanuje zalogowane urządzenie klubu (konto KIOSK albo telefon personelu) -
  // to jest gwarancja, że kamera stoi na sali, a nie u kogoś w domu.
  await requireRole("ADMIN", "TRAINER", "KIOSK");

  const cleaned = code.trim();
  if (!cleaned) return { ok: false, message: "Pusty kod." };
  if (!locationId) return { ok: false, message: "Wybierz salę." };

  let scannedAt = new Date();
  if (scannedAtIso) {
    const czas = resolveRecordedAt(scannedAtIso, scannedAt);
    if (!czas.ok) return { ok: false, message: RECORDED_AT_MESSAGE[czas.reason] };
    scannedAt = czas.at;
  }

  const result = await checkInAtStation({ code: cleaned, locationId, now: scannedAt });

  if (!result.ok) {
    return {
      ok: false,
      message:
        STATION_MESSAGE[result.reason] ??
        SCAN_REJECTION_MESSAGE[result.reason as keyof typeof SCAN_REJECTION_MESSAGE] ??
        "Nie udało się odbić.",
    };
  }

  if (result.role === "TRAINER") {
    return {
      ok: true,
      title: "Prowadzący odbity",
      detail: `${result.sessionName} · ${formatTime(result.startsAt)}${
        result.late ? " · po terminie" : ""
      }`,
      warn: result.late,
    };
  }

  return {
    ok: true,
    title: result.memberName,
    detail: `${result.sessionName} · ${formatTime(result.startsAt)}`,
    warn: false,
  };
}
