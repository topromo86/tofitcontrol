import type { PrismaClient } from "@/app/generated/prisma/client";
import { calendarWeekday, todayInTimeZone, zonedTimeToUtc } from "@/lib/domain/time";
import {
  suggestSessions,
  type AttendedSession,
  type CandidateSession,
} from "@/lib/domain/suggestions";
import { isPassUsable } from "@/lib/domain/booking";
import { notify } from "@/lib/services/notification";
import { formatDayTime } from "@/lib/format";

export type SessionRemindersResult = {
  remindersSent: number;
  suggestionsSent: number;
};

const WARSAW = "Europe/Warsaw";

// Ile godzin przed zajęciami przypominamy. Doba to sensowny kompromis: dość
// wcześnie, żeby dało się przeorganizować dzień, i dość późno, żeby
// przypomnienie nie zdążyło wylecieć z głowy.
const REMINDER_LEAD_HOURS = 24;

const hourFormatter = new Intl.DateTimeFormat("pl-PL", {
  timeZone: WARSAW,
  hour: "2-digit",
  hour12: false,
});

// Dzień tygodnia i godzina w czasie klubu, nie w UTC. Numeracja dnia jest
// dowolna - istotne tylko, żeby historia i kandydaci liczyli ją tak samo,
// bo służy wyłącznie za klucz slotu.
function localParts(date: Date): { weekday: number; hour: number } {
  return {
    weekday: calendarWeekday(todayInTimeZone(date, WARSAW)),
    hour: Number(hourFormatter.format(date)),
  };
}

function categoryKey(s: { categoryId: string | null; name: string }): string {
  return s.categoryId ?? s.name;
}

// Codzienny job: przypomnienia o jutrzejszych zajęciach i propozycje zapisu
// na stały termin, na który klient jeszcze się nie zapisał.
//
// Obie wysyłki idą przez lib/services/notification.ts, więc respektują
// preferencje klienta i nie powtarzają się (NotificationLog).
export async function sessionReminders(
  prisma: PrismaClient,
  now: Date = new Date(),
): Promise<SessionRemindersResult> {
  let remindersSent = 0;
  let suggestionsSent = 0;

  // --- 1. Przypomnienia o zajęciach, na które klient jest zapisany ---------
  const windowEnd = new Date(now.getTime() + REMINDER_LEAD_HOURS * 3_600_000);

  const upcomingBookings = await prisma.booking.findMany({
    where: {
      status: "BOOKED",
      session: { startsAt: { gt: now, lte: windowEnd }, status: "SCHEDULED" },
    },
    include: {
      session: { include: { location: true } },
      member: { include: { user: true, guardianUser: true } },
    },
  });

  for (const booking of upcomingBookings) {
    // Powiadomienie idzie na konto klienta, a dla niepełnoletnich - do
    // opiekuna, bo to on planuje dzień dziecka.
    const target = booking.member.isMinor
      ? booking.member.guardianUser
      : (booking.member.user ?? booking.member.guardianUser);
    if (!target) continue;

    const result = await notify({
      userId: target.id,
      type: "SESSION_REMINDER",
      subjectId: booking.sessionId,
      title: "Jutro trening",
      body: `${booking.session.name}, ${formatDayTime(booking.session.startsAt)} - ${booking.session.location.name}.`,
    });
    if (result === "SENT") remindersSent++;
  }

  // --- 2. Propozycje zapisu na stały termin -------------------------------
  const today = todayInTimeZone(now);
  const horizonEnd = zonedTimeToUtc(today.year, today.month, today.day + 8, 0, 0);

  const candidateSessions = await prisma.session.findMany({
    where: {
      startsAt: { gt: now, lt: horizonEnd },
      status: "SCHEDULED",
      kind: "GROUP",
    },
    include: {
      location: true,
      bookings: { where: { status: "BOOKED" }, select: { id: true } },
    },
  });

  if (candidateSessions.length === 0) {
    return { remindersSent, suggestionsSent };
  }

  // isDemo: false - inaczej klub wysyłałby przypomnienia (a przy braku push
  // i e-maila płatne SMS-y) na konta demonstracyjne.
  const members = await prisma.member.findMany({
    where: { status: "ACTIVE", isDemo: false },
    include: { user: true, guardianUser: true },
  });

  for (const member of members) {
    const target = member.isMinor ? member.guardianUser : (member.user ?? member.guardianUser);
    if (!target) continue;

    // Bez ważnego karnetu zapis zostanie odrzucony, więc zachęta byłaby
    // zaproszeniem w ślepy zaułek. Przypomnienia o już zapisanych zajęciach
    // (wyżej) tego nie dotyczą - tam klient ma miejsce zarezerwowane.
    const activePass = await prisma.pass.findFirst({
      where: { memberId: member.id, status: "ACTIVE" },
      orderBy: { endsAt: "desc" },
    });
    if (!activePass || !isPassUsable(activePass, now)) continue;

    const attendances = await prisma.attendance.findMany({
      where: { memberId: member.id },
      include: { session: true },
      orderBy: { session: { startsAt: "desc" } },
      take: 100,
    });
    if (attendances.length === 0) continue;

    const history: AttendedSession[] = attendances.map((a) => ({
      startsAt: a.session.startsAt,
      ...localParts(a.session.startsAt),
      categoryKey: categoryKey(a.session),
      locationId: a.session.locationId,
    }));

    const booked = await prisma.booking.findMany({
      where: { memberId: member.id, status: { in: ["BOOKED", "WAITLIST"] } },
      select: { sessionId: true },
    });

    const candidates: CandidateSession[] = candidateSessions.map((s) => ({
      id: s.id,
      startsAt: s.startsAt,
      ...localParts(s.startsAt),
      categoryKey: categoryKey(s),
      locationId: s.locationId,
      freeSpots: s.capacity - s.bookings.length,
    }));

    // Jedna propozycja naraz. Powiadomienie z listą trzech terminów to już
    // nie podpowiedź, tylko nagabywanie.
    const [best] = suggestSessions({
      history,
      candidates,
      bookedSessionIds: booked.map((b) => b.sessionId),
      now,
      limit: 1,
    });
    if (!best) continue;

    const session = candidateSessions.find((s) => s.id === best.sessionId);
    if (!session) continue;

    const result = await notify({
      userId: target.id,
      type: "BOOKING_SUGGESTION",
      subjectId: best.sessionId,
      title: "Twój stały termin jest wolny",
      body: `${session.name}, ${formatDayTime(session.startsAt)} - ${session.location.name}. Zapisz się w aplikacji.`,
    });
    if (result === "SENT") suggestionsSent++;
  }

  return { remindersSent, suggestionsSent };
}
