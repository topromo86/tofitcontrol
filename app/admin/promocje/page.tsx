import { prisma } from "@/lib/prisma";
import { requireRole } from "@/lib/auth/guard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatDate, formatMoney } from "@/lib/format";
import {
  createPromoCodeAction,
  deactivateGiftCardAction,
  deactivatePromoCodeAction,
  sellGiftCardAction,
} from "./actions";

const selectClass =
  "border-line bg-surface-2 text-text w-full rounded-md border px-2 py-2 text-base md:text-sm";

function promoLabel(kind: string, value: number): string {
  return kind === "PERCENT" ? `-${value}%` : `-${formatMoney(value)}`;
}

export default async function PromocjePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; ok?: string; nowaKarta?: string }>;
}) {
  await requireRole("ADMIN");
  const { error, ok, nowaKarta } = await searchParams;

  const [plans, locations, members, promoCodes, giftCards] = await Promise.all([
    prisma.plan.findMany({ where: { active: true }, orderBy: { name: "asc" } }),
    prisma.location.findMany({ orderBy: { name: "asc" } }),
    prisma.member.findMany({
      orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
      select: { id: true, firstName: true, lastName: true },
    }),
    prisma.promoCode.findMany({
      include: { plan: true, _count: { select: { payments: true } } },
      orderBy: [{ active: "desc" }, { createdAt: "desc" }],
    }),
    prisma.giftCard.findMany({ orderBy: [{ active: "desc" }, { createdAt: "desc" }] }),
  ]);

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="font-display text-brand-red text-2xl tracking-wide">Rabaty i karty</h1>
        <p className="text-muted-brand mt-1 text-sm">
          Kody rabatowe (promocja na start, „przyprowadź znajomego”) i karty podarunkowe. Kody i
          karty wpisuje trener w kasie przy zakładaniu karnetu.
        </p>
      </div>

      {error ? (
        <p role="alert" className="border-red/40 bg-red/5 text-red rounded-md border p-3 text-sm">
          {error}
        </p>
      ) : null}
      {ok ? (
        <p className="border-jade bg-surface text-text rounded-md border p-3 text-sm">Zapisano.</p>
      ) : null}
      {nowaKarta ? (
        <p className="border-jade bg-surface text-text rounded-md border p-3 text-sm">
          Sprzedano kartę podarunkową. Kod do przekazania:{" "}
          <b className="text-brand-red font-mono tracking-widest">{nowaKarta}</b>
        </p>
      ) : null}

      {/* --- KODY RABATOWE --- */}
      <section>
        <h2 className="text-muted-brand font-mono text-xs tracking-widest uppercase">
          Kody rabatowe
        </h2>

        <form
          action={createPromoCodeAction}
          className="border-line bg-surface mt-2 flex flex-col gap-4 rounded-md border p-4"
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="code">Kod</Label>
              <Input
                id="code"
                name="code"
                required
                placeholder="np. START20"
                className="border-line bg-surface-2"
              />
            </div>
            <div>
              <Label htmlFor="kind">Typ rabatu</Label>
              <select id="kind" name="kind" required defaultValue="PERCENT" className={selectClass}>
                <option value="PERCENT">Procent (%)</option>
                <option value="AMOUNT">Kwota (zł)</option>
              </select>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <Label htmlFor="value">Wartość (% albo zł)</Label>
              <Input
                id="value"
                name="value"
                required
                placeholder="20 lub 50"
                className="border-line bg-surface-2"
              />
            </div>
            <div>
              <Label htmlFor="planId">Dotyczy karnetu</Label>
              <select id="planId" name="planId" className={selectClass}>
                <option value="">Wszystkie karnety</option>
                {plans.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label htmlFor="maxUses">Limit użyć (opcjonalnie)</Label>
              <Input
                id="maxUses"
                name="maxUses"
                type="number"
                min="1"
                placeholder="bez limitu"
                className="border-line bg-surface-2"
              />
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <Label htmlFor="validFrom">Ważny od (opcjonalnie)</Label>
              <Input
                id="validFrom"
                name="validFrom"
                type="date"
                className="border-line bg-surface-2"
              />
            </div>
            <div>
              <Label htmlFor="validUntil">Ważny do (opcjonalnie)</Label>
              <Input
                id="validUntil"
                name="validUntil"
                type="date"
                className="border-line bg-surface-2"
              />
            </div>
            <div>
              <Label htmlFor="note">Opis (opcjonalnie)</Label>
              <Input
                id="note"
                name="note"
                placeholder="np. promocja wrześniowa"
                className="border-line bg-surface-2"
              />
            </div>
          </div>

          <Button type="submit" className="self-start">
            Dodaj kod
          </Button>
        </form>

        <ul className="mt-3 flex flex-col gap-2">
          {promoCodes.map((c) => (
            <li
              key={c.id}
              className={`flex flex-wrap items-center justify-between gap-3 rounded-md border p-3 ${
                c.active ? "border-line bg-surface" : "border-line bg-surface-2 opacity-60"
              }`}
            >
              <div>
                <p className="text-text font-medium">
                  <span className="font-mono tracking-widest">{c.code}</span>{" "}
                  <span className="text-brand-red">{promoLabel(c.kind, c.value)}</span>
                  {c.active ? null : (
                    <span className="text-muted-brand ml-2 font-mono text-xs uppercase">
                      nieaktywny
                    </span>
                  )}
                </p>
                <p className="text-muted-brand mt-1 font-mono text-xs">
                  {c.plan ? c.plan.name : "wszystkie karnety"} · użyto {c._count.payments}
                  {c.maxUses != null ? `/${c.maxUses}` : ""}
                  {c.validUntil ? ` · do ${formatDate(c.validUntil)}` : ""}
                  {c.note ? ` · ${c.note}` : ""}
                </p>
              </div>
              {c.active ? (
                <form action={deactivatePromoCodeAction}>
                  <input type="hidden" name="id" value={c.id} />
                  <Button type="submit" size="sm" variant="outline">
                    Wyłącz
                  </Button>
                </form>
              ) : null}
            </li>
          ))}
          {promoCodes.length === 0 ? (
            <li className="text-muted-brand text-sm">Brak kodów. Dodaj pierwszy powyżej.</li>
          ) : null}
        </ul>
      </section>

      {/* --- KARTY PODARUNKOWE --- */}
      <section>
        <h2 className="text-muted-brand font-mono text-xs tracking-widest uppercase">
          Karty podarunkowe
        </h2>
        <p className="text-muted-brand mt-1 text-sm">
          Sprzedaż karty tworzy przychód od razu (przypisany do kupującego). Kod przekazujesz
          obdarowanemu - trener wpisze go w kasie jako częściową lub pełną zapłatę za karnet.
        </p>

        <form
          action={sellGiftCardAction}
          className="border-line bg-surface mt-2 grid gap-3 rounded-md border p-4 sm:grid-cols-2"
        >
          <div>
            <Label htmlFor="buyerMemberId">Kupujący (klient)</Label>
            <select id="buyerMemberId" name="buyerMemberId" required className={selectClass}>
              <option value="">Wybierz...</option>
              {members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.firstName} {m.lastName}
                </option>
              ))}
            </select>
          </div>
          <div>
            <Label htmlFor="gcValue">Wartość karty (zł)</Label>
            <Input
              id="gcValue"
              name="value"
              required
              placeholder="np. 200"
              className="border-line bg-surface-2"
            />
          </div>
          <div>
            <Label htmlFor="gcMethod">Metoda płatności</Label>
            <select
              id="gcMethod"
              name="method"
              required
              defaultValue="CASH"
              className={selectClass}
            >
              <option value="CASH">Gotówka</option>
              <option value="BLIK">BLIK</option>
              <option value="TRANSFER">Przelew</option>
            </select>
          </div>
          <div>
            <Label htmlFor="gcLocation">Miejsce</Label>
            <select id="gcLocation" name="locationId" required className={selectClass}>
              {locations.map((loc) => (
                <option key={loc.id} value={loc.id}>
                  {loc.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <Label htmlFor="gcValidUntil">Ważna do (opcjonalnie)</Label>
            <Input
              id="gcValidUntil"
              name="validUntil"
              type="date"
              className="border-line bg-surface-2"
            />
          </div>
          <div>
            <Label htmlFor="gcNote">Opis (opcjonalnie)</Label>
            <Input
              id="gcNote"
              name="note"
              placeholder="np. bon świąteczny"
              className="border-line bg-surface-2"
            />
          </div>
          <div className="sm:col-span-2">
            <Button type="submit">Sprzedaj kartę</Button>
            {members.length === 0 ? (
              <span className="text-muted-brand ml-3 text-xs">
                Najpierw dodaj klienta - kartę przypisujemy do kupującego.
              </span>
            ) : null}
          </div>
        </form>

        <ul className="mt-3 flex flex-col gap-2">
          {giftCards.map((g) => {
            const used = g.initialGross - g.balanceGross;
            return (
              <li
                key={g.id}
                className={`flex flex-wrap items-center justify-between gap-3 rounded-md border p-3 ${
                  g.active && g.balanceGross > 0
                    ? "border-line bg-surface"
                    : "border-line bg-surface-2 opacity-60"
                }`}
              >
                <div>
                  <p className="text-text font-medium">
                    <span className="font-mono tracking-widest">{g.code}</span>{" "}
                    <span className="text-jade">{formatMoney(g.balanceGross)}</span>
                    <span className="text-muted-brand"> / {formatMoney(g.initialGross)}</span>
                  </p>
                  <p className="text-muted-brand mt-1 font-mono text-xs">
                    {used > 0 ? `wykorzystano ${formatMoney(used)}` : "niewykorzystana"}
                    {g.validUntil ? ` · do ${formatDate(g.validUntil)}` : ""}
                    {g.active ? "" : " · wyłączona"}
                    {g.note ? ` · ${g.note}` : ""}
                  </p>
                </div>
                {g.active ? (
                  <form action={deactivateGiftCardAction}>
                    <input type="hidden" name="id" value={g.id} />
                    <Button type="submit" size="sm" variant="outline">
                      Wyłącz
                    </Button>
                  </form>
                ) : null}
              </li>
            );
          })}
          {giftCards.length === 0 ? (
            <li className="text-muted-brand text-sm">Brak kart. Sprzedaj pierwszą powyżej.</li>
          ) : null}
        </ul>
      </section>
    </div>
  );
}
