import { prisma } from "@/lib/prisma";
import { formatDate, formatMoney } from "@/lib/format";
import { todayInTimeZone, zonedTimeToUtc } from "@/lib/domain/time";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cancelPaymentAction, changePaymentDateAction, correctPaymentAction } from "./actions";
import { isoDay, MAX_BACKDATE_DAYS } from "@/lib/domain/payment-correction";
import { addCalendarDays } from "@/lib/domain/time";

function monthLabel(year: number, month: number): string {
  return new Intl.DateTimeFormat("pl-PL", { month: "long", year: "numeric" }).format(
    new Date(Date.UTC(year, month - 1, 1)),
  );
}

export default async function FinansePage({
  searchParams,
}: {
  searchParams: Promise<{ info?: string; blad?: string }>;
}) {
  const { info, blad } = await searchParams;
  const now = new Date();
  const today = todayInTimeZone(now);
  // Granice pola daty - te same, co przy wpisywaniu wpłaty.
  const dzisIso = isoDay(today);
  const najwczesniej = isoDay(addCalendarDays(today, -MAX_BACKDATE_DAYS));
  const monthStart = zonedTimeToUtc(today.year, today.month, 1, 0, 0);
  const nextMonth =
    today.month === 12
      ? { year: today.year + 1, month: 1 }
      : { year: today.year, month: today.month + 1 };
  const monthEnd = zonedTimeToUtc(nextMonth.year, nextMonth.month, 1, 0, 0);

  const [locations, monthPayments, allPaymentsByMember, activeMembers, recentPayments] =
    await Promise.all([
      prisma.location.findMany({ orderBy: { name: "asc" } }),
      prisma.payment.findMany({
        where: { recordedAt: { gte: monthStart, lt: monthEnd } },
        include: { pass: { include: { plan: true } } },
      }),
      prisma.payment.groupBy({ by: ["memberId"], _sum: { amountGross: true } }),
      prisma.member.findMany({
        where: { status: "ACTIVE" },
        include: { passes: { orderBy: { endsAt: "desc" }, take: 1 } },
      }),
      prisma.payment.findMany({
        orderBy: { recordedAt: "desc" },
        take: 40,
        include: {
          member: true,
          correctsPayment: { include: { member: true } },
          // Potrzebne, żeby na ekranie było widać, że ta wpłata została już
          // cofnięta - bez tego drugie anulowanie jest kwestią czasu.
          corrections: { select: { amountGross: true } },
        },
      }),
    ]);

  const totalRevenue = monthPayments.reduce((sum, p) => sum + p.amountGross, 0);

  const revenueByLocation = new Map<string, number>();
  for (const p of monthPayments) {
    revenueByLocation.set(p.locationId, (revenueByLocation.get(p.locationId) ?? 0) + p.amountGross);
  }

  const revenueByPlan = new Map<string, { name: string; count: number; total: number }>();
  for (const p of monthPayments) {
    const key = p.pass?.planId ?? "none";
    const name = p.pass?.plan.name ?? "Bez planu (korekta/inne)";
    const entry = revenueByPlan.get(key) ?? { name, count: 0, total: 0 };
    entry.count += 1;
    entry.total += p.amountGross;
    revenueByPlan.set(key, entry);
  }

  const totalAllTime = allPaymentsByMember.reduce((s, p) => s + (p._sum.amountGross ?? 0), 0);
  const payingMembersCount = allPaymentsByMember.length;
  const ltv = payingMembersCount > 0 ? totalAllTime / payingMembersCount : 0;

  const expiredToRecover = activeMembers
    .filter((m) => m.passes[0] && m.passes[0].endsAt < now)
    .sort((a, b) => a.passes[0]!.endsAt.getTime() - b.passes[0]!.endsAt.getTime());

  return (
    <div className="flex flex-col gap-8">
      <section>
        <h2 className="text-muted-brand font-mono text-xs tracking-widest uppercase">
          Przychód - {monthLabel(today.year, today.month)}
        </h2>
        <p className="font-display text-brand-red mt-1 text-3xl">{formatMoney(totalRevenue)}</p>
      </section>

      <section>
        <h2 className="text-muted-brand font-mono text-xs tracking-widest uppercase">
          Podział na lokalizacje
        </h2>
        <ul className="mt-2 flex flex-col gap-2">
          {locations.map((loc) => (
            <li
              key={loc.id}
              className="border-line bg-surface flex items-center justify-between rounded-md border p-3"
            >
              <span className="text-text font-medium">{loc.name}</span>
              <span className="font-mono text-sm">
                {formatMoney(revenueByLocation.get(loc.id) ?? 0)}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2 className="text-muted-brand font-mono text-xs tracking-widest uppercase">
          Struktura karnetów (ten miesiąc)
        </h2>
        <ul className="mt-2 flex flex-col gap-2">
          {[...revenueByPlan.values()].map((entry) => (
            <li
              key={entry.name}
              className="border-line bg-surface flex items-center justify-between rounded-md border p-3"
            >
              <span className="text-text font-medium">
                {entry.name}{" "}
                <span className="text-muted-brand font-mono text-xs">× {entry.count}</span>
              </span>
              <span className="font-mono text-sm">{formatMoney(entry.total)}</span>
            </li>
          ))}
          {revenueByPlan.size === 0 ? (
            <li className="text-muted-brand text-sm">Brak sprzedaży w tym miesiącu.</li>
          ) : null}
        </ul>
      </section>

      <section>
        <h2 className="text-muted-brand font-mono text-xs tracking-widest uppercase">
          LTV (średni przychód na płacącego klienta, całościowo)
        </h2>
        <p className="font-display mt-1 text-2xl">{formatMoney(ltv)}</p>
        <p className="text-muted-brand mt-1 text-xs">
          Liczone jako suma wszystkich wpłat / liczba klientów, którzy kiedykolwiek zapłacili (
          {payingMembersCount}). Uproszczony wskaźnik - nie uwzględnia czasu trwania relacji.
        </p>
      </section>

      <section>
        <h2 className="text-muted-brand font-mono text-xs tracking-widest uppercase">
          Wygasłe karnety do odzyskania ({expiredToRecover.length})
        </h2>
        <ul className="mt-2 flex flex-col gap-2">
          {expiredToRecover.map((m) => {
            const pass = m.passes[0]!;
            const daysAgo = Math.floor((now.getTime() - pass.endsAt.getTime()) / 86_400_000);
            return (
              <li
                key={m.id}
                className="border-line bg-surface flex items-center justify-between rounded-md border p-3"
              >
                <span className="text-text font-medium">
                  {m.firstName} {m.lastName}
                </span>
                <span className="text-red font-mono text-xs">
                  Wygasł {formatDate(pass.endsAt)} ({daysAgo} dni temu)
                </span>
              </li>
            );
          })}
          {expiredToRecover.length === 0 ? (
            <li className="text-muted-brand text-sm">
              Brak - wszyscy aktywni klienci mają ważny karnet.
            </li>
          ) : null}
        </ul>
      </section>

      <section>
        <h2 className="text-muted-brand font-mono text-xs tracking-widest uppercase">
          Płatności (ostatnie {recentPayments.length}) i korekty
        </h2>
        {info ? (
          <p className="border-jade/40 bg-jade/10 text-text mt-2 rounded-md border p-3 text-sm">
            {info}
          </p>
        ) : null}
        {blad ? (
          <p className="border-red/40 bg-red/10 text-red mt-2 rounded-md border p-3 text-sm">
            {blad}
          </p>
        ) : null}
        <p className="text-muted-brand mt-1 text-xs">
          Payment jest niezmienialny - korekta to nowy wpis z powodem, nigdy edycja ani usunięcie.
          Kwota korekty: dodatnia = dopłata, ujemna = zwrot.
        </p>
        <ul className="mt-2 flex flex-col gap-2">
          {recentPayments.map((p) => {
            // Saldo wpłaty po wszystkich korektach. Zero znaczy "anulowana" -
            // wtedy nie pokazujemy przycisku, bo druga korekta zrobiłaby
            // z klienta dłużnika na kwotę, której nikt od niego nie brał.
            const saldo = p.amountGross + p.corrections.reduce((s, k) => s + k.amountGross, 0);
            const anulowana = p.correctsPaymentId === null && saldo === 0;
            return (
              <li key={p.id} className="border-line bg-surface rounded-md border p-3">
                <div className="flex items-center justify-between">
                  <span className="text-text font-medium">
                    {p.member.firstName} {p.member.lastName}
                  </span>
                  <span
                    className={`font-mono text-sm ${p.amountGross < 0 ? "text-red" : "text-text"}`}
                  >
                    {formatMoney(p.amountGross)}
                  </span>
                </div>
                <p className="text-muted-brand font-mono text-xs">
                  {formatDate(p.recordedAt)} · {p.method}
                  {p.correctsPayment ? (
                    <span>
                      {" "}
                      · korekta płatności z {formatDate(p.correctsPayment.recordedAt)} (
                      {formatMoney(p.correctsPayment.amountGross)})
                    </span>
                  ) : null}
                </p>
                {p.note ? <p className="text-text mt-1 text-sm">{p.note}</p> : null}

                {anulowana ? (
                  <p className="border-amber/50 bg-amber/10 text-amber mt-2 rounded-md border px-2 py-1 font-mono text-[11px] tracking-widest uppercase">
                    Anulowana - rozliczona do zera
                  </p>
                ) : null}

                {/* "Pomyłka" to jedno kliknięcie i powód. Kwotę liczy system
                  (całe pozostałe saldo), bo liczenie jej w głowie przy kasie
                  jest dokładnie tym momentem, w którym powstaje druga pomyłka. */}
                {!anulowana && p.correctsPaymentId === null ? (
                  <form
                    action={cancelPaymentAction}
                    className="mt-2 flex flex-wrap items-center gap-2"
                  >
                    <input type="hidden" name="paymentId" value={p.id} />
                    <input type="hidden" name="returnTo" value="/admin/finanse" />
                    <Input
                      name="note"
                      placeholder="Powód anulowania (min. 5 znaków)"
                      required
                      minLength={5}
                      className="border-line bg-surface-2 w-72"
                    />
                    <Button
                      type="submit"
                      size="sm"
                      variant="outline"
                      className="border-red text-red"
                    >
                      Pomyłka - anuluj wpłatę
                    </Button>
                  </form>
                ) : null}

                {!anulowana && p.correctsPaymentId === null ? (
                  <form
                    action={changePaymentDateAction}
                    className="mt-2 flex flex-wrap items-center gap-2"
                  >
                    <input type="hidden" name="paymentId" value={p.id} />
                    <input type="hidden" name="returnTo" value="/admin/finanse" />
                    <span className="text-muted-brand font-mono text-[11px] tracking-widest uppercase">
                      Data wpłaty
                    </span>
                    <input
                      type="date"
                      name="dataWplaty"
                      defaultValue={isoDay(todayInTimeZone(p.recordedAt))}
                      min={najwczesniej}
                      max={dzisIso}
                      aria-label="Nowa data wpłaty"
                      className="border-line bg-surface-2 text-text h-8 rounded-md border px-2 text-xs"
                    />
                    <Button type="submit" size="sm" variant="ghost">
                      Zmień datę
                    </Button>
                  </form>
                ) : null}

                {!anulowana ? (
                  <form
                    action={correctPaymentAction}
                    className="mt-2 flex flex-wrap items-center gap-2"
                  >
                    <input type="hidden" name="paymentId" value={p.id} />
                    <Input
                      name="deltaZl"
                      type="number"
                      step="0.01"
                      placeholder="Kwota korekty (zł, może być ujemna)"
                      required
                      className="border-line bg-surface-2 w-full min-w-0 sm:w-56"
                    />
                    <Input
                      name="note"
                      placeholder="Powód korekty (min. 5 znaków)"
                      required
                      minLength={5}
                      className="border-line bg-surface-2 w-64"
                    />
                    <Button type="submit" size="sm" variant="outline">
                      Koryguj
                    </Button>
                  </form>
                ) : null}
              </li>
            );
          })}
          {recentPayments.length === 0 ? (
            <li className="text-muted-brand text-sm">Brak płatności.</li>
          ) : null}
        </ul>
      </section>
    </div>
  );
}
