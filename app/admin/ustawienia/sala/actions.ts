"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireRole } from "@/lib/auth/guard";
import { logActivity } from "@/lib/services/activity";

const MAX_QR_OPENS_MINUTES = 120;
const MAX_TRAINER_DEADLINE_MINUTES = 60;

export async function saveClassQrSettingsAction(formData: FormData) {
  const session = await requireRole("ADMIN");

  const opens = Number(formData.get("qrOpensMinutesBefore"));
  const deadline = Number(formData.get("trainerCheckInMinutesBefore"));

  if (!Number.isInteger(opens) || opens < 1 || opens > MAX_QR_OPENS_MINUTES) {
    redirect("/admin/ustawienia/sala?bladQr=1");
  }
  if (
    !Number.isInteger(deadline) ||
    deadline < 0 ||
    deadline > MAX_TRAINER_DEADLINE_MINUTES ||
    // Kod, który pojawia się PO terminie odbicia trenera, robi z terminu
    // fikcję - trener nie miałby czym się odbić na czas.
    deadline > opens
  ) {
    redirect("/admin/ustawienia/sala?bladQr=2");
  }

  await prisma.clubSettings.upsert({
    where: { id: "singleton" },
    update: { qrOpensMinutesBefore: opens, trainerCheckInMinutesBefore: deadline },
    create: {
      id: "singleton",
      qrOpensMinutesBefore: opens,
      trainerCheckInMinutesBefore: deadline,
    },
  });

  await logActivity(prisma, {
    actorUserId: session.user.id,
    action: "SETTINGS_UPDATED",
    summary: `Kod QR zajęć: pojawia się ${opens} min przed startem, trener odbija się najpóźniej ${deadline} min przed`,
  });

  revalidatePath("/admin/ustawienia/sala");
  revalidatePath("/kod-zajec");
  revalidatePath("/admin/pulpit");
  redirect("/admin/ustawienia/sala?zapisanoQr=1");
}
