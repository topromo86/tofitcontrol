import "server-only";
import { prisma } from "@/lib/prisma";
import type { BookingHorizonMode } from "@/lib/domain/schedule";
import { FREE_CANCELLATION_WINDOW_HOURS } from "@/lib/domain/booking";
import { BONUS_THRESHOLD_SCORE } from "@/lib/domain/scoring";
import { resolveFontTheme, type FontThemeId } from "@/lib/domain/font-themes";
import {
  DEFAULT_QR_OPENS_MINUTES_BEFORE,
  DEFAULT_TRAINER_CHECK_IN_MINUTES_BEFORE,
} from "@/lib/domain/class-qr";

export type ClubSettingsView = {
  bookingHorizonMode: BookingHorizonMode;
  bookingHorizonDays: number;
  bonusThresholdScore: number;
  bonusAmountGross: number;
  freeCancellationHours: number;
  fontTheme: FontThemeId;
  qrOpensMinutesBefore: number;
  trainerCheckInMinutesBefore: number;
};

// Ustawienia klubu z bezpiecznym domyślnym stanem. Wiersz "singleton" jest
// zakładany migracją, ale gdyby go zabrakło (np. baza odtworzona z częściowego
// zrzutu), apka ma działać dalej na wartościach domyślnych, a nie wywalić się
// na ekranie grafiku.
export async function getClubSettings(): Promise<ClubSettingsView> {
  const settings = await prisma.clubSettings.findUnique({ where: { id: "singleton" } });
  return {
    bookingHorizonMode: settings?.bookingHorizonMode ?? "CURRENT_WEEK",
    bookingHorizonDays: settings?.bookingHorizonDays ?? 7,
    bonusThresholdScore: settings?.bonusThresholdScore ?? BONUS_THRESHOLD_SCORE,
    // Domyślnie 0 zł: dopóki właściciel nie ustawi kwoty, premia istnieje
    // jako próg, ale nic nie wypłacamy - lepiej niż zgadywać kwotę.
    bonusAmountGross: settings?.bonusAmountGross ?? 0,
    freeCancellationHours: settings?.freeCancellationHours ?? FREE_CANCELLATION_WINDOW_HOURS,
    fontTheme: resolveFontTheme(settings?.fontTheme),
    qrOpensMinutesBefore: settings?.qrOpensMinutesBefore ?? DEFAULT_QR_OPENS_MINUTES_BEFORE,
    trainerCheckInMinutesBefore:
      settings?.trainerCheckInMinutesBefore ?? DEFAULT_TRAINER_CHECK_IN_MINUTES_BEFORE,
  };
}
