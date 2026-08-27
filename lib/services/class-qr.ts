import "server-only";

import { randomBytes } from "node:crypto";
import { prisma } from "@/lib/prisma";
import {
  checkScanTime,
  judgeTrainerScan,
  qrWindow,
  type ScanRejection,
} from "@/lib/domain/class-qr";
import { effectiveTrainerId } from "@/lib/domain/substitute";
import { formatDayTime, formatTime } from "@/lib/format";
import { alertAdmins } from "@/lib/services/admin-alert";
import { logActivity } from "@/lib/services/activity";
import { decrementPassEntryIfLimited } from "@/lib/services/pass";
import { markJoinedIfNeeded } from "@/lib/services/member";
import { verifyRotatingCode } from "@/lib/services/rotating-code";
import { getClubSettings } from "@/lib/services/settings";

// Odbicia na zajęciach. Dwie drogi, jedna reguła:
//
// 1. Prowadzący pokazuje swój kod rotacyjny kamerze kiosku (30 s ważności).
//    To jest jedyna droga, która DOWODZI obecności na sali - kod trzeba
//    fizycznie pokazać urządzeniu klubu i trafić w 30-sekundowe okno.
// 2. Klubowicz skanuje telefonem kod zajęć z ekranu kiosku. Wygodne i szybkie
//    dla dwudziestu osób naraz; prawdziwym zapisem i tak jest liczba, którą po
//    zajęciach zatwierdza trener.

function newToken(): string {
  return randomBytes(16).toString("base64url");
}

// Kod zajęć. Losujemy leniwie: dopóki nikt nie wyświetlił kodu, zajęcia go nie
// potrzebują. Wyścig dwóch tabletów rozstrzyga baza (qrToken jest unikalny),
// więc przy kolizji po prostu czytamy zapisany kod ponownie.
export async function getOrCreateSessionQrToken(sessionId: string): Promise<string> {
  const existing = await prisma.session.findUniqueOrThrow({
    where: { id: sessionId },
    select: { qrToken: true },
  });
  if (existing.qrToken) return existing.qrToken;

  const token = newToken();
  const updated = await prisma.session.update({
    where: { id: sessionId },
    data: { qrToken: token },
    select: { qrToken: true },
  });
  return updated.qrToken ?? token;
}

export type ScanOutcome =
  | { ok: false; reason: ScanRejection }
  | {
      ok: true;
      role: "TRAINER";
      late: boolean;
      // false = odbił się trener, który tych zajęć nie prowadzi i nie ma
      // potwierdzonego zastępstwa. Odbicie zapisujemy (ktoś te zajęcia
      // poprowadził), ale kiosk mówi o tym wprost, a właściciel dostaje alert.
      assigned: boolean;
      leadTrainerName: string;
      sessionName: string;
      startsAt: Date;
    }
  | { ok: true; role: "MEMBER"; memberName: string; sessionName: string; startsAt: Date };

const SESSION_INCLUDE = {
  trainer: { include: { user: true } },
  substituteTrainer: { include: { user: true } },
} as const;

type SessionWithTrainers = Awaited<
  ReturnType<typeof prisma.session.findFirstOrThrow<{ include: typeof SESSION_INCLUDE }>>
>;

// Konto prowadzącego te zajęcia - z uwzględnieniem przyjętego zastępstwa.
function leadTrainerUserId(session: SessionWithTrainers): string {
  return effectiveTrainerId(session) === session.trainerId
    ? session.trainer.userId
    : (session.substituteTrainer?.userId ?? session.trainer.userId);
}

// Nazwisko prowadzącego - do komunikatu na kiosku i do alertu.
function leadTrainerName(session: SessionWithTrainers): string {
  return effectiveTrainerId(session) === session.trainerId
    ? session.trainer.user.name
    : (session.substituteTrainer?.user.name ?? session.trainer.user.name);
}

// Właściciel dowiaduje się DWIEMA drogami, bo mają różne wady: push przychodzi
// od razu, ale bywa niedostarczony; wpis w historii nie przychodzi nigdzie, ale
// nie da się go przegapić po fakcie. Alert o cudzym odbiciu musi przeżyć jedno
// i drugie - to jest zdarzenie, po którym idą pieniądze (zastępstwo trzeba
// wyklikać, żeby wynagrodzenie poszło do właściwej osoby).
async function alertUnassignedTrainer(input: {
  session: SessionWithTrainers;
  scannerUserId: string;
  scannerName: string;
  at: Date;
}): Promise<void> {
  const kiedy = formatDayTime(input.session.startsAt);
  const body =
    `${input.scannerName} odbił(a) się o ${formatTime(input.at)} jako prowadzący na ` +
    `"${input.session.name}" (${kiedy}). ` +
    `W grafiku te zajęcia prowadzi ${leadTrainerName(input.session)}, a zastępstwo nie jest ` +
    `potwierdzone. Jeśli to zamiana, wpisz ją w panelu - inaczej wynagrodzenie policzy się ` +
    `dla osoby z grafiku.`;

  // Ślad w historii idzie pierwszy i osobno od powiadomień: gdyby push albo
  // poczta padły, zdarzenie i tak zostaje w /admin/aktywnosc.
  try {
    await logActivity(prisma, {
      actorUserId: input.scannerUserId,
      action: "TRAINER_CHECKIN_MISMATCH",
      summary: body,
    });
  } catch {
    // Nieudany zapis do historii nie może cofnąć odbicia na sali.
  }

  try {
    await alertAdmins({ title: "Odbicie trenera bez przypisania", body, alsoEmail: true });
  } catch {
    // jw. - powiadomienie jest ważne, ale nie ważniejsze niż sama obecność.
  }
}

// Odbicie konkretnej osoby na konkretnych zajęciach. Sedno całego modułu -
// obie drogi (kod zajęć z ekranu, kod osobisty z kamery) kończą się tutaj,
// więc reguły nie mają jak się rozjechać.
async function checkInUserToSession(input: {
  session: SessionWithTrainers;
  userId: string;
  now: Date;
  trainerCheckInMinutesBefore: number;
}): Promise<ScanOutcome> {
  const { session, userId, now } = input;
  const leadUserId = leadTrainerUserId(session);
  const deadline = new Date(
    session.startsAt.getTime() - input.trainerCheckInMinutesBefore * 60_000,
  );

  // Odbicia sprzed wprowadzenia kolumny `trainerCheckedInUserId` mają samą
  // godzinę, bez konta. Nie wiadomo o nich nic złego, więc czytamy je jako
  // odbicie prowadzącego - inaczej stary wiersz wyglądałby jak rozjazd.
  const checkedInUserId =
    session.trainerCheckedInUserId ?? (session.trainerCheckedInAt ? leadUserId : null);

  async function zapiszOdbicieProwadzacego(assigned: boolean): Promise<ScanOutcome> {
    await prisma.session.update({
      where: { id: session.id },
      data: { trainerCheckedInAt: now, trainerCheckedInUserId: userId },
    });
    return {
      ok: true,
      role: "TRAINER",
      late: now > deadline,
      assigned,
      leadTrainerName: leadTrainerName(session),
      sessionName: session.name,
      startsAt: session.startsAt,
    };
  }

  if (leadUserId === userId) {
    // Powtórka tej samej osoby przed kamerą - nic nowego.
    if (checkedInUserId === userId) {
      return { ok: false, reason: "ALREADY_CHECKED_IN" };
    }
    // Odbicie prowadzącego NADPISUJE wcześniejsze odbicie kogoś innego.
    // Jeśli kolega odbił się o 17:50 jako zastępstwo, a prowadzący jednak
    // przyszedł, to on prowadzi te zajęcia - i to jego godzina ma być
    // w bazie. Ślad po tamtym odbiciu zostaje w historii aktywności.
    return zapiszOdbicieProwadzacego(true);
  }

  // Klubowicz: odbić może się tylko ten, kto ma zapis. Konto opiekuna odbija
  // dziecko, które ma zapis - stąd szukamy po kartotekach dostępnych z konta.
  const booking = await prisma.booking.findFirst({
    where: {
      sessionId: session.id,
      status: { in: ["BOOKED", "ATTENDED"] },
      member: { OR: [{ user: { id: userId } }, { guardianUserId: userId }] },
    },
    include: { member: true },
  });
  // Bez zapisu. Zanim odmówimy, sprawdzamy najczęstszy przypadek z sali: to
  // nie jest obcy człowiek, tylko trener, który wziął zajęcia za kolegę
  // i nikt nie zdążył wyklikać zastępstwa.
  if (!booking) {
    const scanner = await prisma.trainer.findUnique({
      where: { userId },
      select: { id: true, user: { select: { name: true } } },
    });
    const verdict = judgeTrainerScan({
      leadUserId,
      scannerUserId: userId,
      scannerIsTrainer: scanner !== null,
      trainerCheckedInUserId: checkedInUserId,
    });

    if (verdict === "STAND_IN" && scanner) {
      const outcome = await zapiszOdbicieProwadzacego(false);
      await alertUnassignedTrainer({
        session,
        scannerUserId: userId,
        scannerName: scanner.user.name,
        at: now,
      });
      return outcome;
    }
    // Prowadzący (albo inny zastępca) już się odbił, a ten trener nie ma tu
    // zapisu - nie ma czego zastępować i nie ma o czym alarmować.
    if (verdict === "CHECK_IN_TAKEN") return { ok: false, reason: "LEAD_ALREADY_CHECKED_IN" };

    return { ok: false, reason: "NOT_ON_LIST" };
  }

  const already = await prisma.attendance.findUnique({
    where: { sessionId_memberId: { sessionId: session.id, memberId: booking.memberId } },
  });
  if (already) return { ok: false, reason: "ALREADY_CHECKED_IN" };

  await prisma.$transaction(async (tx) => {
    await tx.attendance.create({
      // Godzina skanu, nie godzina zapisu do bazy. Przy odbiciu dopisanym
      // z kolejki offline te dwie różnią się o cały trening.
      data: {
        sessionId: session.id,
        memberId: booking.memberId,
        checkedInAt: now,
        method: "QR",
      },
    });
    await tx.booking.update({ where: { id: booking.id }, data: { status: "ATTENDED" } });
    // Wejście schodzi z karnetu pasującego do rodzaju zajęć - ta sama reguła
    // co przy każdym innym odbiciu obecności.
    await decrementPassEntryIfLimited(tx, booking.memberId, session.kind);
    await markJoinedIfNeeded(tx, booking.memberId, now);
  });

  return {
    ok: true,
    role: "MEMBER",
    memberName: `${booking.member.firstName} ${booking.member.lastName}`,
    sessionName: session.name,
    startsAt: session.startsAt,
  };
}

// Droga 1: klubowicz zeskanował telefonem kod zajęć z ekranu kiosku.
export async function scanClassQr(input: {
  token: string;
  userId: string;
  now?: Date;
}): Promise<ScanOutcome> {
  const now = input.now ?? new Date();
  const settings = await getClubSettings();

  const session = await prisma.session.findUnique({
    where: { qrToken: input.token },
    include: SESSION_INCLUDE,
  });
  if (!session) return { ok: false, reason: "UNKNOWN_CODE" };

  const timeError = checkScanTime(session, now, settings.qrOpensMinutesBefore);
  if (timeError) return { ok: false, reason: timeError };

  return checkInUserToSession({
    session,
    userId: input.userId,
    now,
    trainerCheckInMinutesBefore: settings.trainerCheckInMinutesBefore,
  });
}

export type StationScanOutcome =
  ScanOutcome | { ok: false; reason: "CODE_EXPIRED" | "CODE_INVALID" | "NO_OPEN_CLASS" };

// Droga 2: kiosk zeskanował osobisty kod rotacyjny. Kod mówi, KTO stoi przed
// kamerą; zajęcia wybieramy z grafiku tej sali.
export async function checkInAtStation(input: {
  code: string;
  locationId: string;
  now?: Date;
}): Promise<StationScanOutcome> {
  const now = input.now ?? new Date();
  const settings = await getClubSettings();

  const verdict = verifyRotatingCode(input.code, now);
  if (!verdict.ok) {
    // Wygasły kod to najczęstszy przypadek przy kamerze (ktoś pokazał zrzut
    // ekranu albo trzymał telefon zbyt długo) - ma własny komunikat.
    return { ok: false, reason: verdict.reason === "EXPIRED" ? "CODE_EXPIRED" : "CODE_INVALID" };
  }

  const candidates = await prisma.session.findMany({
    where: {
      locationId: input.locationId,
      status: "SCHEDULED",
      endsAt: { gte: now },
      startsAt: { lte: new Date(now.getTime() + 12 * 3_600_000) },
    },
    include: SESSION_INCLUDE,
    orderBy: { startsAt: "asc" },
  });

  const open = candidates.filter((s) => {
    const window = qrWindow(s, settings.qrOpensMinutesBefore);
    return now >= window.opensAt && now <= window.closesAt;
  });
  if (open.length === 0) return { ok: false, reason: "NO_OPEN_CLASS" };

  // W sali potrafią wypaść dwie grupy pod rząd. Wybieramy te zajęcia, które
  // realnie dotyczą tej osoby - prowadzi je albo ma na nie zapis. Dopiero przy
  // remisie decyduje kolejność w grafiku.
  const own = await Promise.all(
    open.map(async (s) => {
      if (leadTrainerUserId(s) === verdict.userId) return s;
      const booking = await prisma.booking.findFirst({
        where: {
          sessionId: s.id,
          status: { in: ["BOOKED", "ATTENDED"] },
          member: { OR: [{ user: { id: verdict.userId } }, { guardianUserId: verdict.userId }] },
        },
        select: { id: true },
      });
      return booking ? s : null;
    }),
  );

  const session = own.find((s) => s !== null) ?? null;
  if (session) {
    return checkInUserToSession({
      session,
      userId: verdict.userId,
      now,
      trainerCheckInMinutesBefore: settings.trainerCheckInMinutesBefore,
    });
  }

  // Nikt tu na tę osobę nie czeka: nie prowadzi żadnych z otwartych zajęć i nie
  // ma na nie zapisu. Zanim odmówimy, sprawdzamy przypadek, który na sali jest
  // codziennością: to trener, który wziął zajęcia za kolegę, a zastępstwa nikt
  // nie zdążył wyklikać. Bez tego kiosk mówił mu "nie masz zapisu", zajęcia
  // zostawały bez śladu prowadzącego, a właściciel nie dowiadywał się o niczym.
  const scanner = await prisma.trainer.findUnique({
    where: { userId: verdict.userId },
    select: { id: true },
  });
  if (!scanner) return { ok: false, reason: "NOT_ON_LIST" };

  // Zajęcia, na których nikt jeszcze nie odbił się jako prowadzący. Gdy takich
  // nie ma, nie ma też czego zastępować - i nie ma o czym alarmować.
  const standIn = open.find((s) => s.trainerCheckedInAt === null) ?? null;
  if (!standIn) return { ok: false, reason: "LEAD_ALREADY_CHECKED_IN" };

  return checkInUserToSession({
    session: standIn,
    userId: verdict.userId,
    now,
    trainerCheckInMinutesBefore: settings.trainerCheckInMinutesBefore,
  });
}
