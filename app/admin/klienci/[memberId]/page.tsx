import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { requireRole } from "@/lib/auth/guard";
import { calculateAge } from "@/lib/domain/booking";
import { daysSince } from "@/lib/domain/retention";
import { LEAD_SOURCE_LABEL } from "@/lib/domain/lead-import";
import { MEMBER_LEVELS, MEMBER_LEVEL_LABEL } from "@/lib/domain/member-level";
import { formatDate, formatDayTime, formatMoney } from "@/lib/format";
import { formatPhone } from "@/lib/domain/phone";
import { cancelPaymentAction, changePaymentDateAction } from "../../finanse/actions";
import { isoDay, MAX_BACKDATE_DAYS } from "@/lib/domain/payment-correction";
import { addCalendarDays, todayInTimeZone } from "@/lib/domain/time";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  anonymizeMemberAction,
  confirmConsentDeliveryAction,
  markReferralRewardedAction,
  provisionLoginAccountAction,
  updateMemberAction,
} from "./actions";

const REFERRAL_STATUS_LABEL: Record<string, string> = {
  SENT: "Wysłany",
  REGISTERED: "Zarejestrowany",
  CONVERTED: "Zrealizowany",
  REWARDED: "Nagrodzony",
};

const STATUS_LABEL: Record<string, string> = {
  ACTIVE: "Aktywny",
  FROZEN: "Zamrożony",
  CHURNED: "Odszedł(a)",
};

const PASS_STATUS_LABEL: Record<string, string> = {
  ACTIVE: "Aktywny",
  FROZEN: "Zamrożony",
  EXPIRED: "Wygasły",
  CANCELLED: "Anulowany",
};

function formatTenure(joinedAt: Date | null, now: Date): string {
  if (!joinedAt) return "Jeszcze nie dołączył(a) - brak pierwszej płatności lub obecności.";
  const days = daysSince(joinedAt, now)!;
  return `Od ${formatDate(joinedAt)} (${days} dni)`;
}

export default async function AdminMemberCardPage({
  params,
  searchParams,
}: {
  params: Promise<{ memberId: string }>;
  searchParams: Promise<{
    konto?: string;
    "konto-blad"?: string;
    info?: string;
    blad?: string;
  }>;
}) {
  // Strażnik na samej stronie, nie tylko w layoucie: layout nie przelicza się
  // przy każdej nawigacji po stronie klienta, a na tej karcie leżą dane
  // wrażliwe i historia wpłat. Akcje mają własnych strażników, ale sam WIDOK
  // też musi być zamknięty.
  await requireRole("ADMIN");
  const { memberId } = await params;
  const query = await searchParams;

  const [member, locations, trainers] = await Promise.all([
    prisma.member.findUnique({
      where: { id: memberId },
      include: {
        user: { select: { email: true } },
        // Rodzic / opiekun prawny: dane kontaktowe i to, DO KTÓREGO konta
        // dziecko jest podpięte. Na karcie dziecka nie było o tym ani słowa,
        // więc telefon do rodzica trzeba było szukać po kartotece.
        guardianUser: {
          select: {
            id: true,
            name: true,
            email: true,
            phone: true,
            // Rodzic bywa też klubowiczem - wtedy da się przejść wprost do jego
            // karty zamiast szukać po nazwisku.
            memberAccount: { select: { id: true, firstName: true, lastName: true } },
          },
        },
        // Odwrotna strona tego samego powiązania: gdy to jest konto rodzica,
        // pokazujemy dzieci, którymi się opiekuje.
        payments: {
          orderBy: { recordedAt: "desc" },
          include: {
            pass: { select: { plan: { select: { name: true } } } },
            location: { select: { name: true } },
            corrections: { select: { amountGross: true } },
          },
        },
        ownerTrainer: { include: { user: true } },
        homeLocation: true,
        passes: { orderBy: { endsAt: "desc" }, include: { plan: true } },
        notes: { orderBy: { createdAt: "desc" }, take: 5, include: { authorUser: true } },
        referralsMade: { orderBy: { createdAt: "desc" }, include: { refereeMember: true } },
        // Etap 2 leadów: jeśli klient powstał z leada, pokazujemy jego pochodzenie
        // i pełną historię kontaktu sprzed założenia konta.
        convertedLead: {
          include: {
            notes: {
              include: { author: { select: { name: true } } },
              orderBy: { createdAt: "desc" },
            },
            activities: {
              include: { actor: { select: { name: true } } },
              orderBy: { createdAt: "desc" },
            },
          },
        },
      },
    }),
    prisma.location.findMany({ orderBy: { name: "asc" } }),
    prisma.trainer.findMany({
      where: { active: true },
      include: { user: true, location: true },
      orderBy: { user: { name: "asc" } },
    }),
  ]);
  if (!member) notFound();

  // Dzieci podpięte pod TO konto - druga strona powiązania rodzic-dziecko.
  // Osobne zapytanie, bo idzie przez User, a nie przez Member: opiekunem jest
  // konto logowania, nie kartoteka (rodzic może nie mieć własnej kartoteki).
  const dzieci = member.userId
    ? await prisma.member.findMany({
        where: { guardianUserId: member.userId },
        select: { id: true, firstName: true, lastName: true, birthDate: true, status: true },
        orderBy: [{ firstName: "asc" }],
      })
    : [];

  const now = new Date();
  const age = calculateAge(member.birthDate, now);
  const dzisIso = isoDay(todayInTimeZone(now));
  const najwczesniej = isoDay(addCalendarDays(todayInTimeZone(now), -MAX_BACKDATE_DAYS));

  // Hasło świeżo założonego konta - jednorazowo z ciasteczka (nie z URL).
  let provisioned: { email: string; password: string; emailed: boolean } | null = null;
  if (query.konto === "utworzone") {
    const raw = (await cookies()).get("provisioned-account")?.value;
    if (raw) {
      try {
        provisioned = JSON.parse(raw);
      } catch {
        provisioned = null;
      }
    }
  }

  return (
    <div className="flex flex-col gap-8">
      {query.info ? (
        <p className="border-jade/40 bg-jade/10 text-text rounded-md border p-3 text-sm">
          {query.info}
        </p>
      ) : null}
      {query.blad ? (
        <p className="border-red/40 bg-red/10 text-red rounded-md border p-3 text-sm">
          {query.blad}
        </p>
      ) : null}
      <section>
        <Link href="/admin" className="text-muted-brand hover:text-brand-red text-xs">
          ← Karnety
        </Link>
        <h1 className="font-display text-brand-red mt-1 text-2xl tracking-wide">
          {member.firstName} {member.lastName}
        </h1>
        <p className="text-muted-brand mt-1 font-mono text-xs tracking-widest uppercase">
          {age} lat ·{" "}
          {member.sex === "FEMALE" ? "Kobieta" : member.sex === "MALE" ? "Mężczyzna" : "?"}
          {member.isMinor ? " · Niepełnoletni" : ""} · Poziom {MEMBER_LEVEL_LABEL[member.level]} ·
          Status {STATUS_LABEL[member.status]}
        </p>
        <p className="text-muted-brand mt-1 text-sm">
          Opiekun: {member.ownerTrainer.user.name} · Lokalizacja domowa: {member.homeLocation.name}
        </p>
        <p className="mt-2 text-sm">
          <span className="text-muted-brand font-mono text-xs tracking-widest uppercase">
            Cel:{" "}
          </span>
          {member.goal ? member.goal : <span className="text-red">brak ustalonego celu</span>}
        </p>
        <p className="text-muted-brand mt-1 text-sm">{formatTenure(member.joinedAt, now)}</p>
      </section>

      {/* Rodzic i dzieci. Na karcie dziecka nie było o rodzicu ani słowa, więc
          numer do niego trzeba było szukać po całej kartotece - a przy dziecku
          to jest pierwsza rzecz, której się szuka. */}
      {member.guardianUser || dzieci.length > 0 ? (
        <section className="border-line bg-surface flex flex-col gap-3 rounded-md border p-4">
          {member.guardianUser ? (
            <div>
              <h2 className="text-muted-brand font-mono text-xs tracking-widest uppercase">
                Rodzic / opiekun prawny
              </h2>
              <p className="text-text mt-1 font-medium">{member.guardianUser.name}</p>
              <p className="text-muted-brand mt-0.5 text-sm">
                {/* To jest LOGIN rodzica - czyli odpowiedź na pytanie "do którego
                    konta to dziecko jest podpięte". */}
                Konto: <span className="text-text font-mono">{member.guardianUser.email}</span>
                {member.guardianUser.phone ? (
                  <>
                    {" · "}
                    <a
                      href={`tel:${member.guardianUser.phone}`}
                      className="text-brand-red underline"
                    >
                      {formatPhone(member.guardianUser.phone)}
                    </a>
                  </>
                ) : (
                  " · brak numeru"
                )}
              </p>
              {member.guardianUser.memberAccount ? (
                <p className="mt-1 text-sm">
                  <Link
                    href={`/admin/klienci/${member.guardianUser.memberAccount.id}`}
                    className="text-brand-red underline"
                  >
                    Rodzic też trenuje - otwórz jego kartę
                  </Link>
                </p>
              ) : (
                <p className="text-muted-brand mt-1 text-sm">
                  Rodzic nie ma własnej kartoteki - konto służy tylko do prowadzenia dziecka.
                </p>
              )}
            </div>
          ) : null}

          {dzieci.length > 0 ? (
            <div>
              <h2 className="text-muted-brand font-mono text-xs tracking-widest uppercase">
                Dzieci na tym koncie ({dzieci.length})
              </h2>
              <ul className="mt-1 flex flex-col gap-1">
                {dzieci.map((d) => (
                  <li key={d.id} className="text-sm">
                    <Link href={`/admin/klienci/${d.id}`} className="text-brand-red underline">
                      {d.firstName} {d.lastName}
                    </Link>
                    <span className="text-muted-brand">
                      {" "}
                      · {calculateAge(d.birthDate, now)} lat · {STATUS_LABEL[d.status]}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </section>
      ) : null}

      <section
        className={`rounded-md border p-4 ${
          member.consentsDeliveredAt ? "border-line bg-surface" : "border-amber bg-amber/5"
        }`}
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-muted-brand font-mono text-xs tracking-widest uppercase">
              Podpisane zgody
            </h2>
            {member.consentsDeliveredAt ? (
              <p className="text-jade mt-1 text-sm">
                Odbiór potwierdzony: {formatDate(member.consentsDeliveredAt)}.
              </p>
            ) : (
              <p className="text-amber mt-1 text-sm">
                Brak podpisanego wydruku. Do potwierdzenia klient zapisze się tylko na pierwsze
                zajęcia.
              </p>
            )}
          </div>
          {!member.consentsDeliveredAt ? (
            <form action={confirmConsentDeliveryAction}>
              <input type="hidden" name="memberId" value={member.id} />
              <Button type="submit" size="sm">
                Potwierdź odbiór zgód
              </Button>
            </form>
          ) : null}
        </div>
      </section>

      {member.convertedLead ? (
        <section className="border-line bg-surface rounded-md border p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-muted-brand font-mono text-xs tracking-widest uppercase">
              Pozyskany z leada
            </h2>
            <Link
              href={`/leady/${member.convertedLead.id}`}
              className="text-brand-red text-xs underline"
            >
              Otwórz kartę leada →
            </Link>
          </div>
          <p className="text-muted-brand mt-1 font-mono text-xs tracking-widest uppercase">
            {LEAD_SOURCE_LABEL[member.convertedLead.source]}
            {member.convertedLead.campaign ? ` · ${member.convertedLead.campaign}` : ""} ·
            zaimportowano {formatDate(member.convertedLead.importedAt)}
          </p>
          {member.convertedLead.phone ? (
            <p className="text-muted-brand mt-1 text-sm">
              Telefon z leada:{" "}
              <a href={`tel:${member.convertedLead.phone}`} className="text-brand-red">
                {member.convertedLead.phone}
              </a>
            </p>
          ) : null}

          {member.convertedLead.notes.length > 0 ? (
            <div className="mt-3">
              <p className="text-muted-brand font-mono text-[10px] tracking-widest uppercase">
                Notatki z rozmów ({member.convertedLead.notes.length})
              </p>
              <ul className="mt-1 flex flex-col gap-2">
                {member.convertedLead.notes.map((n) => (
                  <li key={n.id} className="border-line bg-surface-2 rounded-md border p-2">
                    <p className="text-text text-sm whitespace-pre-wrap">{n.body}</p>
                    <p className="text-muted-brand mt-1 font-mono text-[10px] uppercase">
                      {n.author.name} · {formatDayTime(n.createdAt)}
                    </p>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <details className="mt-3">
            <summary className="text-muted-brand cursor-pointer font-mono text-[10px] tracking-widest uppercase">
              Historia kontaktu ({member.convertedLead.activities.length})
            </summary>
            <ul className="mt-2 flex flex-col gap-1.5">
              {member.convertedLead.activities.map((a) => (
                <li key={a.id} className="text-muted-brand flex flex-wrap gap-x-2 text-xs">
                  <span className="font-mono">{formatDayTime(a.createdAt)}</span>
                  <span className="text-text">{a.summary}</span>
                  {a.actor ? <span>· {a.actor.name}</span> : null}
                </li>
              ))}
            </ul>
          </details>
        </section>
      ) : null}

      <section>
        <h2 className="text-muted-brand font-mono text-xs tracking-widest uppercase">
          Karnety ({member.passes.length})
        </h2>
        <ul className="mt-2 flex flex-col gap-2">
          {member.passes.map((p) => (
            <li
              key={p.id}
              className="border-line bg-surface flex items-center justify-between rounded-md border p-3"
            >
              <span className="text-text font-medium">{p.plan.name}</span>
              <span className="text-muted-brand font-mono text-xs">
                {formatDate(p.startsAt)} - {formatDate(p.endsAt)} · {PASS_STATUS_LABEL[p.status]}
              </span>
            </li>
          ))}
          {member.passes.length === 0 ? (
            <li className="text-muted-brand text-sm">
              Brak karnetów - jeszcze żaden nie sprzedany.
            </li>
          ) : null}
        </ul>
      </section>

      {/* Historia wpłat. Wcześniej pojedynczą wpłatę dało się zobaczyć wyłącznie
          na płaskiej liście czterdziestu ostatnich transakcji CAŁEGO klubu, bez
          wyszukiwarki - czyli przypadek "w piątek ktoś się pomylił u tego
          klienta" był praktycznie nie do obsłużenia. Stąd anulowanie jest
          dostępne również tutaj: tam, gdzie pomyłkę realnie się znajduje. */}
      <section>
        <h2 className="text-muted-brand font-mono text-xs tracking-widest uppercase">
          Historia wpłat ({member.payments.length})
        </h2>
        <ul className="mt-2 flex flex-col gap-2">
          {member.payments.map((p) => {
            const saldo = p.amountGross + p.corrections.reduce((s, k) => s + k.amountGross, 0);
            const anulowana = p.correctsPaymentId === null && saldo === 0;
            const korekta = p.correctsPaymentId !== null;
            return (
              <li key={p.id} className="border-line bg-surface rounded-md border p-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-text font-medium">
                    {p.pass?.plan.name ?? "Wpłata"}
                    {korekta ? (
                      <span className="text-muted-brand font-mono text-xs"> · korekta</span>
                    ) : null}
                  </span>
                  <span
                    className={`font-mono text-sm ${p.amountGross < 0 ? "text-red" : "text-text"}`}
                  >
                    {formatMoney(p.amountGross)}
                  </span>
                </div>
                <p className="text-muted-brand mt-0.5 font-mono text-xs">
                  {formatDate(p.recordedAt)} · {p.method} · {p.location.name}
                </p>
                {p.note ? <p className="text-text mt-1 text-sm">{p.note}</p> : null}

                {anulowana ? (
                  <p className="border-amber/50 bg-amber/10 text-amber mt-2 w-fit rounded-md border px-2 py-1 font-mono text-[11px] tracking-widest uppercase">
                    Anulowana - rozliczona do zera
                  </p>
                ) : null}

                {!anulowana && !korekta ? (
                  <form
                    action={changePaymentDateAction}
                    className="mt-2 flex flex-wrap items-center gap-2"
                  >
                    <input type="hidden" name="paymentId" value={p.id} />
                    <input type="hidden" name="returnTo" value={`/admin/klienci/${member.id}`} />
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

                {!anulowana && !korekta ? (
                  <form
                    action={cancelPaymentAction}
                    className="mt-2 flex flex-wrap items-center gap-2"
                  >
                    <input type="hidden" name="paymentId" value={p.id} />
                    <input type="hidden" name="returnTo" value={`/admin/klienci/${member.id}`} />
                    <Input
                      name="note"
                      placeholder="Powód anulowania (min. 5 znaków)"
                      required
                      minLength={5}
                      className="border-line bg-surface-2 w-64"
                    />
                    <Button
                      type="submit"
                      size="sm"
                      variant="outline"
                      className="border-red text-red"
                    >
                      Pomyłka - anuluj
                    </Button>
                  </form>
                ) : null}
              </li>
            );
          })}
          {member.payments.length === 0 ? (
            <li className="text-muted-brand text-sm">Brak wpłat.</li>
          ) : null}
        </ul>
      </section>

      {member.notes.length > 0 ? (
        <section>
          <h2 className="text-muted-brand font-mono text-xs tracking-widest uppercase">
            Ostatnie notatki trenera
          </h2>
          <ul className="mt-2 flex flex-col gap-2">
            {member.notes.map((note) => (
              <li key={note.id} className="border-line bg-surface rounded-md border p-3">
                <p className="text-muted-brand font-mono text-xs tracking-widest uppercase">
                  {note.kind} · {note.authorUser.name} · {formatDate(note.createdAt)}
                </p>
                <p className="text-text mt-1 text-sm">{note.body}</p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {member.referralsMade.length > 0 ? (
        <section>
          <h2 className="text-muted-brand font-mono text-xs tracking-widest uppercase">
            Polecenia
          </h2>
          <ul className="mt-2 flex flex-col gap-2">
            {member.referralsMade.map((r) => (
              <li
                key={r.id}
                className="border-line bg-surface flex items-center justify-between rounded-md border p-3"
              >
                <div>
                  <span className="text-text font-mono font-medium">{r.code}</span>
                  <span className="text-muted-brand ml-2 text-sm">
                    {REFERRAL_STATUS_LABEL[r.status] ?? r.status}
                    {r.refereeMember
                      ? ` - ${r.refereeMember.firstName} ${r.refereeMember.lastName}`
                      : ""}
                  </span>
                </div>
                {r.status === "CONVERTED" ? (
                  <form action={markReferralRewardedAction}>
                    <input type="hidden" name="referralId" value={r.id} />
                    <input type="hidden" name="memberId" value={member.id} />
                    <Button type="submit" size="sm" variant="outline">
                      Oznacz jako nagrodzone
                    </Button>
                  </form>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section>
        <h2 className="text-muted-brand font-mono text-xs tracking-widest uppercase">
          Edytuj dane klienta
        </h2>
        <form action={updateMemberAction} className="mt-2 flex max-w-lg flex-col gap-4">
          <input type="hidden" name="memberId" value={member.id} />
          <div className="flex gap-3">
            <div className="flex-1">
              <Label htmlFor="firstName">Imię</Label>
              <Input
                id="firstName"
                name="firstName"
                required
                defaultValue={member.firstName}
                className="border-line bg-surface-2"
              />
            </div>
            <div className="flex-1">
              <Label htmlFor="lastName">Nazwisko</Label>
              <Input
                id="lastName"
                name="lastName"
                required
                defaultValue={member.lastName}
                className="border-line bg-surface-2"
              />
            </div>
          </div>

          <div>
            <Label htmlFor="email">E-mail (kontakt)</Label>
            <Input
              id="email"
              name="email"
              type="email"
              required
              defaultValue={member.email ?? ""}
              className="border-line bg-surface-2"
            />
          </div>

          <div className="flex gap-3">
            <div className="flex-1">
              <Label htmlFor="birthDate">Data urodzenia</Label>
              <Input
                id="birthDate"
                name="birthDate"
                type="date"
                required
                defaultValue={member.birthDate.toISOString().slice(0, 10)}
                className="border-line bg-surface-2"
              />
            </div>
            <div className="flex-1">
              <Label htmlFor="sex">Płeć</Label>
              <select
                id="sex"
                name="sex"
                required
                defaultValue={member.sex ?? "FEMALE"}
                className="border-line bg-surface-2 text-text w-full rounded-md border px-2 py-2 text-sm"
              >
                <option value="FEMALE">Kobieta</option>
                <option value="MALE">Mężczyzna</option>
              </select>
            </div>
          </div>

          <div className="flex gap-3">
            <div className="flex-1">
              <Label htmlFor="level">Poziom</Label>
              <select
                id="level"
                name="level"
                required
                defaultValue={member.level}
                className="border-line bg-surface-2 text-text w-full rounded-md border px-2 py-2 text-sm"
              >
                {MEMBER_LEVELS.map((level) => (
                  <option key={level.value} value={level.value}>
                    {level.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex-1">
              <Label htmlFor="status">Status</Label>
              <select
                id="status"
                name="status"
                required
                defaultValue={member.status}
                className="border-line bg-surface-2 text-text w-full rounded-md border px-2 py-2 text-sm"
              >
                {Object.entries(STATUS_LABEL).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <Label htmlFor="weightKg">Waga (kg, opcjonalnie)</Label>
            <Input
              id="weightKg"
              name="weightKg"
              type="number"
              step="0.1"
              min="0"
              defaultValue={member.weightKg ?? ""}
              className="border-line bg-surface-2"
            />
          </div>

          <div>
            <Label htmlFor="goal">Cel (opcjonalnie)</Label>
            <Input
              id="goal"
              name="goal"
              defaultValue={member.goal ?? ""}
              className="border-line bg-surface-2"
            />
          </div>

          <div>
            <Label htmlFor="homeLocationId">Lokalizacja domowa</Label>
            <select
              id="homeLocationId"
              name="homeLocationId"
              required
              defaultValue={member.homeLocationId}
              className="border-line bg-surface-2 text-text w-full rounded-md border px-2 py-2 text-sm"
            >
              {locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <Label htmlFor="ownerTrainerId">Trener-opiekun</Label>
            <select
              id="ownerTrainerId"
              name="ownerTrainerId"
              required
              defaultValue={member.ownerTrainerId}
              className="border-line bg-surface-2 text-text w-full rounded-md border px-2 py-2 text-sm"
            >
              {trainers.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.user.name} ({t.location.name})
                </option>
              ))}
            </select>
            <p className="text-muted-brand mt-1 text-xs">
              Każdy klient musi mieć jednego odpowiedzialnego trenera (CLAUDE.md reguła 1).
            </p>
          </div>

          <Button type="submit" className="self-start">
            Zapisz zmiany
          </Button>
        </form>
      </section>

      <section>
        <h2 className="text-muted-brand font-mono text-xs tracking-widest uppercase">
          Konto logowania
        </h2>

        {query["konto-blad"] ? (
          <p className="border-red bg-surface text-text mt-2 rounded-md border p-3 text-sm">
            <b className="text-red">Błąd:</b> {query["konto-blad"]}
          </p>
        ) : null}

        {provisioned ? (
          <div className="border-jade bg-surface mt-2 rounded-md border p-3 text-sm">
            <p className="text-text font-medium">Konto założone.</p>
            <div className="text-muted-brand mt-2 flex flex-col gap-1 font-mono text-xs">
              <span>
                Login: <b className="text-text">{provisioned.email}</b>
              </span>
              <span>
                Hasło tymczasowe: <b className="text-text">{provisioned.password}</b>
              </span>
            </div>
            <p className="text-muted-brand mt-2">
              {provisioned.emailed
                ? "Dane wysłane też mailem. "
                : "Poczta nieaktywna - przekaż hasło klientowi osobiście. "}
              Zapisz hasło teraz - zniknie po chwili.
            </p>
          </div>
        ) : member.userId ? (
          <p className="text-muted-brand mt-2 text-sm">
            Klient ma konto logowania
            {member.user?.email ? (
              <>
                {" "}
                (<b className="text-text">{member.user.email}</b>)
              </>
            ) : null}
            . Hasło zmienia sam przez &bdquo;Nie pamiętasz hasła?&rdquo; na ekranie logowania.
          </p>
        ) : (
          <form action={provisionLoginAccountAction} className="mt-2 flex flex-col gap-3">
            <input type="hidden" name="memberId" value={member.id} />
            <p className="text-muted-brand text-sm">
              Ten klient nie ma jeszcze konta w aplikacji. Podaj e-mail - wygenerujemy hasło,
              wyślemy je na ten adres i pokażemy tutaj.
            </p>
            <div className="flex flex-wrap items-end gap-2">
              <div className="flex flex-col gap-1">
                <Label
                  htmlFor="provision-email"
                  className="font-mono text-xs tracking-widest uppercase"
                >
                  E-mail klienta
                </Label>
                <Input
                  id="provision-email"
                  name="email"
                  type="email"
                  required
                  defaultValue={member.email ?? ""}
                  className="border-line bg-surface-2 w-64"
                />
              </div>
              <Button type="submit">Załóż konto i wyślij hasło</Button>
            </div>
          </form>
        )}
      </section>

      <section>
        <h2 className="text-muted-brand font-mono text-xs tracking-widest uppercase">RODO</h2>
        <div className="mt-2 flex flex-col gap-4">
          <div>
            <a
              href={`/api/admin/export-member/${member.id}`}
              className="text-brand-red text-sm underline underline-offset-2"
            >
              Pobierz pełny eksport danych (JSON)
            </a>
          </div>

          <form
            action={anonymizeMemberAction}
            className="border-red/30 bg-red/5 flex flex-col gap-2 rounded-md border p-3"
          >
            <input type="hidden" name="memberId" value={member.id} />
            <p className="text-red text-sm font-medium">
              Usunięcie danych osobowych (nieodwracalne)
            </p>
            <p className="text-muted-brand text-xs">
              Czyści imię, nazwisko, kontakt, cel i wagę. Historia płatności i obecności zostaje
              zachowana (obowiązek księgowy), ale przestaje być powiązana z tożsamością klienta.
            </p>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="confirmed" required className="size-4" />
              Potwierdzam, że klient poprosił o usunięcie danych
            </label>
            <Button type="submit" variant="destructive" size="sm" className="self-start">
              Usuń dane osobowe
            </Button>
          </form>
        </div>
      </section>
    </div>
  );
}
