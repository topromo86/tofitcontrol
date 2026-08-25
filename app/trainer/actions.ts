"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireOwnsSession, requireTrainerSelf } from "@/lib/auth/guard";
import {
  awaitsResponseFrom,
  canDecline,
  validateAssignment,
  type AssignSubstituteError,
} from "@/lib/domain/substitute";
import { confirmSessionAttendance, markManualAttendance } from "@/lib/services/attendance";
import { confirmConsentDelivery } from "@/lib/services/consent-delivery";
import { logActivity } from "@/lib/services/activity";
import {
  notifyAdminsAboutSubstitute,
  notifySubstituteRequested,
  notifyUser,
} from "@/lib/services/substitute";
import { formatDayTime } from "@/lib/format";

const ASSIGN_ERROR_MESSAGE: Record<AssignSubstituteError, string> = {
  SAME_TRAINER: "Nie możesz wyznaczyć samego siebie na zastępstwo.",
  SESSION_CANCELLED: "Te zajęcia są odwołane.",
  SESSION_STARTED: "Te zajęcia już się zaczęły.",
  ALREADY_ACCEPTED:
    "Zastępstwo jest już potwierdzone. Zmianę może wprowadzić wyłącznie właściciel.",
};

// Wycofanie prośby o zastępstwo. Osobno, bo trzeba powiadomić osobę, która
// zdążyła je już potwierdzić - inaczej przyszłaby na zajęcia niepotrzebnie.
async function clearSubstitute(input: {
  sessionId: string;
  actorUserId: string;
  actorName: string;
  session: {
    name: string;
    startsAt: Date;
    substituteTrainerId: string | null;
    substituteStatus: "PENDING" | "ACCEPTED" | "DECLINED" | null;
  };
}): Promise<void> {
  if (!input.session.substituteTrainerId) return;

  const previous = await prisma.trainer.findUnique({
    where: { id: input.session.substituteTrainerId },
    select: { userId: true, user: { select: { name: true } } },
  });

  await prisma.$transaction(async (tx) => {
    await tx.session.update({
      where: { id: input.sessionId },
      data: {
        substituteTrainerId: null,
        substituteStatus: null,
        substituteRequestedAt: null,
        substituteRespondedAt: null,
        substituteRequestedById: null,
        substituteByAdmin: false,
        substituteDeclineReason: null,
      },
    });

    await logActivity(tx, {
      actorUserId: input.actorUserId,
      action: "SUBSTITUTE_CANCELLED",
      summary: `Wycofano zastępstwo (${previous?.user.name ?? "trener"}) na "${input.session.name}" ${formatDayTime(input.session.startsAt)}`,
    });
  });

  const notice = `Zastępstwo na "${input.session.name}" ${formatDayTime(input.session.startsAt)} zostało wycofane przez ${input.actorName}.`;
  if (previous) await notifyUser(previous.userId, "Zastępstwo wycofane", notice);
  await notifyAdminsAboutSubstitute({ title: "Zastępstwo wycofane", body: notice });
}

// Ręczne uzupełnienie obecności przez trenera - method: MANUAL, wykluczone
// z KPI (CLAUDE.md reguła 2: trener nie ocenia sam siebie własnymi wpisami).
//
// Sam zapis siedzi w lib/services/attendance.ts, bo tą samą drogą idą
// obecności zaznaczone bez łącza i dopisane po powrocie sieci.
export async function markManualAttendanceAction(formData: FormData) {
  const { trainer } = await requireTrainerSelf();
  const bookingId = String(formData.get("bookingId"));

  const booking = await prisma.booking.findUniqueOrThrow({
    where: { id: bookingId },
    select: { sessionId: true },
  });
  await requireOwnsSession(booking.sessionId);

  await markManualAttendance({ bookingId, byUserId: trainer.userId, at: new Date() });

  revalidatePath("/trainer");
}

// Odwołanie całych zajęć: wszystkie rezerwacje -> CANCELLED, żadne wejście
// nie przepada (SPEC.md sekcja 2 - to nie jest wina klienta).
export async function cancelSessionAction(formData: FormData) {
  const sessionId = String(formData.get("sessionId"));
  const reason = String(formData.get("reason") ?? "").trim();
  await requireOwnsSession(sessionId);

  if (reason.length < 3) {
    throw new Error("Podaj powód odwołania zajęć.");
  }

  const now = new Date();
  await prisma.$transaction(async (tx) => {
    await tx.session.update({
      where: { id: sessionId },
      data: { status: "CANCELLED", cancelledReason: reason },
    });
    await tx.booking.updateMany({
      where: { sessionId, status: { in: ["BOOKED", "WAITLIST"] } },
      data: { status: "CANCELLED", cancelledAt: now, waitlistPosition: null },
    });
  });

  revalidatePath("/trainer");
}

// Zastępstwo: inny trener przejmuje prowadzenie zajęć - ale dopiero po tym,
// jak sam to potwierdzi. Do tego czasu prowadzącym zostaje trener pierwotny
// (lib/domain/substitute.ts), więc zajęcia nigdy nie zostają bez nikogo.
export async function assignSubstituteAction(formData: FormData) {
  const { session: authSession } = await requireTrainerSelf();
  const sessionId = String(formData.get("sessionId"));
  const substituteTrainerId = String(formData.get("substituteTrainerId"));
  await requireOwnsSession(sessionId);

  const target = await prisma.session.findUniqueOrThrow({
    where: { id: sessionId },
    select: {
      name: true,
      startsAt: true,
      status: true,
      trainerId: true,
      substituteStatus: true,
      substituteTrainerId: true,
    },
  });

  // Wybór pustej wartości = wycofanie prośby. Świadomie dopuszczamy to także
  // po potwierdzeniu: trener odbiera wtedy własne zajęcia, więc nikt nie
  // zostaje bez opieki. Blokujemy natomiast podmianę potwierdzonego zastępcy
  // na kogoś trzeciego (validateAssignment: ALREADY_ACCEPTED) - to już
  // przestawianie cudzych zobowiązań.
  if (!substituteTrainerId) {
    await clearSubstitute({
      sessionId,
      actorUserId: authSession.user.id,
      actorName: authSession.user.name ?? "Trener",
      session: target,
    });
    revalidatePath("/trainer");
    return;
  }

  const check = validateAssignment({
    trainerId: target.trainerId,
    candidateId: substituteTrainerId,
    status: target.substituteStatus,
    sessionStatus: target.status,
    startsAt: target.startsAt,
    now: new Date(),
    byAdmin: false,
  });
  if (!check.ok) {
    redirect(`/trainer?error=${encodeURIComponent(ASSIGN_ERROR_MESSAGE[check.error])}`);
  }

  const substitute = await prisma.trainer.findUniqueOrThrow({
    where: { id: substituteTrainerId },
    select: { userId: true, user: { select: { name: true } } },
  });

  await prisma.$transaction(async (tx) => {
    await tx.session.update({
      where: { id: sessionId },
      data: {
        substituteTrainerId,
        substituteStatus: "PENDING",
        substituteRequestedAt: new Date(),
        substituteRespondedAt: null,
        substituteRequestedById: authSession.user.id,
        substituteByAdmin: false,
        substituteDeclineReason: null,
      },
    });

    await logActivity(tx, {
      actorUserId: authSession.user.id,
      action: "SUBSTITUTE_REQUESTED",
      summary: `Poproszono ${substitute.user.name} o zastępstwo na "${target.name}" ${formatDayTime(target.startsAt)} - czeka na potwierdzenie`,
    });
  });

  // Powiadomienia poza transakcją: nieudany push nie może cofnąć zapisu.
  await notifySubstituteRequested({
    substituteUserId: substitute.userId,
    session: { id: sessionId, name: target.name, startsAt: target.startsAt },
    requestedByName: authSession.user.name ?? "Trener",
    byAdmin: false,
  });
  await notifyAdminsAboutSubstitute({
    title: "Zgłoszono zastępstwo",
    body: `${authSession.user.name ?? "Trener"} poprosił(a) ${substitute.user.name} o zastępstwo na "${target.name}" ${formatDayTime(target.startsAt)}.`,
  });

  revalidatePath("/trainer");
  revalidatePath("/admin/zastepstwa");
}

// Odpowiedź zastępcy. Polecenia admina nie da się odrzucić - zastępca je
// przyjmuje do wiadomości (lib/domain/substitute.ts: canDecline).
export async function respondToSubstituteAction(formData: FormData) {
  const { session: authSession, trainer } = await requireTrainerSelf();
  const sessionId = String(formData.get("sessionId"));
  const accept = String(formData.get("decision")) === "ACCEPT";
  const reason = String(formData.get("reason") ?? "").trim();

  const target = await prisma.session.findUniqueOrThrow({
    where: { id: sessionId },
    select: {
      name: true,
      startsAt: true,
      substituteTrainerId: true,
      substituteStatus: true,
      substituteByAdmin: true,
      substituteRequestedById: true,
      trainer: { select: { userId: true, user: { select: { name: true } } } },
    },
  });

  // Odpowiadać może wyłącznie wskazany zastępca i wyłącznie dopóki czeka.
  if (!awaitsResponseFrom(target, trainer.id)) {
    redirect(
      `/trainer?error=${encodeURIComponent("To zastępstwo nie czeka już na Twoją odpowiedź.")}`,
    );
  }
  if (!accept && !canDecline(target)) {
    redirect(
      `/trainer?error=${encodeURIComponent("Zastępstwa wyznaczonego przez właściciela nie można odrzucić - zgłoś sprawę bezpośrednio.")}`,
    );
  }

  const myName = authSession.user.name ?? "Trener";

  await prisma.$transaction(async (tx) => {
    await tx.session.update({
      where: { id: sessionId },
      data: accept
        ? { substituteStatus: "ACCEPTED", substituteRespondedAt: new Date() }
        : {
            substituteStatus: "DECLINED",
            substituteRespondedAt: new Date(),
            substituteDeclineReason: reason || null,
          },
    });

    await logActivity(tx, {
      actorUserId: authSession.user.id,
      action: accept ? "SUBSTITUTE_ACCEPTED" : "SUBSTITUTE_DECLINED",
      summary: accept
        ? `${myName} potwierdził(a) zastępstwo na "${target.name}" ${formatDayTime(target.startsAt)}`
        : `${myName} odrzucił(a) zastępstwo na "${target.name}" ${formatDayTime(target.startsAt)}${reason ? ` - powód: ${reason}` : ""}`,
    });
  });

  // Odmowa wraca do trenera pierwotnego - musi wiedzieć, że zajęcia znów są
  // jego, inaczej nikt by się nie pojawił.
  const notice = accept
    ? `${myName} potwierdził(a) zastępstwo na "${target.name}" ${formatDayTime(target.startsAt)}.`
    : `${myName} ODRZUCIŁ(A) zastępstwo na "${target.name}" ${formatDayTime(target.startsAt)}. Zajęcia wracają do trenera pierwotnego.${reason ? ` Powód: ${reason}` : ""}`;

  if (target.substituteRequestedById) {
    await notifyUser(
      target.substituteRequestedById,
      accept ? "Zastępstwo potwierdzone" : "Zastępstwo odrzucone",
      notice,
    );
  }
  await notifyAdminsAboutSubstitute({
    title: accept ? "Zastępstwo potwierdzone" : "Zastępstwo ODRZUCONE",
    body: notice,
  });

  revalidatePath("/trainer");
  revalidatePath("/admin/zastepstwa");
}

// Potwierdzenie odbioru podpisanych zgód od klienta - zdejmuje bramę "tylko
// pierwsze zajęcia". Trener to zaufany personel, więc potwierdza dowolnego
// klienta obecnego na jego zajęciach (autoryzacja: rola TRAINER).
export async function confirmConsentDeliveryAction(formData: FormData) {
  const { session } = await requireTrainerSelf();
  const memberId = String(formData.get("memberId"));

  await confirmConsentDelivery({ memberId, byUserId: session.user.id });

  revalidatePath("/trainer");
  revalidatePath("/trainer/podopieczni");
}

// Potwierdzenie listy obecności przez prowadzącego.
//
// Odbicia kodem QR dają listę wstępną - po zajęciach trener przelicza salę
// i zatwierdza liczbę, którą realnie policzył. Zapisujemy jego liczbę OBOK
// liczby odbić, bo rozjazd między nimi jest właśnie tą informacją, dla której
// to robimy: ktoś przyszedł bez odbicia albo odbił się i wyszedł.
export async function confirmAttendanceAction(formData: FormData) {
  const { session } = await requireTrainerSelf();
  const sessionId = String(formData.get("sessionId") ?? "");
  await requireOwnsSession(sessionId);

  const result = await confirmSessionAttendance({
    sessionId,
    byUserId: session.user.id,
    rawCount: String(formData.get("count") ?? ""),
    at: new Date(),
  });
  if (!result.ok) redirect("/trainer?blad=liczba");

  revalidatePath("/trainer");
  revalidatePath("/admin/pulpit");
  redirect("/trainer?potwierdzono=1");
}
