"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { requireRole } from "@/lib/auth/guard";
import {
  canHardDelete,
  describeDeletionBlockers,
  groupItemsByTarget,
  resolveHandoverTargets,
  validateHandover,
} from "@/lib/domain/trainer-handover";
import { logActivity } from "@/lib/services/activity";
import { collectHandoverItems, eligibleHandoverTrainers } from "@/lib/services/trainer";

// Zdjęcie trzymamy w bazie, więc limit jest twardy i sprawdzany po stronie
// serwera - bez tego jeden plik z aparatu (kilkanaście MB) rozdąłby tabelę.
const MAX_PHOTO_BYTES = 800 * 1024;
const ALLOWED_PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"];
const MIN_PASSWORD_LENGTH = 8;

function backToList(error?: string): never {
  redirect(error ? `/admin/trenerzy?error=${encodeURIComponent(error)}` : "/admin/trenerzy");
}

function backToTrainer(trainerId: string, error?: string): never {
  redirect(
    error
      ? `/admin/trenerzy/${trainerId}?error=${encodeURIComponent(error)}`
      : `/admin/trenerzy/${trainerId}`,
  );
}

function backToHandover(trainerId: string, error: string): never {
  redirect(`/admin/trenerzy/${trainerId}/wyciszenie?error=${encodeURIComponent(error)}`);
}

// Wspólna obsługa przesłanego zdjęcia. Zwraca undefined, gdy pola nie ruszono
// (edycja bez zmiany zdjęcia), null gdy zaznaczono usunięcie.
async function readPhoto(
  formData: FormData,
): Promise<
  | { photo: Uint8Array<ArrayBuffer> | null; photoMimeType: string | null }
  | undefined
  | { error: string }
> {
  if (formData.get("removePhoto") === "on") {
    return { photo: null, photoMimeType: null };
  }

  const file = formData.get("photo");
  if (!(file instanceof File) || file.size === 0) return undefined;

  if (!ALLOWED_PHOTO_TYPES.includes(file.type)) {
    return { error: "Zdjęcie musi być w formacie JPG, PNG albo WEBP." };
  }
  if (file.size > MAX_PHOTO_BYTES) {
    return {
      error: `Zdjęcie jest za duże (${Math.round(file.size / 1024)} kB). Maksimum to ${MAX_PHOTO_BYTES / 1024} kB.`,
    };
  }

  return { photo: new Uint8Array(await file.arrayBuffer()), photoMimeType: file.type };
}

export async function createTrainerAction(formData: FormData) {
  const session = await requireRole("ADMIN");

  const name = String(formData.get("name") ?? "").trim();
  const email = String(formData.get("email") ?? "")
    .trim()
    .toLowerCase();
  const phone = String(formData.get("phone") ?? "").trim();
  const locationId = String(formData.get("locationId") ?? "");
  // Zestaw lokalizacji, w których trener pracuje. Domyślna jest zawsze wliczona,
  // nawet gdyby nie była zaznaczona wśród checkboxów.
  const workLocations = formData.getAll("workLocations").map(String);
  const locationIds = [...new Set([locationId, ...workLocations].filter(Boolean))];
  const hiredAtRaw = String(formData.get("hiredAt") ?? "");
  const password = String(formData.get("password") ?? "");
  const bio = String(formData.get("bio") ?? "").trim();

  if (name.length < 3) backToList("Podaj imię i nazwisko trenera.");
  if (!email.includes("@")) backToList("Podaj poprawny adres e-mail.");
  if (!locationId) backToList("Wybierz lokalizację domyślną.");
  if (password.length < MIN_PASSWORD_LENGTH) {
    backToList(`Hasło startowe musi mieć co najmniej ${MIN_PASSWORD_LENGTH} znaków.`);
  }

  const hiredAt = hiredAtRaw ? new Date(hiredAtRaw) : new Date();
  if (Number.isNaN(hiredAt.getTime())) backToList("Nieprawidłowa data zatrudnienia.");

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) backToList("Konto z tym adresem e-mail już istnieje.");

  const photo = await readPhoto(formData);
  if (photo && "error" in photo) backToList(photo.error);

  const passwordHash = await bcrypt.hash(password, 10);

  const trainer = await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        name,
        email,
        phone: phone || null,
        role: "TRAINER",
        passwordHash,
      },
    });

    const created = await tx.trainer.create({
      data: {
        userId: user.id,
        locationId,
        hiredAt,
        bio: bio || null,
        locations: { connect: locationIds.map((id) => ({ id })) },
        ...(photo && !("error" in photo) ? photo : {}),
      },
    });

    await logActivity(tx, {
      actorUserId: session.user.id,
      action: "TRAINER_CREATED",
      summary: `Dodano trenera ${name} (${email})`,
    });

    return created;
  });

  revalidatePath("/admin/trenerzy");
  revalidatePath("/app/trenerzy");
  backToTrainer(trainer.id);
}

export async function updateTrainerProfileAction(formData: FormData) {
  const session = await requireRole("ADMIN");

  const trainerId = String(formData.get("trainerId") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  const phone = String(formData.get("phone") ?? "").trim();
  const locationId = String(formData.get("locationId") ?? "");
  const workLocations = formData.getAll("workLocations").map(String);
  const locationIds = [...new Set([locationId, ...workLocations].filter(Boolean))];
  const bio = String(formData.get("bio") ?? "").trim();

  if (!trainerId) backToList("Brak identyfikatora trenera.");
  if (name.length < 3) backToTrainer(trainerId, "Podaj imię i nazwisko trenera.");
  if (!locationId) backToTrainer(trainerId, "Wybierz lokalizację domyślną.");

  const photo = await readPhoto(formData);
  if (photo && "error" in photo) backToTrainer(trainerId, photo.error);

  const trainer = await prisma.trainer.findUniqueOrThrow({
    where: { id: trainerId },
    include: { user: true },
  });

  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: trainer.userId },
      data: { name, phone: phone || null },
    });

    await tx.trainer.update({
      where: { id: trainerId },
      data: {
        locationId,
        bio: bio || null,
        locations: { set: locationIds.map((id) => ({ id })) },
        ...(photo && !("error" in photo) ? photo : {}),
      },
    });

    await logActivity(tx, {
      actorUserId: session.user.id,
      action: "TRAINER_UPDATED",
      summary: `Zaktualizowano wizytówkę trenera ${name}`,
    });
  });

  revalidatePath("/admin/trenerzy");
  revalidatePath(`/admin/trenerzy/${trainerId}`);
  revalidatePath("/app/trenerzy");
  backToTrainer(trainerId);
}

// Wyciszenie: trener znika z list wyboru i z widoku klientów, ale zostaje
// w bazie razem z całą historią. Warunek konieczny - wszystko, co prowadził,
// musi dostać nowego opiekuna, inaczej grupa przyjdzie na pustą salę.
export async function deactivateTrainerAction(formData: FormData) {
  const session = await requireRole("ADMIN");

  const trainerId = String(formData.get("trainerId") ?? "");
  if (!trainerId) backToList("Brak identyfikatora trenera.");

  const bulkTargetRaw = String(formData.get("bulkTarget") ?? "");
  const bulkTarget = bulkTargetRaw.length > 0 ? bulkTargetRaw : null;

  const perItem: Record<string, string> = {};
  for (const [key, value] of formData.entries()) {
    if (key.startsWith("target__") && typeof value === "string") perItem[key] = value;
  }

  const trainer = await prisma.trainer.findUniqueOrThrow({
    where: { id: trainerId },
    include: { user: true },
  });
  if (!trainer.active) backToTrainer(trainerId, "Ten trener jest już wyciszony.");

  const [items, eligible] = await Promise.all([
    collectHandoverItems(trainerId),
    eligibleHandoverTrainers(trainerId),
  ]);

  const targets = resolveHandoverTargets(items, bulkTarget, perItem);
  const invalid = validateHandover({
    items,
    targets,
    eligibleTrainerIds: eligible.map((t) => t.id),
    trainerBeingDeactivatedId: trainerId,
  });

  if (invalid) {
    if (invalid.code === "NO_TRAINERS_AVAILABLE") {
      backToHandover(
        trainerId,
        "Nie ma innego aktywnego trenera, który mógłby przejąć obowiązki. Najpierw dodaj trenera.",
      );
    }
    if (invalid.code === "MISSING_TARGET") {
      backToHandover(
        trainerId,
        `Nie wskazano trenera dla ${invalid.items.length} pozycji. Nic nie może zostać bez opiekuna.`,
      );
    }
    if (invalid.code === "TARGET_IS_SELF") {
      backToHandover(trainerId, "Nie można przepisać obowiązków na wyciszanego trenera.");
    }
    backToHandover(trainerId, "Wybrano trenera, który nie może przejąć obowiązków.");
  }

  const grouped = groupItemsByTarget(items, targets);
  const targetNames = new Map(eligible.map((t) => [t.id, t.user.name]));

  await prisma.$transaction(async (tx) => {
    for (const [targetId, targetItems] of grouped) {
      const memberIds = targetItems.filter((i) => i.kind === "MEMBER").map((i) => i.id);
      const sessionIds = targetItems.filter((i) => i.kind === "SESSION").map((i) => i.id);
      const templateIds = targetItems.filter((i) => i.kind === "TEMPLATE").map((i) => i.id);
      const taskIds = targetItems.filter((i) => i.kind === "TASK").map((i) => i.id);

      if (memberIds.length > 0) {
        await tx.member.updateMany({
          where: { id: { in: memberIds } },
          data: { ownerTrainerId: targetId },
        });
      }
      if (sessionIds.length > 0) {
        // Zastępstwo czyścimy w całości: po przepisaniu prowadzącym jest nowy
        // trener, a stare zastępstwo wskazywałoby na wyciszonego. Zerowanie
        // samego substituteTrainerId zostawiłoby osierocony status, przez
        // który runsSessionWhere nie zaliczyłby zajęć nikomu.
        await tx.session.updateMany({
          where: { id: { in: sessionIds } },
          data: {
            trainerId: targetId,
            substituteTrainerId: null,
            substituteStatus: null,
            substituteRequestedAt: null,
            substituteRespondedAt: null,
            substituteRequestedById: null,
            substituteByAdmin: false,
            substituteDeclineReason: null,
          },
        });
      }
      if (templateIds.length > 0) {
        await tx.classTemplate.updateMany({
          where: { id: { in: templateIds } },
          data: { trainerId: targetId },
        });
      }
      if (taskIds.length > 0) {
        await tx.retentionTask.updateMany({
          where: { id: { in: taskIds } },
          data: { trainerId: targetId },
        });
      }
    }

    // Okna dostępności na treningi indywidualne NIE są przepisywane - to
    // osobista dyspozycyjność konkretnej osoby, nie da się jej przekazać.
    // Wyłączamy je, żeby nikt nie zapisał się do wyciszonego trenera.
    await tx.availabilityWindow.updateMany({
      where: { trainerId },
      data: { active: false },
    });

    await tx.trainer.update({
      where: { id: trainerId },
      data: { active: false, deactivatedAt: new Date() },
    });

    const summaryParts = [...grouped.entries()].map(
      ([targetId, targetItems]) => `${targetItems.length} → ${targetNames.get(targetId) ?? "?"}`,
    );
    await logActivity(tx, {
      actorUserId: session.user.id,
      action: "TRAINER_DEACTIVATED",
      summary:
        `Wyciszono trenera ${trainer.user.name}` +
        (summaryParts.length > 0
          ? ` (przepisano: ${summaryParts.join(", ")})`
          : " (nic do przepisania)"),
    });
  });

  revalidatePath("/admin/trenerzy");
  revalidatePath("/admin/zajecia");
  revalidatePath("/app/trenerzy");
  revalidatePath("/app/indywidualne");
  backToTrainer(trainerId);
}

export async function reactivateTrainerAction(formData: FormData) {
  const session = await requireRole("ADMIN");
  const trainerId = String(formData.get("trainerId") ?? "");

  const trainer = await prisma.trainer.findUniqueOrThrow({
    where: { id: trainerId },
    include: { user: true },
  });

  await prisma.$transaction(async (tx) => {
    await tx.trainer.update({
      where: { id: trainerId },
      data: { active: true, deactivatedAt: null },
    });

    await logActivity(tx, {
      actorUserId: session.user.id,
      action: "TRAINER_REACTIVATED",
      summary: `Przywrócono trenera ${trainer.user.name}`,
    });
  });

  // Okna dostępności zostają wyłączone - trener ustawia je sobie na nowo,
  // bo stary grafik po przerwie i tak zwykle jest nieaktualny.
  revalidatePath("/admin/trenerzy");
  revalidatePath("/app/trenerzy");
  backToTrainer(trainerId);
}

// Twarde usunięcie - dozwolone tylko dla rekordu bez historii (pomyłka przy
// dodawaniu). W każdym innym przypadku właściwą operacją jest wyciszenie.
export async function deleteTrainerAction(formData: FormData) {
  const session = await requireRole("ADMIN");
  const trainerId = String(formData.get("trainerId") ?? "");

  const trainer = await prisma.trainer.findUniqueOrThrow({
    where: { id: trainerId },
    include: { user: true },
  });

  const [sessions, members, templates, tasks] = await Promise.all([
    prisma.session.count({ where: { trainerId } }),
    prisma.member.count({ where: { ownerTrainerId: trainerId } }),
    prisma.classTemplate.count({ where: { trainerId } }),
    prisma.retentionTask.count({ where: { trainerId } }),
  ]);

  const blockers = { sessions, members, templates, tasks };
  if (!canHardDelete(blockers)) {
    backToTrainer(
      trainerId,
      `Nie można usunąć - z tym trenerem powiązane są: ${describeDeletionBlockers(blockers).join(", ")}. To historia klubu (obecności, oceny, rozliczenia) i nie wolno jej skasować. Użyj wyciszenia.`,
    );
  }

  await prisma.$transaction(async (tx) => {
    await tx.availabilityWindow.deleteMany({ where: { trainerId } });
    await tx.trainerScore.deleteMany({ where: { trainerId } });
    await tx.trainer.delete({ where: { id: trainerId } });
    await tx.user.delete({ where: { id: trainer.userId } });

    await logActivity(tx, {
      actorUserId: session.user.id,
      action: "TRAINER_DELETED",
      summary: `Usunięto trenera ${trainer.user.name} (konto bez historii)`,
    });
  });

  revalidatePath("/admin/trenerzy");
  revalidatePath("/app/trenerzy");
  backToList();
}

// Nadanie / odebranie trenerowi dostępu do modułu leadów (CRM). Admin decyduje,
// kto z kadry moze widziec i obdzwaniac leady z reklam.
export async function toggleLeadAccessAction(formData: FormData) {
  const session = await requireRole("ADMIN");
  const trainerId = String(formData.get("trainerId") ?? "");

  const trainer = await prisma.trainer.findUniqueOrThrow({
    where: { id: trainerId },
    include: { user: true },
  });
  const next = !trainer.user.canAccessLeads;

  await prisma.user.update({ where: { id: trainer.userId }, data: { canAccessLeads: next } });
  await logActivity(prisma, {
    actorUserId: session.user.id,
    action: "TRAINER_UPDATED",
    summary: `${next ? "Nadano" : "Odebrano"} dostęp do leadów: ${trainer.user.name}`,
  });

  revalidatePath(`/admin/trenerzy/${trainerId}`);
  backToTrainer(trainerId);
}

// Zawodnik i badania po stronie kadry - trener tez startuje w zawodach.
// Ta sama regula co przy klubowiczu (lib/domain/medical-exam.ts), inny model.
export async function saveTrainerCompetitorAction(formData: FormData) {
  const session = await requireRole("ADMIN");
  const trainerId = String(formData.get("trainerId") ?? "");
  const isCompetitor = formData.get("isCompetitor") === "tak";
  const raw = String(formData.get("medicalExamValidUntil") ?? "").trim();

  const wroc = (params: string) => redirect(`/admin/trenerzy/${trainerId}?${params}`);

  let validUntil: Date | null = null;
  if (raw) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      wroc(`blad=${encodeURIComponent("Podaj poprawną datę ważności badań.")}`);
    }
    validUntil = new Date(`${raw}T00:00:00.000Z`);
    if (Number.isNaN(validUntil.getTime())) {
      wroc(`blad=${encodeURIComponent("Podaj poprawną datę ważności badań.")}`);
    }
  }

  const przed = await prisma.trainer.findUniqueOrThrow({
    where: { id: trainerId },
    select: {
      isCompetitor: true,
      medicalExamValidUntil: true,
      user: { select: { name: true } },
    },
  });

  await prisma.$transaction(async (tx) => {
    await tx.trainer.update({
      where: { id: trainerId },
      data: { isCompetitor, medicalExamValidUntil: validUntil },
    });

    const bylo = przed.medicalExamValidUntil?.toISOString().slice(0, 10) ?? "brak";
    const jest = validUntil?.toISOString().slice(0, 10) ?? "brak";
    if (przed.isCompetitor !== isCompetitor) {
      await logActivity(tx, {
        actorUserId: session.user.id,
        action: "COMPETITOR_CHANGED",
        summary: `${przed.user.name} (kadra): ${isCompetitor ? "oznaczony jako zawodnik" : "zdjęto oznaczenie zawodnika"}`,
      });
    }
    if (bylo !== jest) {
      await logActivity(tx, {
        actorUserId: session.user.id,
        action: "MEDICAL_EXAM_SET",
        summary: `${przed.user.name} (kadra): badania ważne do ${jest} (było: ${bylo})`,
      });
    }
  });

  revalidatePath(`/admin/trenerzy/${trainerId}`);
  wroc(`info=${encodeURIComponent("Zapisano dane zawodnika.")}`);
}
