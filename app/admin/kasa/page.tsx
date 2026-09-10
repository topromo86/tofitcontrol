import { prisma } from "@/lib/prisma";
import { formatDate, formatMoney } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { closeCashDayReconcileAction, refreshTodayCashDayAction } from "./actions";

export default async function KasaPage() {
  const locations = await prisma.location.findMany({ orderBy: { name: "asc" } });
  const cashDays = await prisma.cashDay.findMany({
    orderBy: { date: "desc" },
    take: 60,
    include: { closedByUser: true },
  });

  const byLocation = new Map<string, typeof cashDays>();
  for (const cd of cashDays) {
    const arr = byLocation.get(cd.locationId) ?? [];
    arr.push(cd);
    byLocation.set(cd.locationId, arr);
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-muted-brand min-w-0 text-sm">
          Dzienne rozliczenie gotówki per lokalizacja. Rozbieżność między kwotą oczekiwaną a
          policzoną wymaga notatki.
        </p>
        <form action={refreshTodayCashDayAction}>
          <Button type="submit" variant="outline" size="sm">
            Odśwież rozliczenie dzisiaj
          </Button>
        </form>
      </div>

      {locations.map((loc) => {
        const days = byLocation.get(loc.id) ?? [];
        return (
          <section key={loc.id}>
            <h2 className="font-display text-brand-red text-lg tracking-wide">{loc.name}</h2>
            <ul className="mt-2 flex flex-col gap-2">
              {days.map((cd) => {
                const discrepancy =
                  cd.countedGross != null ? cd.countedGross - cd.expectedGross : null;
                return (
                  <li key={cd.id} className="border-line bg-surface rounded-md border p-3">
                    <div className="flex items-center justify-between">
                      <span className="text-text font-medium">{formatDate(cd.date)}</span>
                      <span className="text-muted-brand font-mono text-xs">
                        Oczekiwane: {formatMoney(cd.expectedGross)}
                      </span>
                    </div>

                    {cd.closedAt ? (
                      <div className="text-muted-brand mt-1 font-mono text-xs">
                        Policzone: {formatMoney(cd.countedGross ?? 0)} · zamknięte przez{" "}
                        {cd.closedByUser?.name ?? "?"}
                        {discrepancy !== null && discrepancy !== 0 ? (
                          <span className="text-red">
                            {" "}
                            · rozbieżność {formatMoney(discrepancy)}
                          </span>
                        ) : null}
                        {cd.discrepancyNote ? (
                          <p className="text-text mt-1 font-sans">{cd.discrepancyNote}</p>
                        ) : null}
                      </div>
                    ) : (
                      <form
                        action={closeCashDayReconcileAction}
                        className="mt-2 flex flex-wrap items-center gap-2"
                      >
                        <input type="hidden" name="cashDayId" value={cd.id} />
                        <Input
                          name="countedGross"
                          type="number"
                          step="0.01"
                          min="0"
                          placeholder="Policzona kwota (zł)"
                          required
                          className="border-line bg-surface-2 w-40"
                        />
                        <Input
                          name="discrepancyNote"
                          placeholder="Notatka (jeśli rozbieżność)"
                          className="border-line bg-surface-2 w-56"
                        />
                        <Button type="submit" size="sm">
                          Zamknij dzień
                        </Button>
                      </form>
                    )}
                  </li>
                );
              })}
              {days.length === 0 ? (
                <li className="text-muted-brand text-sm">
                  Brak rozliczeń - kliknij przycisk powyżej, żeby wygenerować.
                </li>
              ) : null}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
