import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { requireRole } from "@/lib/auth/guard";
import { addCalendarDays, todayInTimeZone, zonedTimeToUtc } from "@/lib/domain/time";
import { formatMoney } from "@/lib/format";
import {
  classifyTrainerCheckIn,
  TRAINER_CHECK_IN_LABEL,
  type TrainerCheckInState,
} from "@/lib/domain/class-qr";
import { effectiveTrainerId } from "@/lib/domain/substitute";
import { formatPhone } from "@/lib/domain/phone";
import { getClubSettings } from "@/lib/services/settings";

// Pulpit właściciela - ekran startowy admina po zalogowaniu. Dwie rzeczy naraz:
// szybki obraz kondycji klubu (KPI) i lista tego, co dziś wymaga jego decyzji
// (zatwierdzenia, zastępstwa, alerty). Wszystko klikalne, prowadzi w jedno
// kliknięcie do właściwego ekranu. Strona serwerowa, bez JS.

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

// Konto prowadzącego - z uwzględnieniem potwierdzonego zastępstwa. Kafelek
// musi mieć z czym porównać osobę, która się odbiła; inaczej cudze odbicie
// świeciłoby na zielono jako "Trener odbity".
function leadUserIdOf(session: {
  trainerId: string;
  substituteTrainerId: string | null;
  substituteStatus: "PENDING" | "ACCEPTED" | "DECLINED" | null;
  trainer: { userId: string };
  substituteTrainer: { userId: string } | null;
}): string {
  return effectiveTrainerId(session) === session.trainerId
    ? session.trainer.userId
    : (session.substituteTrainer?.userId ?? session.trainer.userId);
}

const CHECK_IN_STYLE: Record<TrainerCheckInState, string> = {
  ON_TIME: "text-jade",
  LATE: "text-amber",
  MISSING: "text-red",
  PENDING: "text-muted-brand",
  // Czerwień, nie pomarańcz: to nie jest "spóźnił się", tylko "prowadzi ktoś
  // inny niż w grafiku" - i wymaga decyzji właściciela, nie tylko odnotowania.
  OTHER_TRAINER: "text-red",
};

export default async function AdminDashboardPage() {
  const session = await requireRole("ADMIN");
  const settings = await getClubSettings();
  const now = new Date();
  const today = todayInTimeZone(now);
  const tomorrow = addCalendarDays(today, 1);
  const monthStart = zonedTimeToUtc(today.year, today.month, 1, 0, 0);
  const todayStart = zonedTimeToUtc(today.year, today.month, today.day, 0, 0);
  const todayEnd = zonedTimeToUtc(tomorrow.year, tomorrow.month, tomorrow.day, 0, 0);

  // Ostatnie 6 miesięcy (bieżący + 5 wstecz) do miniatury przychodu.
  const months: { year: number; month: number }[] = [];
  for (let i = 0, y = today.year, m = today.month; i < 6; i++) {
    months.unshift({ year: y, month: m });
    m -= 1;
    if (m === 0) {
      m = 12;
      y -= 1;
    }
  }
  const sixMonthsStart = zonedTimeToUtc(months[0].year, months[0].month, 1, 0, 0);

  const [
    membersActive,
    newThisMonth,
    activePasses,
    activeTrainers,
    revenueMonth,
    todaySessions,
    pendingMinors,
    pendingLinks,
    substituteAlerts,
    openRetentionTasks,
    todayNoTrainerCheckIn,
    revenue6m,
  ] = await Promise.all([
    prisma.member.count({ where: { status: "ACTIVE" } }),
    prisma.member.count({ where: { joinedAt: { gte: monthStart } } }),
    prisma.pass.count({ where: { status: "ACTIVE" } }),
    prisma.trainer.count({ where: { active: true } }),
    prisma.payment.aggregate({
      _sum: { amountGross: true },
      where: { recordedAt: { gte: monthStart, lt: todayEnd } },
    }),
    prisma.session.findMany({
      where: { startsAt: { gte: todayStart, lt: todayEnd }, status: "SCHEDULED" },
      include: {
        trainer: { include: { user: true } },
        substituteTrainer: { include: { user: true } },
        location: true,
        bookings: { where: { status: { in: ["BOOKED", "ATTENDED"] } }, select: { id: true } },
      },
      orderBy: { startsAt: "asc" },
    }),
    prisma.member.count({ where: { approvalStatus: "PENDING" } }),
    prisma.guardianLinkRequest.count({ where: { status: "PENDING" } }),
    prisma.session.count({
      where: {
        substituteStatus: { in: ["PENDING", "DECLINED"] },
        startsAt: { gte: now },
        status: "SCHEDULED",
      },
    }),
    prisma.retentionTask.count({ where: { closedAt: null } }),
    // Zajęcia, na których minął termin odbicia prowadzącego, a odbicia nie ma.
    // Właściciel ma się o tym dowiedzieć z systemu, a nie od klientów.
    prisma.session.findMany({
      where: {
        status: "SCHEDULED",
        trainerCheckedInAt: null,
        startsAt: { gte: todayStart, lt: todayEnd },
      },
      include: { trainer: { include: { user: true } }, location: true },
      orderBy: { startsAt: "asc" },
    }),
    prisma.payment.findMany({
      where: { recordedAt: { gte: sixMonthsStart, lt: todayEnd } },
      select: { amountGross: true, recordedAt: true },
    }),
  ]);

  // Przychód per miesiąc (strefa Warszawa) do miniatury słupkowej.
  const revenueByMonth = new Map<string, number>();
  for (const p of revenue6m) {
    const d = todayInTimeZone(p.recordedAt);
    const key = `${d.year}-${d.month}`;
    revenueByMonth.set(key, (revenueByMonth.get(key) ?? 0) + p.amountGross);
  }
  const revenueBars = months.map((m) => ({
    year: m.year,
    month: m.month,
    label: new Intl.DateTimeFormat("pl-PL", { month: "short" }).format(
      new Date(Date.UTC(m.year, m.month - 1, 1)),
    ),
    total: revenueByMonth.get(`${m.year}-${m.month}`) ?? 0,
  }));
  const maxBar = Math.max(1, ...revenueBars.map((b) => b.total));
  const prevMonthTotal = revenueBars[revenueBars.length - 2]?.total ?? 0;
  const thisMonthTotal = revenueBars[revenueBars.length - 1]?.total ?? 0;
  const monthDelta = thisMonthTotal - prevMonthTotal;

  const revenue = revenueMonth._sum.amountGross ?? 0;
  const bookedToday = todaySessions.reduce((sum, s) => sum + s.bookings.length, 0);
  const capacityToday = todaySessions.reduce((sum, s) => sum + s.capacity, 0);

  const kpis = [
    {
      label: "Aktywni klubowicze",
      value: String(membersActive),
      hint: `+${newThisMonth} w tym miesiącu`,
    },
    { label: "Przychód (ten miesiąc)", value: formatMoney(revenue), hint: "wpłaty od 1. dnia" },
    {
      label: "Zajęcia dziś",
      value: String(todaySessions.length),
      hint:
        todaySessions.length > 0
          ? `${bookedToday}/${capacityToday} miejsc zajętych`
          : "brak w grafiku",
    },
    {
      label: "Aktywne karnety",
      value: String(activePasses),
      hint: `${activeTrainers} trenerów w kadrze`,
    },
  ];

  // Termin odbicia minął, a trenera nie ma - dopiero to jest alertem.
  // Zajęcia, do których jest jeszcze czas, nie zawracają nikomu głowy.
  const missingCheckIns = todayNoTrainerCheckIn.filter(
    (s) =>
      classifyTrainerCheckIn({
        session: s,
        checkedInAt: s.trainerCheckedInAt,
        now,
        minutesBefore: settings.trainerCheckInMinutesBefore,
      }) === "MISSING",
  );

  const attention = [
    {
      count: pendingMinors,
      label: "Konta nieletnich do zatwierdzenia",
      href: "/admin/zatwierdzenia",
    },
    { count: pendingLinks, label: "Prośby rodziców o powiązanie", href: "/admin/zatwierdzenia" },
    { count: substituteAlerts, label: "Zastępstwa do potwierdzenia", href: "/admin/zastepstwa" },
    { count: openRetentionTasks, label: "Otwarte alerty retencji", href: "/admin/retencja" },
    {
      count: missingCheckIns.length,
      label: "Zajęcia bez odbicia prowadzącego",
      // Kotwica do sekcji niżej, nie ogólny grafik: alert nazywa konkretny
      // problem, więc ma prowadzić do konkretnych zajęć, a nie do listy
      // wszystkiego, w której trzeba ich szukać samemu.
      href: "#bez-odbicia",
    },
  ].filter((a) => a.count > 0);

  const shortcuts = [
    { label: "Dodaj klienta", href: "/admin/klienci/nowy" },
    // "Wpłaty", nie "Kasa": /admin/kasa to zamknięcie dnia kasowego, a w biegu
    // potrzebne jest przyjęcie pieniędzy od klienta.
    { label: "Wpłaty", href: "/admin/wplaty" },
    { label: "Rodzaje karnetów", href: "/admin/karnety" },
    { label: "Grafik zajęć", href: "/admin/zajecia" },
    { label: "Obłożenie sal", href: "/admin/oblozenie" },
    { label: "Finanse", href: "/admin/finanse" },
    { label: "Zatwierdzenia", href: "/admin/zatwierdzenia" },
  ];

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="font-display text-brand-red text-2xl tracking-wide">
          Cześć, {session.user.name?.split(" ")[0] ?? "Admin"}
        </h1>
        <p className="text-muted-brand mt-1 text-sm capitalize">{fullDate(now)}</p>
      </div>

      {/* Szybkie akcje na samej górze: to jest jedyna część pulpitu, po którą
          właściciel sięga w biegu. Liczby niżej czyta się na spokojnie. */}
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

      {/* KPI */}
      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {kpis.map((k) => (
          <div key={k.label} className="border-line bg-surface rounded-md border p-4">
            <p className="text-muted-brand font-mono text-[11px] tracking-widest uppercase">
              {k.label}
            </p>
            <p className="text-text font-display mt-2 text-2xl">{k.value}</p>
            <p className="text-muted-brand mt-1 text-xs">{k.hint}</p>
          </div>
        ))}
      </section>

      {/* Miniatura przychodu - słupki z ostatnich 6 miesięcy */}
      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-muted-brand font-mono text-xs tracking-widest uppercase">
            Przychód · 6 miesięcy
          </h2>
          <span className={`font-mono text-xs ${monthDelta >= 0 ? "text-jade" : "text-red"}`}>
            {monthDelta >= 0 ? "▲" : "▼"} {formatMoney(Math.abs(monthDelta))} vs poprzedni miesiąc
          </span>
        </div>
        <div className="border-line bg-surface rounded-md border p-4">
          <div className="flex items-end gap-2" style={{ height: 72 }}>
            {revenueBars.map((b) => {
              const h = Math.max(2, Math.round((Math.max(0, b.total) / maxBar) * 64));
              const isCurrent = b === revenueBars[revenueBars.length - 1];
              return (
                <div
                  key={`${b.year}-${b.month}`}
                  className={`flex-1 rounded-t ${isCurrent ? "bg-brand-red" : "bg-brand-red/30"}`}
                  style={{ height: h }}
                  title={formatMoney(b.total)}
                />
              );
            })}
          </div>
          <div className="mt-1 flex gap-2">
            {revenueBars.map((b) => (
              <span
                key={`l-${b.year}-${b.month}`}
                className="text-muted-brand flex-1 text-center font-mono text-[10px] uppercase"
              >
                {b.label}
              </span>
            ))}
          </div>
        </div>
      </section>

      {/* Wymaga uwagi */}
      <section className="flex flex-col gap-3">
        <h2 className="text-muted-brand font-mono text-xs tracking-widest uppercase">
          Wymaga Twojej uwagi
        </h2>
        {attention.length === 0 ? (
          <p className="border-jade/40 bg-jade/10 text-text rounded-md border p-4 text-sm">
            Wszystko ogarnięte - żadnych zaległych decyzji. 👊
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

      {/* Szczegóły alertu o braku odbicia. Sam alert nazywa problem, a tutaj
          jest to, czego właściciel potrzebuje, żeby zareagować: które zajęcia,
          kto miał je prowadzić i pod jaki numer zadzwonić. */}
      {missingCheckIns.length > 0 ? (
        <section id="bez-odbicia" className="flex flex-col gap-3">
          <h2 className="text-amber font-mono text-xs tracking-widest uppercase">
            Bez odbicia prowadzącego
          </h2>
          <p className="text-muted-brand text-sm">
            Minął termin odbicia ({settings.trainerCheckInMinutesBefore} min przed startem), a kodu
            nikt nie zeskanował. Zadzwoń albo sprawdź, czy ktoś jest na sali.
          </p>
          <ul className="flex flex-col gap-2">
            {missingCheckIns.map((s) => (
              <li
                key={s.id}
                className="border-amber bg-amber/5 flex flex-wrap items-center justify-between gap-3 rounded-md border p-3"
              >
                <div className="min-w-0">
                  <p className="text-text font-medium">
                    <span className="text-muted-brand font-mono text-xs">{time(s.startsAt)}</span>{" "}
                    {s.name}
                  </p>
                  <p className="text-muted-brand mt-0.5 font-mono text-xs">
                    {s.location.name} · {s.trainer.user.name}
                    {s.trainer.user.phone ? ` · ${formatPhone(s.trainer.user.phone)}` : ""}
                  </p>
                </div>
                {/* Numer jako odnośnik tel: - na telefonie właściciela to jedno
                    dotknięcie zamiast przepisywania cyfr. */}
                {s.trainer.user.phone ? (
                  <a
                    href={`tel:${s.trainer.user.phone}`}
                    className="border-amber text-amber hover:bg-amber/10 shrink-0 rounded-md border px-3 py-1.5 font-mono text-xs tracking-widest uppercase"
                  >
                    Zadzwoń
                  </a>
                ) : (
                  <span className="text-muted-brand shrink-0 font-mono text-xs">brak numeru</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* Dziś na sali */}
      <section className="flex flex-col gap-3">
        <h2 className="text-muted-brand font-mono text-xs tracking-widest uppercase">
          Dziś na sali ({todaySessions.length})
        </h2>
        {todaySessions.length === 0 ? (
          <p className="text-muted-brand border-line bg-surface rounded-md border p-4 text-sm">
            Dziś nie ma zajęć w grafiku. Rozpiskę ustawisz w{" "}
            <Link href="/admin/zajecia" className="text-brand-red underline">
              Grafiku zajęć
            </Link>
            .
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {todaySessions.map((s) => {
              const full = s.bookings.length >= s.capacity;
              const runner =
                s.substituteStatus === "ACCEPTED" && s.substituteTrainer
                  ? s.substituteTrainer.user.name
                  : s.trainer.user.name;
              return (
                <li
                  key={s.id}
                  className="border-line bg-surface flex flex-wrap items-center justify-between gap-3 rounded-md border p-3"
                >
                  <div className="min-w-0">
                    <p className="text-text font-medium">
                      <span className="text-muted-brand font-mono text-xs">{time(s.startsAt)}</span>{" "}
                      {s.name}
                    </p>
                    <p className="text-muted-brand mt-0.5 font-mono text-xs">
                      {s.location.name} · {runner}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-0.5">
                    <span
                      className={`font-mono text-xs tracking-widest uppercase ${
                        full ? "text-amber" : "text-jade"
                      }`}
                    >
                      {s.bookings.length}/{s.capacity} {full ? "komplet" : "miejsc"}
                    </span>
                    <span
                      className={`font-mono text-[11px] ${
                        CHECK_IN_STYLE[
                          classifyTrainerCheckIn({
                            session: s,
                            checkedInAt: s.trainerCheckedInAt,
                            checkedInUserId: s.trainerCheckedInUserId,
                            leadUserId: leadUserIdOf(s),
                            now,
                            minutesBefore: settings.trainerCheckInMinutesBefore,
                          })
                        ]
                      }`}
                    >
                      {
                        TRAINER_CHECK_IN_LABEL[
                          classifyTrainerCheckIn({
                            session: s,
                            checkedInAt: s.trainerCheckedInAt,
                            checkedInUserId: s.trainerCheckedInUserId,
                            leadUserId: leadUserIdOf(s),
                            now,
                            minutesBefore: settings.trainerCheckInMinutesBefore,
                          })
                        ]
                      }
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
