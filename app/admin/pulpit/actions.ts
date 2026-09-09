"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireRole } from "@/lib/auth/guard";
import { logActivity } from "@/lib/services/activity";
import { formatTime } from "@/lib/format";

// Wyciszenie alertu "zajęcia bez odbicia prowadzącego".
//
// Alert mówi: minął termin, a kodu nikt nie zeskanował. Powodów bywa kilka
// i większość nie jest awarią - trener prowadził i zapomniał, nikt nie przyszedł
// na zajęcia, tablet się nie włączył. Właściciel sprawdza to jednym telefonem
// i wtedy alert ma zniknąć, bo inaczej wisi do północy i uczy, żeby na niego
// nie patrzeć. A alert, na który się nie patrzy, nie jest alertem.
//
// Wyciszenie NIE zapisuje odbicia prowadzącego - zajęcia nadal nie mają śladu,
// kto je poprowadził, i tak ma zostać. Zapis odbicia wstecz zmieniałby dane,
// od których liczy się wypłata; to jest decyzja o innym ciężarze i idzie inną
// drogą (grafik zajęć).
//
// Ślad zostaje zawsze: kto wyciszył, kiedy i z jakim komentarzem. Bez tego
// "zajęcia bez trenera" dałoby się schować bez śladu, a to jest pytanie o to,
// kto realnie pracował.

const WROC = "/admin/pulpit#bez-odbicia";

export async function waiveTrainerCheckInAction(formData: FormData) {
  const session = await requireRole("ADMIN");
  const sessionId = String(formData.get("sessionId"));
  const note = String(formData.get("note") ?? "").trim();

  const zajecia = await prisma.session.findUniqueOrThrow({
    where: { id: sessionId },
    include: { location: true, trainer: { include: { user: true } } },
  });

  await prisma.$transaction(async (tx) => {
    await tx.session.update({
      where: { id: sessionId },
      data: {
        trainerCheckInWaivedAt: new Date(),
        trainerCheckInWaivedByUserId: session.user.id,
        trainerCheckInWaivedNote: note || null,
      },
    });

    await logActivity(tx, {
      actorUserId: session.user.id,
      action: "TRAINER_CHECKIN_WAIVED",
      summary:
        `Wyciszono alert o braku odbicia: "${zajecia.name}" ${formatTime(zajecia.startsAt)}, ` +
        `${zajecia.location.name}, w grafiku ${zajecia.trainer.user.name}` +
        (note ? ` - ${note}` : ""),
    });
  });

  revalidatePath("/admin/pulpit");
  redirect(WROC);
}

// Cofnięcie wyciszenia. Istnieje, bo wyciszenie to jedno kliknięcie i pomyłka
// przy nim jest tania - a alert, którego nie da się przywrócić, znika na dobre.
export async function undoTrainerCheckInWaiveAction(formData: FormData) {
  await requireRole("ADMIN");
  const sessionId = String(formData.get("sessionId"));

  await prisma.session.update({
    where: { id: sessionId },
    data: {
      trainerCheckInWaivedAt: null,
      trainerCheckInWaivedByUserId: null,
      trainerCheckInWaivedNote: null,
    },
  });

  revalidatePath("/admin/pulpit");
  redirect(WROC);
}
