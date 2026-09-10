import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { getAccessibleMembers } from "@/lib/auth/guard";
import {
  BOOKING_ERROR_MESSAGE,
  canCancelFree,
  hasRequiredConsents,
  requiredConsentKeys,
} from "@/lib/domain/booking";
import { ABSENCE_REASON_LABEL } from "@/lib/domain/absence";
import { RATING_LABEL, RATING_SCORES, scoreColor } from "@/lib/domain/rating";
import { bookingHorizonEnd, describeHorizon, startOfWeek, weekDays } from "@/lib/domain/schedule";
import { addCalendarDays, todayInTimeZone, zonedTimeToUtc } from "@/lib/domain/time";
import { getClubSettings } from "@/lib/services/settings";
import { buildSuggestions } from "@/lib/services/suggestions";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { formatDate, formatDayTime } from "@/lib/format";
import { assignCategoryColors, stripeClass } from "@/lib/domain/class-color";
import { WeekPlanner, type PlannerSession } from "./planner";
import {
  bookSessionAction,
  rateSessionAction,
  reportAbsencePeriodAction,
  reportSessionAbsenceAction,
} from "./actions";

const RATING_DELAY_MS = 3_600_000;

function formatDay(date: Date): string {
  return new Intl.DateTimeFormat("pl-PL", {
    timeZone: "Europe/Warsaw",
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(date);
}

function isoDate(date: { year: number; month: number; day: number }): string {
  return `${date.year}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`;
}

export default async function SchedulePage({
  searchParams,
}: {
  searchParams: Promise<{
    member?: string;
    location?: string;
    rodzaj?: string;
    tydzien?: string;
    error?: string;
  }>;
}) {
  const params = await searchParams;
  const members = await getAccessibleMembers();
  if (members.length === 0) return null; // layout już pokazał komunikat

  const activeMember = members.find((m) => m.id === params.member) ?? members[0];
  const [locations, categories, allCategories, settings] = await Promise.all([
    prisma.location.findMany({ orderBy: { name: "asc" } }),
    prisma.classCategory.findMany({
      where: { active: true },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    }),
    // Do kolorów bierzemy WSZYSTKIE rodzaje (także ukryte) - tak samo jak
    // admin. Gdyby liczyć tylko z aktywnych, ukrycie jednego rodzaju
    // przestawiłoby kolory pozostałych.
    prisma.classCategory.findMany({ orderBy: [{ sortOrder: "asc" }, { name: "asc" }] }),
    getClubSettings(),
  ]);
  const activeLocationId = params.location ?? activeMember.homeLocationId;
  const activeCategoryId = params.rodzaj ?? null;

  const grantedConsents = await prisma.consent.findMany({
    where: { memberId: activeMember.id, revokedAt: null },
    include: { consentType: true },
  });
  const grantedKeys = new Set(grantedConsents.map((c) => c.consentType.key));
  const missingConsents = !hasRequiredConsents(
    grantedKeys,
    requiredConsentKeys(activeMember.isMinor),
  );

  const now = new Date();
  const horizonEnd = bookingHorizonEnd({
    mode: settings.bookingHorizonMode,
    days: settings.bookingHorizonDays,
    now,
  });

  // Który tydzień pokazujemy. Domyślnie bieżący; strzałki przesuwają widok,
  // ale nigdy przed tydzień bieżący - grafiku wstecz klient nie potrzebuje.
  const currentWeekStart = startOfWeek(todayInTimeZone(now));
  const requested = params.tydzien?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const requestedWeekStart = requested
    ? startOfWeek({
        year: Number(requested[1]),
        month: Number(requested[2]),
        day: Number(requested[3]),
      })
    : currentWeekStart;
  const weekStart =
    isoDate(requestedWeekStart) < isoDate(currentWeekStart) ? currentWeekStart : requestedWeekStart;

  const weekStartUtc = zonedTimeToUtc(weekStart.year, weekStart.month, weekStart.day, 0, 0);
  const nextWeekStart = addCalendarDays(weekStart, 7);
  const weekEndUtc = zonedTimeToUtc(
    nextWeekStart.year,
    nextWeekStart.month,
    nextWeekStart.day,
    0,
    0,
  );
  const prevWeekStart = addCalendarDays(weekStart, -7);
  const canGoBack = isoDate(prevWeekStart) >= isoDate(currentWeekStart);

  const activeAbsenceReport = await prisma.absenceReport.findFirst({
    where: { memberId: activeMember.id, resolvedAt: null },
    orderBy: { reportedAt: "desc" },
  });

  // Zapisane zajęcia niezależnie od oglądanego tygodnia - klient ma je widzieć
  // zawsze, także gdy przewinie planner dwa tygodnie do przodu.
  const upcomingBookings = await prisma.booking.findMany({
    where: {
      memberId: activeMember.id,
      status: { in: ["BOOKED", "WAITLIST"] },
      session: { startsAt: { gte: now }, status: { not: "CANCELLED" } },
    },
    include: { session: { include: { trainer: { include: { user: true } } } } },
    orderBy: { session: { startsAt: "asc" } },
    take: 20,
  });

  // Przegląd rodzinny: gdy do konta należy więcej niż jedna osoba (rodzic +
  // dziecko/dzieci), pokazujemy najbliższe zajęcia wszystkich w jednym miejscu,
  // a zajęcia dziecka wyraźnie oznaczamy. To odpowiedź na "rodzic widzi swoje
  // zajęcia oraz dziecka, oznaczone jako zajęcia dziecka". Widok tylko do
  // odczytu - zapisy i odwołania robi się w widoku danej osoby (przełącznik).
  const familyBookings =
    members.length > 1
      ? await prisma.booking.findMany({
          where: {
            memberId: { in: members.map((m) => m.id) },
            status: { in: ["BOOKED", "WAITLIST"] },
            session: { startsAt: { gte: now }, status: { not: "CANCELLED" } },
          },
          include: { session: { include: { trainer: { include: { user: true } } } } },
          orderBy: { session: { startsAt: "asc" } },
          take: 30,
        })
      : [];
  const memberById = new Map(members.map((m) => [m.id, m]));

  // Sugestie kolejnych zajęć z historii obecności. Osobne zapytania od
  // plannera, bo patrzymy szerzej: na wszystkie lokalizacje i cały horyzont
  // zapisów, a nie tylko na oglądany tydzień i wybrany filtr.
  const suggestions = await buildSuggestions({
    memberId: activeMember.id,
    isMinor: activeMember.isMinor,
    now,
    horizonEnd,
  });

  const defaultAbsenceUntil = isoDate(addCalendarDays(todayInTimeZone(now), 7));

  const pendingRatings = await prisma.attendance.findMany({
    where: {
      memberId: activeMember.id,
      checkedInAt: { lte: new Date(now.getTime() - RATING_DELAY_MS) },
      session: { ratings: { none: { memberId: activeMember.id } } },
    },
    include: { session: true },
    orderBy: { checkedInAt: "desc" },
    take: 3,
  });

  const sessions = await prisma.session.findMany({
    where: {
      locationId: activeLocationId,
      startsAt: { gte: weekStartUtc, lt: weekEndUtc },
      ...(activeCategoryId ? { categoryId: activeCategoryId } : {}),
    },
    include: {
      template: true,
      category: true,
      trainer: { include: { user: true } },
      bookings: true,
    },
    orderBy: { startsAt: "asc" },
  });

  // Grupy dziecięce widzą tylko niepełnoletni i odwrotnie - ta sama reguła co
  // wcześniej, tylko przeniesiona do plannera.
  const relevant = sessions.filter((s) =>
    s.template ? s.template.isKids === activeMember.isMinor : true,
  );

  const categoryColors = assignCategoryColors(allCategories);

  const plannerSessions: PlannerSession[] = relevant.map((s) => {
    const myBooking = s.bookings.find(
      (b) => b.memberId === activeMember.id && (b.status === "BOOKED" || b.status === "WAITLIST"),
    );
    return {
      id: s.id,
      name: s.name,
      startsAt: s.startsAt,
      capacity: s.capacity,
      status: s.status,
      categoryName: s.category?.name ?? null,
      trainerName: s.trainer.user.name,
      bookedCount: s.bookings.filter((b) => b.status === "BOOKED").length,
      myBookingId: myBooking?.id ?? null,
      myBookingStatus: myBooking?.status ?? null,
      stripe: stripeClass(s.categoryId ? categoryColors.get(s.categoryId) : null),
    };
  });

  function linkWith(overrides: Record<string, string | null>): string {
    const query = new URLSearchParams();
    query.set("member", activeMember.id);
    query.set("location", activeLocationId);
    if (activeCategoryId) query.set("rodzaj", activeCategoryId);
    query.set("tydzien", isoDate(weekStart));
    for (const [key, value] of Object.entries(overrides)) {
      if (value === null) query.delete(key);
      else query.set(key, value);
    }
    return `/app?${query.toString()}`;
  }

  const returnTo = linkWith({});
  const visibleDays = weekDays(weekStart);
  const weekLabel = `${visibleDays[0].day}.${String(visibleDays[0].month).padStart(2, "0")} - ${visibleDays[6].day}.${String(visibleDays[6].month).padStart(2, "0")}`;

  return (
    <div className="flex flex-col gap-6">
      {members.length > 1 ? (
        <div className="flex flex-wrap gap-2">
          {members.map((m) => (
            <Link
              key={m.id}
              href={linkWith({ member: m.id })}
              className={`rounded-md border px-3 py-1.5 text-sm ${
                m.id === activeMember.id
                  ? "border-brand-red text-brand-red font-medium"
                  : "border-line bg-surface text-text"
              }`}
            >
              {m.firstName}
              {m.relation === "child" ? (
                <span className="text-muted-brand ml-1 text-xs">(dziecko)</span>
              ) : null}
            </Link>
          ))}
        </div>
      ) : null}

      {familyBookings.length > 0 ? (
        <section className="flex flex-col gap-2">
          <h2 className="text-muted-brand font-mono text-xs tracking-widest uppercase">
            Najbliższe zajęcia rodziny
          </h2>
          <ul className="flex flex-col gap-2">
            {familyBookings.map((b) => {
              const owner = memberById.get(b.memberId);
              const isChild = owner?.relation === "child";
              return (
                <li
                  key={b.id}
                  className={`rounded-md border p-3 ${
                    isChild ? "border-amber/50 bg-amber/5" : "border-line bg-surface"
                  }`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-text font-medium">{b.session.name}</p>
                    <span
                      className={`font-mono text-xs ${isChild ? "text-amber" : "text-muted-brand"}`}
                    >
                      {isChild ? `Dziecko: ${owner?.firstName}` : "Ty"}
                    </span>
                  </div>
                  <p className="text-muted-brand mt-0.5 font-mono text-xs">
                    {formatDayTime(b.session.startsAt)} · {b.session.trainer.user.name}
                    {b.status === "WAITLIST" ? " · lista rezerwowa" : ""}
                  </p>
                </li>
              );
            })}
          </ul>
          <p className="text-muted-brand text-xs">
            Zapisy i odwołania dla każdej osoby zrobisz, przełączając się na nią powyżej.
          </p>
        </section>
      ) : null}

      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-muted-brand w-20 font-mono text-xs tracking-widest uppercase">
            Miejsce
          </span>
          {locations.map((loc) => (
            <Link
              key={loc.id}
              href={linkWith({ location: loc.id })}
              className={`rounded-md border px-3 py-1.5 text-sm ${
                loc.id === activeLocationId
                  ? "border-brand-red text-brand-red font-medium"
                  : "border-line bg-surface text-text"
              }`}
            >
              {loc.name}
            </Link>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className="text-muted-brand w-20 font-mono text-xs tracking-widest uppercase">
            Rodzaj
          </span>
          <Link
            href={linkWith({ rodzaj: null })}
            className={`rounded-md border px-3 py-1.5 text-sm ${
              activeCategoryId === null
                ? "border-brand-red text-brand-red font-medium"
                : "border-line bg-surface text-text"
            }`}
          >
            Wszystkie
          </Link>
          {categories.map((category) => (
            <Link
              key={category.id}
              href={linkWith({ rodzaj: category.id })}
              className={`rounded-md border px-3 py-1.5 text-sm ${
                category.id === activeCategoryId
                  ? "border-brand-red text-brand-red font-medium"
                  : "border-line bg-surface text-text"
              }`}
            >
              {category.name}
            </Link>
          ))}
        </div>
      </div>

      {params.error ? (
        <p role="alert" className="border-red/40 bg-red/10 text-red rounded-md border p-3 text-sm">
          {BOOKING_ERROR_MESSAGE[params.error as keyof typeof BOOKING_ERROR_MESSAGE] ??
            "Nie udało się wykonać akcji."}
        </p>
      ) : null}

      {missingConsents ? (
        <p className="border-brand-red/40 bg-brand-red/10 text-text rounded-md border p-3 text-sm">
          Brakuje kompletu wymaganych zgód dla {activeMember.firstName} - uzupełnij je w zakładce{" "}
          <Link href={`/app/zgody?member=${activeMember.id}`} className="text-brand-red underline">
            Zgody
          </Link>
          , inaczej zapis na zajęcia się nie powiedzie.
        </p>
      ) : null}

      {pendingRatings.length > 0 ? (
        <section className="flex flex-col gap-2">
          <h2 className="text-muted-brand font-mono text-xs tracking-widest uppercase">
            Oceń ostatnie zajęcia
          </h2>
          <ul className="flex flex-col gap-2">
            {pendingRatings.map((a) => (
              <li key={a.id} className="border-line bg-surface rounded-md border p-3">
                <p className="text-text font-medium">{a.session.name}</p>
                <p className="text-muted-brand font-mono text-xs">
                  {formatDay(a.session.startsAt)}
                </p>

                {/* Opinia jest w tym samym formularzu co oceny, więc sama ocena
                    to nadal jedno kliknięcie - kto chce, rozwija i dopisuje. */}
                <form action={rateSessionAction} className="mt-2 flex flex-col gap-2">
                  <input type="hidden" name="memberId" value={activeMember.id} />
                  <input type="hidden" name="sessionId" value={a.sessionId} />
                  <input type="hidden" name="returnTo" value={returnTo} />

                  <div className="flex flex-wrap items-center gap-1.5">
                    {RATING_SCORES.map((n) => (
                      <button
                        key={n}
                        type="submit"
                        name="score"
                        value={String(n)}
                        title={RATING_LABEL[n]}
                        className="size-9 rounded-md border font-mono text-sm font-bold text-white transition-transform hover:scale-110"
                        style={{ backgroundColor: scoreColor(n), borderColor: scoreColor(n) }}
                      >
                        {n}
                      </button>
                    ))}
                    <span className="text-muted-brand ml-1 text-xs">
                      1 = {RATING_LABEL[1]}, 5 = {RATING_LABEL[5]}
                    </span>
                  </div>

                  <details>
                    <summary className="text-brand-red cursor-pointer text-sm">
                      Dodaj opinię (opcjonalnie)
                    </summary>
                    <div className="mt-2 flex flex-col gap-2">
                      <Textarea
                        name="comment"
                        rows={3}
                        placeholder="Co było dobre, co można poprawić?"
                        className="border-line bg-surface-2"
                      />
                      <p className="text-muted-brand text-xs">
                        <b className="text-text">Opinia jest anonimowa dla trenera</b> - nie zobaczy
                        jej wcale, ani treści, ani tego, że ją napisałeś. Czyta ją wyłącznie
                        właściciel klubu i widzi przy niej Twoje imię. Po napisaniu kliknij ocenę
                        powyżej, żeby wysłać.
                      </p>
                    </div>
                  </details>
                </form>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {suggestions.length > 0 ? (
        <section className="flex flex-col gap-2">
          <h2 className="text-muted-brand font-mono text-xs tracking-widest uppercase">
            Wróć na swój termin
          </h2>
          <ul className="flex flex-col gap-2">
            {suggestions.map((s) => (
              <li
                key={s.sessionId}
                className="border-line bg-surface flex flex-wrap items-center justify-between gap-3 rounded-md border p-3"
              >
                <div className="min-w-0">
                  <p className="text-text font-medium">{s.name}</p>
                  <p className="text-muted-brand mt-0.5 font-mono text-xs">
                    {formatDayTime(s.startsAt)} · {s.locationName} · {s.trainerName}
                  </p>
                  <p className="text-jade mt-1 text-sm">{s.reason}</p>
                </div>
                <form action={bookSessionAction} className="shrink-0">
                  <input type="hidden" name="memberId" value={activeMember.id} />
                  <input type="hidden" name="sessionId" value={s.sessionId} />
                  <input type="hidden" name="returnTo" value={returnTo} />
                  <Button type="submit" size="sm">
                    Zapisz się
                  </Button>
                </form>
              </li>
            ))}
          </ul>
          <p className="text-muted-brand text-xs">
            Podpowiadamy wyłącznie terminy, na których bywasz regularnie. Nie chcesz ich widzieć w
            powiadomieniach?{" "}
            <Link href="/app/powiadomienia" className="hover:text-brand-red underline">
              Ustawienia powiadomień
            </Link>
            .
          </p>
        </section>
      ) : null}

      <section className="flex flex-col gap-2">
        <h2 className="text-muted-brand font-mono text-xs tracking-widest uppercase">
          Twoje najbliższe zajęcia ({upcomingBookings.length})
        </h2>

        {upcomingBookings.length === 0 ? (
          <p className="text-muted-brand border-line bg-surface rounded-md border p-3 text-sm">
            Nie masz zapisanych zajęć. Wybierz termin w grafiku poniżej.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {upcomingBookings.map((booking) => {
              const free = canCancelFree(
                booking.session.startsAt,
                now,
                settings.freeCancellationHours,
              );
              return (
                <li key={booking.id} className="border-line bg-surface rounded-md border p-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <p className="text-text font-medium">{booking.session.name}</p>
                      <p className="text-muted-brand mt-0.5 font-mono text-xs">
                        {formatDayTime(booking.session.startsAt)} ·{" "}
                        {booking.session.trainer.user.name}
                        {booking.status === "WAITLIST" ? " · lista rezerwowa" : ""}
                      </p>
                    </div>
                    <span
                      className={`font-mono text-xs ${free ? "text-muted-brand" : "text-amber"}`}
                    >
                      {free ? "Odwołanie bezpłatne" : "Wejście przepadnie"}
                    </span>
                  </div>

                  <details className="mt-2">
                    <summary className="text-brand-red cursor-pointer text-sm">
                      Nie będę na tych zajęciach
                    </summary>
                    <form
                      action={reportSessionAbsenceAction}
                      className="border-line-soft mt-2 flex flex-col gap-2 border-t pt-2"
                    >
                      <input type="hidden" name="bookingId" value={booking.id} />
                      <input type="hidden" name="returnTo" value={returnTo} />
                      <select
                        name="reason"
                        required
                        className="border-line bg-surface-2 text-text w-40 rounded-md border px-2 py-1 text-base md:text-sm"
                      >
                        <option value="INJURY">Kontuzja</option>
                        <option value="OTHER">Inny powód</option>
                      </select>
                      <Textarea
                        name="note"
                        rows={2}
                        placeholder="Komentarz dla trenera (opcjonalnie)"
                        className="border-line bg-surface-2"
                      />
                      <Button type="submit" size="sm" variant="outline" className="self-start">
                        Odwołaj i podaj powód
                      </Button>
                    </form>
                  </details>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-muted-brand font-mono text-xs tracking-widest uppercase">
          Dłuższa przerwa
        </h2>

        {activeAbsenceReport ? (
          <div className="border-amber/40 bg-amber/5 rounded-md border p-3">
            <p className="text-text text-sm font-medium">
              Zgłoszona przerwa: {ABSENCE_REASON_LABEL[activeAbsenceReport.reason]}
              {activeAbsenceReport.expectedReturnAt
                ? ` do ${formatDate(new Date(activeAbsenceReport.expectedReturnAt.getTime() - 1))}`
                : ""}
            </p>
            {activeAbsenceReport.note ? (
              <p className="text-muted-brand mt-1 text-sm">{activeAbsenceReport.note}</p>
            ) : null}
            <p className="text-muted-brand mt-1 text-xs">
              Trener widzi powód i wie, dlaczego {activeMember.firstName} nie trenuje. Alerty o
              braku treningu są wstrzymane. Możesz normalnie zapisać się na zajęcia, jeśli wrócisz
              wcześniej.
            </p>
          </div>
        ) : (
          <form
            action={reportAbsencePeriodAction}
            className="border-line bg-surface flex flex-col gap-2 rounded-md border p-3"
          >
            <input type="hidden" name="memberId" value={activeMember.id} />
            <input type="hidden" name="returnTo" value={returnTo} />
            <p className="text-muted-brand text-xs">
              Odwołuje <b>wszystkie</b> zapisane zajęcia do wybranego dnia włącznie i informuje
              trenera o powodzie. Zajęcia odwołane na mniej niż {settings.freeCancellationHours}{" "}
              godz. przed startem kosztują wejście - tak samo jak zwykłe odwołanie.
            </p>

            <div className="flex flex-wrap gap-2">
              <select
                name="reason"
                required
                className="border-line bg-surface-2 text-text w-40 rounded-md border px-2 py-1 text-base md:text-sm"
              >
                <option value="INJURY">Kontuzja</option>
                <option value="OTHER">Inny powód</option>
              </select>
              <label className="flex items-center gap-2 text-sm">
                <span className="text-muted-brand">do dnia</span>
                <input
                  type="date"
                  name="until"
                  required
                  defaultValue={defaultAbsenceUntil}
                  className="border-line bg-surface-2 text-text rounded-md border px-2 py-1 text-base md:text-sm"
                />
              </label>
            </div>

            <Textarea
              name="note"
              rows={2}
              placeholder="Komentarz dla trenera (opcjonalnie)"
              className="border-line bg-surface-2"
            />

            {upcomingBookings.length > 0 ? (
              <p className="text-muted-brand text-xs">
                Masz teraz {upcomingBookings.length} zapisanych zajęć - te, które wypadną w
                zgłoszonym okresie, zostaną odwołane.
              </p>
            ) : null}

            <Button type="submit" size="sm" variant="outline" className="self-start">
              Zgłoś przerwę
            </Button>
          </form>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-muted-brand font-mono text-xs tracking-widest uppercase">
            Grafik · {weekLabel}
          </h2>
          <div className="flex items-center gap-2">
            {canGoBack ? (
              <Link
                href={linkWith({ tydzien: isoDate(prevWeekStart) })}
                className="border-line bg-surface text-text hover:text-brand-red rounded-md border px-3 py-1.5 font-mono text-xs uppercase"
              >
                ← Poprzedni
              </Link>
            ) : (
              <span className="border-line bg-surface-2 text-muted-brand rounded-md border px-3 py-1.5 font-mono text-xs uppercase opacity-50">
                ← Poprzedni
              </span>
            )}
            <Link
              href={linkWith({ tydzien: isoDate(nextWeekStart) })}
              className="border-line bg-surface text-text hover:text-brand-red rounded-md border px-3 py-1.5 font-mono text-xs uppercase"
            >
              Następny →
            </Link>
          </div>
        </div>

        {plannerSessions.length === 0 ? (
          <p className="text-muted-brand border-line bg-surface rounded-md border p-4 text-sm">
            W tym tygodniu nie ma zajęć spełniających wybrane filtry.
          </p>
        ) : (
          <WeekPlanner
            weekStart={weekStart}
            sessions={plannerSessions}
            memberId={activeMember.id}
            now={now}
            horizonEnd={horizonEnd}
            returnTo={returnTo}
          />
        )}

        <div className="text-muted-brand flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
          <span className="flex items-center gap-1.5">
            <span className="border-brand-red/60 bg-brand-red/10 inline-block size-3 rounded border" />
            Można się zapisać
          </span>
          <span className="flex items-center gap-1.5">
            <span className="border-jade/60 bg-jade/10 inline-block size-3 rounded border" />
            Jesteś zapisany
          </span>
          <span className="flex items-center gap-1.5">
            <span className="border-line bg-surface-2 inline-block size-3 rounded border" />
            Komplet albo poza oknem zapisów
          </span>
        </div>

        <p className="text-muted-brand text-xs">
          Zapisy są otwarte{" "}
          {describeHorizon(settings.bookingHorizonMode, settings.bookingHorizonDays)}. Zajęcia dalej
          w kalendarzu są widoczne, ale zapiszesz się na nie dopiero, gdy okno się przesunie.
        </p>
      </section>
    </div>
  );
}
