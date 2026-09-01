import type { PrismaClient } from "@/app/generated/prisma/client";
import { todayInTimeZone, zonedTimeToUtc } from "@/lib/domain/time";
import {
  computeAlertRate,
  computeOnboardingRate,
  computeRet90,
  computeTrainerScore,
  MIN_MATURED_COUNT,
  normalizeRet90,
  ratingToNormalized,
  weightedClubSegmentRet90,
} from "@/lib/domain/scoring";
import { runsSessionWhere } from "@/lib/domain/substitute";

export type ComputeScoresResult = { trainersScored: number; notesFlaggedForAudit: number };

const MATURITY_DAYS = 90;
const AUDIT_SAMPLE_RATE = 0.1;

// SPEC.md sekcja 2 "Wynik trenera (job miesięczny, 1. dnia miesiąca)".
// `period` to bieżący miesiąc kalendarzowy (Europe/Warsaw) w chwili
// uruchomienia - job ma iść 1. dnia miesiąca, więc w praktyce podsumowuje
// świeżo zamknięty poprzedni okres. ret90/rating/alertRate/onbRate liczone są
// nad tym samym kroczącym oknem 90 dni (rating explicit w SPEC, reszta dla
// spójności) - inaczej niż "matured", które patrzy na CAŁĄ historię klienta
// od joinedAt, nie tylko na okno.
export async function computeScores(
  prisma: PrismaClient,
  now: Date = new Date(),
): Promise<ComputeScoresResult> {
  const { year, month } = todayInTimeZone(now);
  const period = `${year}-${String(month).padStart(2, "0")}`;
  const monthStart = zonedTimeToUtc(year, month, 1, 0, 0);
  const maturityThreshold = new Date(now.getTime() - MATURITY_DAYS * 86_400_000);
  const windowStart = new Date(now.getTime() - MATURITY_DAYS * 86_400_000);

  // isDemo: false - trener demonstracyjny nie ma po co trafiać do rankingu
  // klubu. Jego klienci są odfiltrowani niżej, więc i tak dostałby pusty wynik.
  const trainers = await prisma.trainer.findMany({
    where: { active: true, user: { isDemo: false } },
  });

  // Retencja klubu per segment (dzieci/dorośli) - policzona raz, współdzielona
  // przez wszystkich trenerów (lib/domain/scoring.ts#weightedClubSegmentRet90).
  // isDemo: false - to jest wspólny mianownik retencji dla KAŻDEGO trenera,
  // a wynik przekłada się przez bonusForScore na realną premię. Klubowicz
  // demonstracyjny przesuwałby liczbę, według której klub płaci ludziom.
  const clubMatured = await prisma.member.findMany({
    where: { joinedAt: { not: null, lte: maturityThreshold }, isDemo: false },
    select: { status: true, isMinor: true },
  });
  const clubRet90ByGroup = {
    minors: computeRet90(clubMatured.filter((m) => m.isMinor)),
    adults: computeRet90(clubMatured.filter((m) => !m.isMinor)),
  };

  let trainersScored = 0;

  for (const trainer of trainers) {
    const matured = await prisma.member.findMany({
      where: {
        ownerTrainerId: trainer.id,
        joinedAt: { not: null, lte: maturityThreshold },
        isDemo: false,
      },
      select: { status: true, isMinor: true },
    });
    const maturedCount = matured.length;

    if (maturedCount < MIN_MATURED_COUNT) {
      await prisma.trainerScore.upsert({
        where: { trainerId_period: { trainerId: trainer.id, period } },
        create: { trainerId: trainer.id, period, maturedCount, score: null },
        update: {
          maturedCount,
          score: null,
          ret90: null,
          ret90Normalized: null,
          rating: null,
          alertRate: null,
          onboardingRate: null,
          computedAt: now,
        },
      });
      trainersScored++;
      continue;
    }

    const ret90 = computeRet90(matured);
    const clubSegmentRet90 = weightedClubSegmentRet90(matured, clubRet90ByGroup);
    const ret90Norm = normalizeRet90(ret90, clubSegmentRet90);

    // Ocena sesji, które ten trener faktycznie prowadził - przy zastępstwie
    // liczy się do zastępującego, nie do "właściciela" szablonu zajęć.
    const ratingAgg = await prisma.rating.aggregate({
      where: {
        createdAt: { gte: windowStart },
        // Ocena idzie do tego, kto realnie prowadził - niepotwierdzone
        // zastępstwo zostawia zajęcia trenerowi pierwotnemu.
        session: runsSessionWhere(trainer.id),
      },
      _avg: { score: true },
    });
    const avgRating = ratingAgg._avg.score;
    const ratingNorm = ratingToNormalized(avgRating ?? null);

    const tasks = await prisma.retentionTask.findMany({
      where: { trainerId: trainer.id, createdAt: { gte: windowStart } },
      select: { closedAt: true, dueAt: true },
    });
    const alertRate = computeAlertRate(tasks);

    const steps = await prisma.onboardingStep.findMany({
      where: { member: { ownerTrainerId: trainer.id } },
      select: { completedAt: true, dueAt: true },
    });
    const onboardingRate = computeOnboardingRate(steps, now);

    const score = computeTrainerScore({
      maturedCount,
      ret90Norm,
      ratingNorm,
      alertRate,
      onboardingRate,
    });

    await prisma.trainerScore.upsert({
      where: { trainerId_period: { trainerId: trainer.id, period } },
      create: {
        trainerId: trainer.id,
        period,
        maturedCount,
        ret90,
        ret90Normalized: ret90Norm,
        rating: avgRating,
        alertRate,
        onboardingRate,
        score,
      },
      update: {
        maturedCount,
        ret90,
        ret90Normalized: ret90Norm,
        rating: avgRating,
        alertRate,
        onboardingRate,
        score,
        computedAt: now,
      },
    });
    trainersScored++;
  }

  const notesFlaggedForAudit = await flagNotesForAudit(prisma, monthStart, now);

  return { trainersScored, notesFlaggedForAudit };
}

// Audyt jakości (SPEC.md sekcja 2): "10% losowych notatek z kind=CONTACT
// miesięcznie oznaczaj do przeglądu przez właściciela. Bez tego trenerzy
// zaczną wklejać formułki." Losowanie w JS (Math.random) - próbka jakościowa
// do ręcznego przeglądu, nie wymaga siły kryptograficznej.
async function flagNotesForAudit(
  prisma: PrismaClient,
  monthStart: Date,
  now: Date,
): Promise<number> {
  const candidates = await prisma.note.findMany({
    where: { kind: "CONTACT", createdAt: { gte: monthStart, lte: now }, flaggedForAudit: false },
    select: { id: true },
  });
  const sampleSize = Math.round(candidates.length * AUDIT_SAMPLE_RATE);
  if (sampleSize === 0) return 0;

  const shuffled = [...candidates].sort(() => Math.random() - 0.5);
  const sample = shuffled.slice(0, sampleSize);

  await prisma.note.updateMany({
    where: { id: { in: sample.map((n) => n.id) } },
    data: { flaggedForAudit: true },
  });

  return sample.length;
}
