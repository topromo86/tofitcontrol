import { prisma } from "@/lib/prisma";
import { requireRole } from "@/lib/auth/guard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { describePlan, PLAN_PERIODS } from "@/lib/domain/plan";
import {
  createPlanAction,
  deletePlanAction,
  togglePlanActiveAction,
  updatePlanAction,
} from "./actions";
import { ChildMark } from "@/app/child-mark";

const selectClass = "border-line bg-surface-2 text-text mt-1 w-full rounded-md border px-3 py-2";

// Cena w polu formularza: grosze na złotówki, bez końcówki ",00".
function zl(priceGross: number): string {
  return (priceGross / 100).toFixed(2).replace(/\.00$/, "");
}

export default async function AdminPlansPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; edytuj?: string }>;
}) {
  await requireRole("ADMIN");
  const { error, edytuj } = await searchParams;

  const plans = await prisma.plan.findMany({
    include: { _count: { select: { passes: true } } },
    orderBy: [
      { active: "desc" },
      { forMinors: "asc" },
      { durationDays: "asc" },
      { priceGross: "asc" },
    ],
  });

  const edited = plans.find((p) => p.id === edytuj) ?? null;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="font-display text-brand-red text-2xl tracking-wide">Rodzaje karnetów</h1>
        <p className="text-muted-brand mt-1 text-sm">
          Cennik klubu: co da się kupić, na jak długo i za ile. Z tej listy trener wybiera karnet
          przy sprzedaży.
        </p>
      </div>

      {error ? (
        <p role="alert" className="border-red/40 bg-red/5 text-red rounded-md border p-3 text-sm">
          {error}
        </p>
      ) : null}

      <section>
        <h2 className="text-muted-brand font-mono text-xs tracking-widest uppercase">
          {edited ? `Edycja: ${edited.name}` : "Nowy rodzaj karnetu"}
        </h2>

        <form
          // Klucz przestawia formularz na nowy karnet po wejściu w edycję -
          // inaczej React zostawiłby w polach poprzednie wartości.
          key={edited?.id ?? "nowy"}
          action={edited ? updatePlanAction : createPlanAction}
          className="border-line bg-surface mt-2 grid gap-3 rounded-md border p-4 sm:grid-cols-5"
        >
          {edited ? <input type="hidden" name="planId" value={edited.id} /> : null}

          <div className="sm:col-span-2">
            <Label htmlFor="name">Nazwa</Label>
            <Input
              id="name"
              name="name"
              required
              defaultValue={edited?.name ?? ""}
              placeholder="np. OPEN Dorośli"
              className="border-line bg-surface-2"
            />
          </div>

          <div>
            <Label htmlFor="price">Cena (zł)</Label>
            <Input
              id="price"
              name="price"
              required
              inputMode="decimal"
              defaultValue={edited ? zl(edited.priceGross) : ""}
              placeholder="249"
              className="border-line bg-surface-2"
            />
          </div>

          <div>
            <Label htmlFor="durationDays">Ważność</Label>
            <select
              id="durationDays"
              name="durationDays"
              defaultValue={String(edited?.durationDays ?? 30)}
              className={selectClass}
            >
              {PLAN_PERIODS.map((period) => (
                <option key={period.days} value={period.days}>
                  {period.label} ({period.days} dni)
                </option>
              ))}
            </select>
          </div>

          <div>
            <Label htmlFor="customDays">Własna liczba dni</Label>
            <Input
              id="customDays"
              name="customDays"
              type="number"
              min={1}
              defaultValue={
                edited && !PLAN_PERIODS.some((p) => p.days === edited.durationDays)
                  ? edited.durationDays
                  : ""
              }
              placeholder="np. 45"
              className="border-line bg-surface-2"
            />
            <p className="text-muted-brand mt-1 text-[11px] leading-tight">
              Wypełnij tylko przy nietypowym okresie - wygrywa z listą obok.
            </p>
          </div>

          <div>
            <Label htmlFor="entriesPerMonth">Liczba wejść</Label>
            <Input
              id="entriesPerMonth"
              name="entriesPerMonth"
              type="number"
              min={1}
              defaultValue={edited?.entriesPerMonth ?? ""}
              placeholder="puste = OPEN"
              className="border-line bg-surface-2"
            />
            <p className="text-muted-brand mt-1 text-[11px] leading-tight">
              Puste = karnet OPEN, bez limitu wejść.
            </p>
          </div>

          <div className="flex items-end gap-2 sm:col-span-2">
            <label className="text-text flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                name="forMinors"
                defaultChecked={edited?.forMinors ?? false}
                className="size-4"
              />
              Karnet dla dzieci
            </label>
            <label className="text-text flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                name="forIndividual"
                defaultChecked={edited?.forIndividual ?? false}
                className="size-4"
              />
              Na treningi indywidualne
            </label>
          </div>

          <div className="flex items-end gap-2 sm:col-span-2">
            <Button type="submit">{edited ? "Zapisz zmiany" : "Dodaj karnet"}</Button>
            {edited ? (
              <a href="/admin/karnety">
                <Button type="button" variant="outline">
                  Anuluj
                </Button>
              </a>
            ) : null}
          </div>
        </form>

        <p className="text-muted-brand mt-2 text-xs">
          Zmiana ceny dotyczy przyszłej sprzedaży. Karnety już sprzedane zachowują kwotę uzgodnioną
          przy zakupie - inaczej podwyżka zrobiłaby zaległość każdemu, kto zapłacił wcześniej.
        </p>
      </section>

      <section>
        <h2 className="text-muted-brand font-mono text-xs tracking-widest uppercase">
          Cennik ({plans.filter((p) => p.active).length} w sprzedaży)
        </h2>

        <ul className="mt-2 flex flex-col gap-2">
          {plans.map((plan) => (
            <li
              key={plan.id}
              className={`border-line bg-surface flex flex-wrap items-center justify-between gap-2 rounded-md border p-3 ${
                plan.active ? "" : "opacity-60"
              }`}
            >
              <div>
                <p className="text-text font-medium">
                  {plan.name}
                  {plan.forMinors ? <ChildMark subject="plan" className="ml-1.5" /> : null}
                  {plan.forIndividual ? " (indywidualne)" : ""}
                  {plan.active ? "" : " · wycofany"}
                </p>
                <p className="text-muted-brand mt-1 font-mono text-xs">
                  {describePlan(plan)}
                  {plan._count.passes > 0
                    ? ` · sprzedany ${plan._count.passes}×`
                    : " · nigdy nie sprzedany"}
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <a href={`/admin/karnety?edytuj=${plan.id}`}>
                  <Button type="button" size="sm" variant="outline">
                    Edytuj
                  </Button>
                </a>
                <form action={togglePlanActiveAction}>
                  <input type="hidden" name="planId" value={plan.id} />
                  <Button type="submit" size="sm" variant="outline">
                    {plan.active ? "Wycofaj" : "Przywróć"}
                  </Button>
                </form>
                {/* Usunąć da się tylko karnet, którego nikt nie kupił - reszta
                    jest częścią historii sprzedaży. */}
                {plan._count.passes === 0 ? (
                  <form action={deletePlanAction}>
                    <input type="hidden" name="planId" value={plan.id} />
                    <Button type="submit" size="sm" variant="outline">
                      Usuń
                    </Button>
                  </form>
                ) : null}
              </div>
            </li>
          ))}
          {plans.length === 0 ? (
            <li className="text-muted-brand text-sm">
              Brak rodzajów karnetów - trener nie ma czego sprzedać.
            </li>
          ) : null}
        </ul>
      </section>
    </div>
  );
}
