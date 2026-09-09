import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { requireTrainerSelf } from "@/lib/auth/guard";
import { seesSessionWhere } from "@/lib/domain/substitute";
import { addCalendarDays, todayInTimeZone, zonedTimeToUtc } from "@/lib/domain/time";
import { EXAM_LABEL, EXAM_STYLE, examState } from "@/lib/domain/medical-exam";
import { formatDate } from "@/lib/format";

// Pulpit trenera - ekran startowy po zalogowaniu. Skrót dnia i tego, co wymaga
// jego reakcji (zastępstwa, alerty). Odhaczanie obecności zostaje na ekranie
// "Dziś" - tu jest podgląd i szybkie przejścia. Strona serwerowa, bez JS.

function fullDate(date: Date): string {
  return new Intl.DateTimeFormat("pl-PL", {
    timeZone: "Europe/Warsaw",
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(date);
}

function time(date: Date): string {
  return new Intl.DateTimeFormat("pl-PL", {
    timeZone: "Europe/Warsaw",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export default async function TrainerDashboardPage() {
  const { session, trainer } = await requireTrainerSelf();
  const stanBadan = examState(trainer.medicalExamValidUntil, new Date());
  const now = new Date();
  const today = todayInTimeZone(now);
  const tomorrow = addCalendarDays(today, 1);
  const todayStart = zonedTimeToUtc(today.year, today.month, today.day, 0, 0);
  const todayEnd = zonedTimeToUtc(tomorrow.year, tomorrow.month, tomorrow.day, 0, 0);

  const [todaySessions, activeMembers, openAlerts, pendingSubs] = await Promise.all([
    prisma.session.findMany({
      where: {
        startsAt: { gte: todayStart, lt: todayEnd },
        status: "SCHEDULED",
        ...seesSessionWhere(trainer.id),
      },
      include: {
        location: true,
        bookings: { where: { status: { in: ["BOOKED", "ATTENDED"] } }, select: { id: true } },
        attendances: { select: { id: true } },
      },
      orderBy: { startsAt: "asc" },
    }),
    prisma.member.count({ where: { ownerTrainerId: trainer.id, status: "ACTIVE" } }),
    prisma.retentionTask.count({ where: { trainerId: trainer.id, closedAt: null } }),
    prisma.session.count({
      where: {
        substituteTrainerId: trainer.id,
        substituteStatus: "PENDING",
        status: "SCHEDULED",
        startsAt: { gte: now },
      },
    }),
  ]);

  const kpis = [
    { label: "Zajęcia dziś", value: String(todaySessions.length) },
    { label: "Podopieczni", value: String(activeMembers) },
    { label: "Otwarte alerty", value: String(openAlerts) },
    { label: "Zastępstwa dla Ciebie", value: String(pendingSubs) },
  ];

  const attention = [
    { count: pendingSubs, label: "Zastępstwa do potwierdzenia", href: "/trainer" },
    { count: openAlerts, label: "Otwarte alerty podopiecznych", href: "/trainer/alerty" },
  ].filter((a) => a.count > 0);

  const shortcuts = [
    { label: "Dziś", href: "/trainer" },
    { label: "Kasa", href: "/trainer/kasa" },
    { label: "Podopieczni", href: "/trainer/podopieczni" },
    { label: "Sparingi", href: "/trainer/sparingi" },
    { label: "Moja karta", href: "/trainer/karta" },
    { label: "Wynagrodzenie", href: "/trainer/wynagrodzenie" },
  ];

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="font-display text-brand-red text-2xl tracking-wide">
          Cześć, {session.user.name?.split(" ")[0] ?? "Trenerze"}
        </h1>
        <p className="text-muted-brand mt-1 text-sm capitalize">{fullDate(now)}</p>
      </div>

      {/* Badania - widoczne tylko dla trenera oznaczonego jako zawodnik.
          Kadra tez startuje w zawodach i tez traci prawo startu bez badan. */}
      {trainer.isCompetitor ? (
        <section
          className={`flex flex-col gap-1 rounded-md border p-4 ${
            stanBadan === "WYGASLO"
              ? "border-red/40 bg-red/5"
              : stanBadan === "KONCZY_SIE"
                ? "border-amber/50 bg-amber/10"
                : "border-line bg-surface"
          }`}
        >
          <h2 className="text-muted-brand font-mono text-xs tracking-widest uppercase">
            Twoje badania do zawodów
          </h2>
          <p className={`text-sm ${EXAM_STYLE[stanBadan]}`}>
            {EXAM_LABEL[stanBadan]}
            {trainer.medicalExamValidUntil
              ? ` - ważne do ${formatDate(trainer.medicalExamValidUntil)}`
              : ""}
          </p>
          <p className="text-muted-brand text-sm">
            Nowy termin wpisuje właściciel po okazaniu zaświadczenia.
          </p>
        </section>
      ) : null}

      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {kpis.map((k) => (
          <div key={k.label} className="border-line bg-surface rounded-md border p-4">
            <p className="text-muted-brand font-mono text-[11px] tracking-widest uppercase">
              {k.label}
            </p>
            <p className="text-text font-display mt-2 text-2xl">{k.value}</p>
          </div>
        ))}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-muted-brand font-mono text-xs tracking-widest uppercase">
          Wymaga Twojej uwagi
        </h2>
        {attention.length === 0 ? (
          <p className="border-jade/40 bg-jade/10 text-text rounded-md border p-4 text-sm">
            Nic nie czeka na Twoją decyzję. 👊
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {attention.map((a) => (
              <li key={a.label}>
                <Link
                  href={a.href}
                  className="border-amber bg-amber/5 hover:bg-amber/10 flex items-center justify-between gap-3 rounded-md border p-3 transition"
                >
                  <span className="text-text text-sm">{a.label}</span>
                  <span className="bg-amber text-surface flex size-7 shrink-0 items-center justify-center rounded-full font-mono text-sm font-bold">
                    {a.count}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="text-muted-brand font-mono text-xs tracking-widest uppercase">
            Dziś na sali ({todaySessions.length})
          </h2>
          {todaySessions.length > 0 ? (
            <Link href="/trainer" className="text-brand-red text-xs underline">
              Odhacz obecności →
            </Link>
          ) : null}
        </div>
        {todaySessions.length === 0 ? (
          <p className="text-muted-brand border-line bg-surface rounded-md border p-4 text-sm">
            Dziś nie masz zajęć w grafiku.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {todaySessions.map((s) => (
              <li
                key={s.id}
                className="border-line bg-surface flex flex-wrap items-center justify-between gap-3 rounded-md border p-3"
              >
                <div className="min-w-0">
                  <p className="text-text font-medium">
                    <span className="text-muted-brand font-mono text-xs">{time(s.startsAt)}</span>{" "}
                    {s.name}
                  </p>
                  <p className="text-muted-brand mt-0.5 font-mono text-xs">{s.location.name}</p>
                </div>
                <span className="text-muted-brand shrink-0 font-mono text-xs tracking-widest uppercase">
                  {s.attendances.length}/{s.bookings.length} obecnych
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-muted-brand font-mono text-xs tracking-widest uppercase">
          Szybkie akcje
        </h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {shortcuts.map((s) => (
            <Link
              key={s.href}
              href={s.href}
              className="border-line bg-surface hover:border-brand-red hover:text-brand-red text-text flex items-center justify-center rounded-md border p-4 text-center text-sm font-medium transition"
            >
              {s.label}
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}
