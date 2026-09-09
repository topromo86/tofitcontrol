import { classifyPassStatus } from "@/lib/domain/pass";
import { SETTLEMENT_LABEL, settlePass, sumPayments } from "@/lib/domain/payment-status";
import { formatDate, formatMoney } from "@/lib/format";
import { addCalendarDays, todayInTimeZone } from "@/lib/domain/time";
import { isoDay, MAX_BACKDATE_DAYS } from "@/lib/domain/payment-correction";
import { SubmitButton } from "./submit-button";
import { Input } from "@/components/ui/input";
import { recordPaymentAction, sellPassAction } from "./payment-actions";

// Lista klientów z przyjmowaniem wpłat. Wspólna dla kasy trenera i panelu
// właściciela - reguły rozliczenia są te same, więc jeden komponent zamiast
// dwóch rozjeżdżających się kopii. Różni je tylko `returnTo` (dokąd wrócić po
// zapisie) i to, czyich klientów dostaje na wejściu.

const STATUS_STYLE: Record<string, string> = {
  NONE: "text-red",
  EXPIRING_SOON: "text-amber",
  ACTIVE: "text-jade",
};

const SELECT = "border-line bg-surface-2 text-text rounded-md border px-2 py-2 text-sm";
const SELECT_SM = "border-line bg-surface text-text h-9 rounded-md border px-2 text-sm";

export type PaymentsPlan = {
  id: string;
  name: string;
  priceGross: number;
  forMinors: boolean;
};

export type PaymentsPass = {
  id: string;
  status: string;
  endsAt: Date;
  priceGross: number;
  plan: { name: string };
  payments: { amountGross: number }[];
};

export type PaymentsMember = {
  id: string;
  firstName: string;
  lastName: string;
  isMinor: boolean;
  passes: PaymentsPass[];
};

export function PaymentsList({
  members,
  plans,
  locations,
  defaultLocationId,
  returnTo,
  q,
  now,
  // Pole daty wpłaty widzi wyłącznie właściciel. Trener przy kasie zapisuje
  // to, co dzieje się teraz - wsteczne datowanie gotówki z jego ekranu byłoby
  // dziurą w mechanizmie, który ma jej pilnować. Serwer sprawdza to jeszcze raz
  // (app/payment-actions.ts), bo ukrycie pola niczego nie broni.
  mozeWybracDate = false,
  // Plan podstawiony w formularzu - przychodzi z "Przedłuż karnet" w kartotece,
  // żeby przedłużenie było jednym wyborem mniej. Gdy plan nie pasuje do tego
  // klienta (dorosły/dziecko), <select> zignoruje go i zostanie pierwszy z listy.
  defaultPlanId,
}: {
  members: PaymentsMember[];
  plans: PaymentsPlan[];
  locations: { id: string; name: string }[];
  defaultLocationId: string;
  returnTo: string;
  q: string;
  now: Date;
  mozeWybracDate?: boolean;
  defaultPlanId?: string;
}) {
  const dzis = todayInTimeZone(now);
  const dzisIso = isoDay(dzis);
  const najwczesniej = isoDay(addCalendarDays(dzis, -MAX_BACKDATE_DAYS));
  return (
    <ul className="flex flex-col gap-2">
      {members.map((m) => {
        const activePass = m.passes[0];
        const isFrozen = activePass?.status === "FROZEN";
        const availablePlans = plans.filter((p) => p.forMinors === m.isMinor);
        const badge = classifyPassStatus(
          !isFrozen && activePass ? { endsAt: activePass.endsAt } : null,
          now,
        );

        return (
          <li
            key={m.id}
            className="border-line bg-surface flex flex-col gap-2 rounded-md border p-3"
          >
            <div>
              <p className="text-text font-medium">
                {m.firstName} {m.lastName}
                {m.isMinor ? " (dziecko)" : ""}
              </p>
              {isFrozen ? (
                <p className="text-muted-brand font-mono text-xs">Zamrożony</p>
              ) : (
                <p className={`font-mono text-xs ${STATUS_STYLE[badge]}`}>
                  {activePass
                    ? `Aktywny karnet do ${formatDate(activePass.endsAt)}`
                    : "Brak aktywnego karnetu"}
                </p>
              )}
            </div>

            {/* Rozliczenie karnetów: co klient ma, do kiedy i czy zapłacił.
                Karnet z zaległością dostaje własne pole dopłaty, żeby
                wyrównanie było jednym kliknięciem, bez szukania po ekranach. */}
            {m.passes.length > 0 ? (
              <ul className="flex flex-col gap-2">
                {m.passes.map((p) => {
                  const s = settlePass(p.priceGross, sumPayments(p.payments));
                  const zaplacone = s.status === "PAID" || s.status === "OVERPAID";
                  return (
                    <li
                      key={p.id}
                      className="border-line-soft bg-surface-2 rounded-md border p-2 text-sm"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-text">
                          {p.plan.name}
                          <span className="text-muted-brand font-mono text-xs">
                            {" · ważny do "}
                            {formatDate(p.endsAt)}
                            {p.status === "FROZEN" ? " · zamrożony" : ""}
                          </span>
                        </span>
                        <span
                          className={`font-mono text-xs ${zaplacone ? "text-jade" : "text-amber"}`}
                        >
                          {SETTLEMENT_LABEL[s.status]}
                          {s.outstandingGross > 0
                            ? ` ${formatMoney(s.outstandingGross)}`
                            : ` (${formatMoney(s.paidGross)})`}
                        </span>
                      </div>

                      {s.outstandingGross > 0 ? (
                        <form
                          action={recordPaymentAction}
                          className="mt-2 flex flex-wrap items-center gap-2"
                        >
                          <input type="hidden" name="memberId" value={m.id} />
                          <input type="hidden" name="passId" value={p.id} />
                          <input type="hidden" name="q" value={q} />
                          <input type="hidden" name="returnTo" value={returnTo} />
                          <Input
                            name="amount"
                            required
                            inputMode="decimal"
                            defaultValue={(s.outstandingGross / 100).toFixed(2)}
                            aria-label="Kwota dopłaty w złotych"
                            className="border-line bg-surface h-9 w-28"
                          />
                          <select
                            name="method"
                            required
                            defaultValue="CASH"
                            aria-label="Metoda płatności"
                            className={SELECT_SM}
                          >
                            <option value="CASH">Gotówka</option>
                            <option value="BLIK">BLIK</option>
                            <option value="TRANSFER">Przelew</option>
                          </select>
                          <select
                            name="locationId"
                            required
                            defaultValue={defaultLocationId}
                            aria-label="Miejsce"
                            className={SELECT_SM}
                          >
                            {locations.map((loc) => (
                              <option key={loc.id} value={loc.id}>
                                {loc.name}
                              </option>
                            ))}
                          </select>
                          {mozeWybracDate ? (
                            <input
                              type="date"
                              name="dataWplaty"
                              defaultValue={dzisIso}
                              min={najwczesniej}
                              max={dzisIso}
                              aria-label="Data wpłaty"
                              title="Data wpłaty - domyślnie dziś"
                              className={SELECT}
                            />
                          ) : null}
                          <SubmitButton pendingLabel="Zapisuję..." variant="outline">
                            Przyjmij dopłatę
                          </SubmitButton>
                        </form>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            ) : null}

            <form action={sellPassAction} className="flex flex-col gap-2">
              <input type="hidden" name="memberId" value={m.id} />
              <input type="hidden" name="q" value={q} />
              <input type="hidden" name="returnTo" value={returnTo} />
              <div className="flex flex-wrap items-center gap-2">
                <select
                  name="planId"
                  required
                  aria-label="Rodzaj karnetu"
                  defaultValue={
                    defaultPlanId && availablePlans.some((p) => p.id === defaultPlanId)
                      ? defaultPlanId
                      : undefined
                  }
                  className={SELECT}
                >
                  {availablePlans.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} - {(p.priceGross / 100).toFixed(0)} zł
                    </option>
                  ))}
                </select>
                {/* Puste = klient płaci całość. Kwota niższa od ceny tworzy
                    karnet z zaległością widoczną wyżej. */}
                <Input
                  name="amount"
                  inputMode="decimal"
                  placeholder="Kwota (całość)"
                  aria-label="Kwota wpłaty w złotych"
                  className="border-line bg-surface-2 h-9 w-32"
                />
                <select
                  name="method"
                  required
                  defaultValue="CASH"
                  aria-label="Metoda płatności"
                  className={SELECT}
                >
                  <option value="CASH">Gotówka</option>
                  <option value="BLIK">BLIK</option>
                  <option value="TRANSFER">Przelew</option>
                </select>
                <select
                  name="locationId"
                  required
                  defaultValue={defaultLocationId}
                  aria-label="Miejsce"
                  className={SELECT}
                >
                  {locations.map((loc) => (
                    <option key={loc.id} value={loc.id}>
                      {loc.name}
                    </option>
                  ))}
                </select>
                {mozeWybracDate ? (
                  <input
                    type="date"
                    name="dataWplaty"
                    defaultValue={dzisIso}
                    min={najwczesniej}
                    max={dzisIso}
                    aria-label="Data wpłaty"
                    title="Data wpłaty - domyślnie dziś"
                    className={SELECT}
                  />
                ) : null}
                <SubmitButton pendingLabel="Zapisuję..." className="ml-auto">
                  Przyjmij wpłatę
                </SubmitButton>
              </div>

              {/* Kod rabatowy i karta podarunkowa - zwinięte, żeby nie
                  spowalniać typowej sprzedaży. */}
              <details className="group">
                <summary className="text-muted-brand hover:text-brand-red w-fit cursor-pointer font-mono text-[11px] tracking-widest uppercase">
                  + Kod rabatowy / karta podarunkowa
                </summary>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <Input
                    name="promoCode"
                    placeholder="Kod rabatowy"
                    className="border-line bg-surface-2 h-9 w-40"
                  />
                  <Input
                    name="giftCardCode"
                    placeholder="Karta podarunkowa (GC-...)"
                    className="border-line bg-surface-2 h-9 w-56"
                  />
                </div>
              </details>
            </form>
          </li>
        );
      })}
      {members.length === 0 ? <li className="text-muted-brand text-sm">Brak klientów.</li> : null}
    </ul>
  );
}
