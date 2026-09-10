import Link from "next/link";
import { Info } from "lucide-react";
import { prisma } from "@/lib/prisma";
import { requireRole } from "@/lib/auth/guard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  costAppliesToMonth,
  formatMinutes,
  formatMonth,
  monthRange,
  parseMonthKey,
  SESSION_KIND_LABEL,
  sumCostsForMonth,
  type CostEntry,
} from "@/lib/domain/payroll";
import { bonusForScore } from "@/lib/domain/scoring";
import { todayInTimeZone } from "@/lib/domain/time";
import { getClubSettings } from "@/lib/services/settings";
import { trainerPayout } from "@/lib/services/payroll";
import { formatDate, formatMoney } from "@/lib/format";
import { PROSE_WIDTH } from "../../shell";
import {
  createCostAction,
  deleteCostAction,
  deleteTrainerRateAction,
  endCostAction,
  setTrainerRateAction,
} from "./actions";

const selectClass =
  "border-line bg-surface-2 text-text w-full rounded-md border px-2 py-2 text-base md:text-sm";

function isoDate(d: { year: number; month: number; day: number }): string {
  return `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;
}

function shiftMonth(year: number, month: number, delta: number): { year: number; month: number } {
  const index = year * 12 + (month - 1) + delta;
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
}

export default async function AdminPayrollPage({
  searchParams,
}: {
  searchParams: Promise<{ miesiac?: string; error?: string }>;
}) {
  await requireRole("ADMIN");
  const { miesiac, error } = await searchParams;

  const now = new Date();
  const today = todayInTimeZone(now);
  const selected = (miesiac ? parseMonthKey(miesiac) : null) ?? {
    year: today.year,
    month: today.month,
  };
  const selectedKey = `${selected.year}-${String(selected.month).padStart(2, "0")}`;
  const range = monthRange(selected.year, selected.month);

  const [trainers, costs, locations, revenue] = await Promise.all([
    prisma.trainer.findMany({
      where: { active: true },
      include: { user: true, location: true, rates: { orderBy: { validFrom: "desc" } } },
      orderBy: { user: { name: "asc" } },
    }),
    prisma.clubCost.findMany({ include: { location: true }, orderBy: { startsOn: "desc" } }),
    prisma.location.findMany({ orderBy: { name: "asc" } }),
    prisma.payment.aggregate({
      where: { recordedAt: { gte: range.startsAt, lt: range.endsAt } },
      _sum: { amountGross: true },
    }),
  ]);

  // Premia doliczana z wyniku za TEN miesiąc (TrainerScore.period). Wynik za
  // bieżący miesiąc może jeszcze nie istnieć - job liczy go 1. dnia - i wtedy
  // premii nie doliczamy, zamiast zgadywać.
  const settings = await getClubSettings();
  const scores = await prisma.trainerScore.findMany({ where: { period: selectedKey } });
  const scoreByTrainer = new Map(scores.map((s) => [s.trainerId, s.score]));

  const payouts = await Promise.all(
    trainers.map(async (trainer) => {
      const summary = await trainerPayout(trainer.id, selected.year, selected.month, now);
      const score = scoreByTrainer.get(trainer.id) ?? null;
      const bonusGross = bonusForScore(
        score,
        settings.bonusThresholdScore,
        settings.bonusAmountGross,
      );
      return {
        trainer,
        summary,
        score,
        scoreComputed: scoreByTrainer.has(trainer.id),
        bonusGross,
        payoutWithBonus: summary.totalGross + bonusGross,
      };
    }),
  );

  const costEntries: CostEntry[] = costs.map((c) => ({
    id: c.id,
    name: c.name,
    amountGross: c.amountGross,
    kind: c.kind,
    startsOn: c.startsOn,
    endsOn: c.endsOn,
  }));
  const costSummary = sumCostsForMonth(costEntries, selected.year, selected.month);
  const costsThisMonth = costs.filter((c) =>
    costAppliesToMonth(
      {
        id: c.id,
        name: c.name,
        amountGross: c.amountGross,
        kind: c.kind,
        startsOn: c.startsOn,
        endsOn: c.endsOn,
      },
      selected.year,
      selected.month,
    ),
  );

  const salariesEarned = payouts.reduce((sum, p) => sum + p.summary.earnedGross, 0);
  const salariesTotal = payouts.reduce((sum, p) => sum + p.payoutWithBonus, 0);
  const bonusesTotal = payouts.reduce((sum, p) => sum + p.bonusGross, 0);
  const revenueGross = revenue._sum?.amountGross ?? 0;
  const missingRates = payouts.reduce((sum, p) => sum + p.summary.sessionsWithoutRate, 0);

  const prev = shiftMonth(selected.year, selected.month, -1);
  const next = shiftMonth(selected.year, selected.month, 1);
  const monthLink = (m: { year: number; month: number }) =>
    `/admin/wynagrodzenia?miesiac=${m.year}-${String(m.month).padStart(2, "0")}`;

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="font-display text-brand-red text-2xl tracking-wide">
          Wynagrodzenia i koszty
        </h1>
        <p className="text-muted-brand mt-1 text-sm">
          Stawki trenerów, wypłaty za poprowadzone zajęcia i koszty klubu. Widoczne wyłącznie dla
          Ciebie.
        </p>
      </div>

      {error ? (
        <p role="alert" className="border-red/40 bg-red/5 text-red rounded-md border p-3 text-sm">
          {error}
        </p>
      ) : null}

      <section className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-muted-brand font-mono text-xs tracking-widest uppercase">
          Miesiąc: {formatMonth(selected.year, selected.month)}
        </h2>
        <div className="flex items-center gap-2">
          <Link
            href={monthLink(prev)}
            className="border-line bg-surface text-text hover:text-brand-red rounded-md border px-3 py-1.5 font-mono text-xs uppercase"
          >
            ← Poprzedni
          </Link>
          <Link
            href={monthLink(next)}
            className="border-line bg-surface text-text hover:text-brand-red rounded-md border px-3 py-1.5 font-mono text-xs uppercase"
          >
            Następny →
          </Link>
        </div>
      </section>

      {missingRates > 0 ? (
        <p className="border-amber/40 bg-amber/5 text-text rounded-md border p-3 text-sm">
          <b>{missingRates}</b> zajęć w tym miesiącu nie ma ustawionej stawki - liczą się jako 0 zł.
          Uzupełnij stawki poniżej, inaczej wypłata będzie zaniżona.
        </p>
      ) : null}

      <section className="flex flex-wrap gap-8">
        <div>
          <h2 className="text-muted-brand font-mono text-xs tracking-widest uppercase">
            Przychód (wpłaty)
          </h2>
          <p className="font-display text-jade text-3xl">{formatMoney(revenueGross)}</p>
        </div>
        <div>
          <h2 className="text-muted-brand font-mono text-xs tracking-widest uppercase">
            Wypłaty (zarobione)
          </h2>
          <p className="font-display text-3xl">{formatMoney(salariesEarned)}</p>
          <p className="text-muted-brand font-mono text-xs">
            prognoza na koniec: {formatMoney(salariesTotal)}
            {bonusesTotal > 0 ? ` (w tym premie ${formatMoney(bonusesTotal)})` : ""}
          </p>
        </div>
        <div>
          <h2 className="text-muted-brand font-mono text-xs tracking-widest uppercase">Koszty</h2>
          <p className="font-display text-3xl">{formatMoney(costSummary.totalGross)}</p>
          <p className="text-muted-brand font-mono text-xs">
            stałe {formatMoney(costSummary.recurringGross)} · jednorazowe{" "}
            {formatMoney(costSummary.oneOffGross)}
          </p>
        </div>
        <div>
          <h2 className="text-muted-brand font-mono text-xs tracking-widest uppercase">
            Zostaje (prognoza)
          </h2>
          <p
            className={`font-display text-3xl ${
              revenueGross - salariesTotal - costSummary.totalGross >= 0 ? "text-text" : "text-red"
            }`}
          >
            {formatMoney(revenueGross - salariesTotal - costSummary.totalGross)}
          </p>
        </div>
      </section>

      <section>
        <h2 className="text-muted-brand font-mono text-xs tracking-widest uppercase">
          Wypłaty trenerów
        </h2>
        <div className="mt-2 flex flex-col gap-2">
          {payouts.map(
            ({ trainer, summary, score, scoreComputed, bonusGross, payoutWithBonus }) => (
              <div key={trainer.id} className="border-line bg-surface rounded-md border p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="text-text font-medium">
                      {trainer.user.name}
                      {bonusGross > 0 ? (
                        <span className="bg-brand-red/10 text-brand-red ml-2 rounded-full px-2 py-0.5 font-mono text-xs uppercase">
                          Premia {formatMoney(bonusGross)}
                        </span>
                      ) : null}
                    </p>
                    <p className="text-muted-brand mt-0.5 font-mono text-xs">
                      {trainer.location.name} · odbyte {summary.doneCount} zajęć (
                      {formatMinutes(summary.doneMinutes)}) · zaplanowane {summary.upcomingCount}
                    </p>
                    <p className="text-muted-brand mt-0.5 font-mono text-xs">
                      {scoreComputed
                        ? `wynik ${score ?? "za mało danych"} · próg premii ${settings.bonusThresholdScore}`
                        : `wynik za ten miesiąc jeszcze nieobliczony · próg premii ${settings.bonusThresholdScore}`}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="font-display text-brand-red text-2xl">
                      {formatMoney(payoutWithBonus)}
                    </p>
                    <p className="text-muted-brand font-mono text-xs">
                      zarobione {formatMoney(summary.earnedGross)}
                      {bonusGross > 0 ? ` + premia ${formatMoney(bonusGross)}` : ""}
                    </p>
                  </div>
                </div>

                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                  {summary.byKind.map((kind) => (
                    <div key={kind.kind} className="border-line-soft rounded-md border p-2">
                      <p className="text-muted-brand font-mono text-xs tracking-widest uppercase">
                        {SESSION_KIND_LABEL[kind.kind]}
                      </p>
                      <p className="text-text mt-1 text-sm">
                        {kind.doneCount} odbytych · {formatMinutes(kind.doneMinutes)} ={" "}
                        <b>{formatMoney(kind.earnedGross)}</b>
                      </p>
                      <p className="text-muted-brand text-xs">
                        {kind.upcomingCount} zaplanowanych = {formatMoney(kind.forecastGross)} ·
                        stawka teraz:{" "}
                        {kind.currentRateGross != null
                          ? formatMoney(kind.currentRateGross)
                          : "nie ustawiona"}
                      </p>

                      <form
                        action={setTrainerRateAction}
                        className="mt-2 flex flex-wrap items-end gap-2"
                      >
                        <input type="hidden" name="trainerId" value={trainer.id} />
                        <input type="hidden" name="kind" value={kind.kind} />
                        <input type="hidden" name="month" value={selectedKey} />
                        <div className="w-24">
                          <Label htmlFor={`amount-${trainer.id}-${kind.kind}`} className="text-xs">
                            Stawka (zł)
                          </Label>
                          <Input
                            id={`amount-${trainer.id}-${kind.kind}`}
                            name="amount"
                            required
                            placeholder="120"
                            className="border-line bg-surface-2 h-8"
                          />
                        </div>
                        <div className="w-36">
                          <Label htmlFor={`from-${trainer.id}-${kind.kind}`} className="text-xs">
                            Od dnia
                          </Label>
                          <Input
                            id={`from-${trainer.id}-${kind.kind}`}
                            name="validFrom"
                            type="date"
                            required
                            defaultValue={isoDate({ ...selected, day: 1 })}
                            className="border-line bg-surface-2 h-8"
                          />
                        </div>
                        <Button type="submit" size="sm" variant="outline">
                          Ustaw
                        </Button>
                      </form>
                    </div>
                  ))}
                </div>

                {trainer.rates.length > 0 ? (
                  <details className="mt-2">
                    <summary className="text-muted-brand cursor-pointer text-xs">
                      Historia stawek ({trainer.rates.length})
                    </summary>
                    <ul className="mt-1 flex flex-col gap-1">
                      {trainer.rates.map((rate) => (
                        <li
                          key={rate.id}
                          className="text-muted-brand flex items-center justify-between font-mono text-xs"
                        >
                          <span>
                            {SESSION_KIND_LABEL[rate.kind]} · {formatMoney(rate.amountGross)} · od{" "}
                            {formatDate(rate.validFrom)}
                          </span>
                          <form action={deleteTrainerRateAction}>
                            <input type="hidden" name="rateId" value={rate.id} />
                            <input type="hidden" name="month" value={selectedKey} />
                            <button type="submit" className="text-red hover:underline">
                              usuń
                            </button>
                          </form>
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : null}
              </div>
            ),
          )}

          {payouts.length === 0 ? (
            <p className="text-muted-brand text-sm">Brak aktywnych trenerów.</p>
          ) : null}
        </div>
      </section>

      <section>
        <h2 className="text-muted-brand font-mono text-xs tracking-widest uppercase">
          Koszty klubu w tym miesiącu ({costsThisMonth.length})
        </h2>
        <ul className="mt-2 flex flex-col gap-2">
          {costsThisMonth.map((cost) => (
            <li
              key={cost.id}
              className="border-line bg-surface flex flex-wrap items-center justify-between gap-3 rounded-md border p-3"
            >
              <div>
                <p className="text-text font-medium">
                  {cost.name}
                  <span className="text-muted-brand ml-2 font-mono text-xs uppercase">
                    {cost.kind === "ONE_OFF" ? "jednorazowy" : "stały"}
                  </span>
                </p>
                <p className="text-muted-brand mt-0.5 font-mono text-xs">
                  {cost.kind === "ONE_OFF"
                    ? formatDate(cost.startsOn)
                    : `od ${formatDate(cost.startsOn)}${cost.endsOn ? ` do ${formatDate(cost.endsOn)}` : " · nadal"}`}
                  {cost.location ? ` · ${cost.location.name}` : ""}
                </p>
                {cost.note ? <p className="text-muted-brand mt-1 text-sm">{cost.note}</p> : null}
              </div>

              {/* Na telefonie ten rzad zawija sie i pole daty bierze cala
                  szerokosc. Wczesniej kwota, pole `w-36` i dwa przyciski
                  potrzebowaly okolo 380 px przy 317 px w karcie, wiec "Usun"
                  wyjezdzal poza ekran. */}
              <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:gap-3">
                <span className="font-display text-xl">{formatMoney(cost.amountGross)}</span>
                {cost.kind === "RECURRING_MONTHLY" && !cost.endsOn ? (
                  <form
                    action={endCostAction}
                    className="flex min-w-0 flex-1 items-center gap-2 sm:flex-none sm:gap-1"
                  >
                    <input type="hidden" name="costId" value={cost.id} />
                    <input type="hidden" name="month" value={selectedKey} />
                    <Input
                      name="endsOn"
                      type="date"
                      required
                      aria-label="Zakończ z dniem"
                      className="border-line bg-surface-2 h-11 min-w-0 flex-1 sm:h-8 sm:w-36 sm:flex-none"
                    />
                    <Button type="submit" size="sm" variant="outline">
                      Zakończ
                    </Button>
                  </form>
                ) : null}
                <form action={deleteCostAction}>
                  <input type="hidden" name="costId" value={cost.id} />
                  <input type="hidden" name="month" value={selectedKey} />
                  <Button type="submit" size="sm" variant="outline">
                    Usuń
                  </Button>
                </form>
              </div>
            </li>
          ))}

          {costsThisMonth.length === 0 ? (
            <li className="text-muted-brand text-sm">Brak kosztów w tym miesiącu.</li>
          ) : null}
        </ul>

        <form
          action={createCostAction}
          className="border-line bg-surface mt-3 grid gap-3 rounded-md border p-4 sm:grid-cols-6"
        >
          <input type="hidden" name="month" value={selectedKey} />
          <div className="sm:col-span-2">
            <Label htmlFor="costName">Nazwa</Label>
            <Input
              id="costName"
              name="name"
              required
              minLength={2}
              placeholder="Czynsz, media, worki..."
              className="border-line bg-surface-2"
            />
          </div>
          <div>
            <Label htmlFor="costKind">Rodzaj</Label>
            <select
              id="costKind"
              name="kind"
              required
              defaultValue="RECURRING_MONTHLY"
              className={selectClass}
            >
              <option value="RECURRING_MONTHLY">Stały miesięczny</option>
              <option value="ONE_OFF">Jednorazowy</option>
            </select>
          </div>
          <div>
            <Label htmlFor="costAmount">Kwota (zł)</Label>
            <Input
              id="costAmount"
              name="amount"
              required
              placeholder="3000"
              className="border-line bg-surface-2"
            />
          </div>
          <div>
            <Label htmlFor="costStartsOn">Od / data</Label>
            <Input
              id="costStartsOn"
              name="startsOn"
              type="date"
              required
              defaultValue={isoDate({ ...selected, day: 1 })}
              className="border-line bg-surface-2"
            />
          </div>
          <div>
            <Label htmlFor="costEndsOn">Do (opcjonalnie)</Label>
            <Input id="costEndsOn" name="endsOn" type="date" className="border-line bg-surface-2" />
          </div>
          <div className="sm:col-span-3">
            <Label htmlFor="costLocation">Lokalizacja (opcjonalnie)</Label>
            <select id="costLocation" name="locationId" defaultValue="" className={selectClass}>
              <option value="">Cały klub</option>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </div>
          <div className="sm:col-span-3">
            <Label htmlFor="costNote">Notatka (opcjonalnie)</Label>
            <Input id="costNote" name="note" className="border-line bg-surface-2" />
          </div>
          <div className="sm:col-span-6">
            <Button type="submit">Dodaj koszt</Button>
          </div>
        </form>
      </section>

      <details className="border-line bg-surface rounded-md border">
        <summary className="text-text flex cursor-pointer list-none items-center gap-2 p-4 font-mono text-xs tracking-widest uppercase [&::-webkit-details-marker]:hidden">
          <Info className="text-brand-red size-4" />
          Jak liczone są wypłaty
        </summary>
        <div
          className={`border-line text-muted-brand flex ${PROSE_WIDTH} flex-col gap-5 border-t p-4 text-sm`}
        >
          <div>
            <p className="text-text mb-1 font-mono text-xs tracking-widest uppercase">
              Za co płacimy
            </p>
            <p>
              Za <b>poprowadzone zajęcia</b>, osobno grupowe i indywidualne. Liczą się zajęcia,
              które się odbyły i nie zostały odwołane - odwołane nie wchodzą ani do wypłaty, ani do
              prognozy. Przy zastępstwie zajęcia liczą się <b>zastępującemu</b>, nie temu, kto
              figuruje w grafiku.
            </p>
            <p className="mt-2">
              Stawka jest za zajęcia, nie za godzinę. Godziny pokazujemy obok, żeby było widać
              nakład pracy, ale nie mnożymy przez nie kwoty. Jeśli wolisz rozliczenie godzinowe -
              powiedz, to niewielka zmiana.
            </p>
          </div>

          <div>
            <p className="text-text mb-1 font-mono text-xs tracking-widest uppercase">
              Stawki mają historię
            </p>
            <p>
              Każda stawka obowiązuje <b>od wskazanego dnia</b>. Podwyżka od 1 sierpnia nie zmienia
              tego, co trener zarobił w lipcu - każde zajęcia płacone są stawką z dnia, w którym się
              odbyły. Dzięki temu zamknięty miesiąc nie zmienia kwoty po fakcie.
            </p>
          </div>

          <div>
            <p className="text-text mb-1 font-mono text-xs tracking-widest uppercase">
              Prognoza do końca miesiąca
            </p>
            <p>
              „Zarobione” to zajęcia, które już się odbyły. „Prognoza” dolicza te zaplanowane do
              końca miesiąca. Jeśli zajęcia zostaną odwołane albo dojdą nowe, kwota się zmieni - to
              szacunek, nie zobowiązanie.
            </p>
          </div>

          <div>
            <p className="text-text mb-1 font-mono text-xs tracking-widest uppercase">
              ❗️ Zajęcia bez stawki
            </p>
            <p>
              Jeśli trener poprowadził zajęcia, dla których nie ma ustawionej stawki na ten dzień,
              liczą się jako 0 zł, a na górze ekranu pojawia się ostrzeżenie z ich liczbą. Nie
              zgadujemy kwoty za Ciebie - lepiej, żebyś zobaczył lukę, niż żeby ktoś dostał po cichu
              zaniżoną wypłatę.
            </p>
          </div>
        </div>
      </details>
    </div>
  );
}
