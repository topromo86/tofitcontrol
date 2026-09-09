"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireLeadAccess } from "@/lib/auth/guard";
import { zonedTimeToUtc } from "@/lib/domain/time";
import {
  buildWelcomeSms,
  LEAD_STATUS_LABEL,
  LEAD_STATUS_ORDER,
  parseLeadPhone,
  splitFullName,
  buildWelcomeEmail,
  parseWelcomeChannel,
  missingWelcomeContact,
} from "@/lib/domain/lead-import";
import { calculateAge } from "@/lib/domain/booking";
import { isValidEmail, normalizeEmail } from "@/lib/domain/registration";
import { importLeadsFromCsv, logLeadActivity } from "@/lib/services/lead";
import { logActivity } from "@/lib/services/activity";
import { sendEmail, sendSms } from "@/lib/services/notify";
import type { LeadStatus, Sex } from "@/app/generated/prisma/client";

// Import CSV: plik z inputa albo wklejony tekst. Po imporcie wracamy na listę
// z krótkim podsumowaniem (dodano / duplikaty / pominięto).
export async function importCsvAction(formData: FormData) {
  const session = await requireLeadAccess();

  const file = formData.get("file");
  const pasted = String(formData.get("csv") ?? "");
  let csv = pasted.trim();
  if ((!csv || csv.length === 0) && file instanceof File && file.size > 0) {
    csv = await file.text();
  }
  if (!csv) redirect("/leady?import=empty");

  const result = await importLeadsFromCsv({ csv, actorUserId: session.user.id });
  revalidatePath("/leady");
  // Nazwiska duplikatow w adresie, ale najwyzej piec - dluga lista rozsadzilaby
  // pasek adresu, a klubowi wystarczy wiedziec, kogo dotyczy i ilu bylo.
  const kto = result.duplicateNames.slice(0, 5).join("; ");
  redirect(
    `/leady?import=ok&created=${result.created}&dup=${result.duplicates}` +
      `&skip=${result.skipped}${kto ? `&ktoDup=${encodeURIComponent(kto)}` : ""}`,
  );
}

function parseLocalDateTime(value: string): Date | null {
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if (!m) return null;
  // datetime-local nie niesie strefy - traktujemy jako czas w Europe/Warsaw.
  return zonedTimeToUtc(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]));
}

export async function setReminderAction(formData: FormData) {
  const session = await requireLeadAccess();
  const leadId = String(formData.get("leadId"));
  const value = String(formData.get("reminder") ?? "");
  const at = parseLocalDateTime(value);
  if (!at) redirect(`/leady/${leadId}?blad=data`);

  await prisma.$transaction(async (tx) => {
    // Ustawienie przypomnienia zwykle znaczy "oddzwonić później" - podnosimy
    // status do CALLBACK, o ile lead nie jest już potwierdzony/zamknięty.
    const lead = await tx.lead.findUniqueOrThrow({
      where: { id: leadId },
      select: { status: true },
    });
    const bumpToCallback = lead.status === "NEW" || lead.status === "IN_PROGRESS";
    await tx.lead.update({
      where: { id: leadId },
      data: { reminderAt: at, ...(bumpToCallback ? { status: "CALLBACK" as LeadStatus } : {}) },
    });
    await logLeadActivity(tx, {
      leadId,
      actorUserId: session.user.id,
      kind: "REMINDER_SET",
      summary: `Ustawiono przypomnienie o ponownym kontakcie na ${at.toLocaleString("pl-PL", { timeZone: "Europe/Warsaw" })}`,
    });
  });
  revalidatePath(`/leady/${leadId}`);
  redirect(`/leady/${leadId}`);
}

export async function clearReminderAction(formData: FormData) {
  await requireLeadAccess();
  const leadId = String(formData.get("leadId"));
  await prisma.lead.update({ where: { id: leadId }, data: { reminderAt: null } });
  revalidatePath(`/leady/${leadId}`);
  redirect(`/leady/${leadId}`);
}

export async function updateStatusAction(formData: FormData) {
  const session = await requireLeadAccess();
  const leadId = String(formData.get("leadId"));
  const status = String(formData.get("status")) as LeadStatus;
  if (!LEAD_STATUS_ORDER.includes(status)) redirect(`/leady/${leadId}?blad=status`);

  await prisma.$transaction(async (tx) => {
    await tx.lead.update({ where: { id: leadId }, data: { status } });
    await logLeadActivity(tx, {
      leadId,
      actorUserId: session.user.id,
      kind: "STATUS_CHANGED",
      summary: `Zmiana statusu na: ${LEAD_STATUS_LABEL[status]}`,
    });
  });
  revalidatePath(`/leady/${leadId}`);
  redirect(`/leady/${leadId}`);
}

export async function assignLeadAction(formData: FormData) {
  const session = await requireLeadAccess();
  const leadId = String(formData.get("leadId"));
  const assignedToUserId = String(formData.get("assignedToUserId") ?? "") || null;

  const assignee = assignedToUserId
    ? await prisma.user.findUnique({ where: { id: assignedToUserId }, select: { name: true } })
    : null;

  await prisma.$transaction(async (tx) => {
    await tx.lead.update({ where: { id: leadId }, data: { assignedToUserId } });
    await logLeadActivity(tx, {
      leadId,
      actorUserId: session.user.id,
      kind: "ASSIGNED",
      summary: assignee ? `Przypisano do: ${assignee.name}` : "Zdjęto przypisanie",
    });
  });
  revalidatePath(`/leady/${leadId}`);
  redirect(`/leady/${leadId}`);
}

// Etap 2 leadów: konwersja lead -> klient. Lead ma tylko imię+kontakt, więc
// obsługujący uzupełnia dane wymagane przez kartotekę (data urodzenia, płeć,
// trener-opiekun, lokalizacja). Po utworzeniu Member wiążemy go z leadem
// (convertedMemberId) - dzięki temu historia leada jest dostępna także z karty
// klienta. joinedAt NIE ustawiamy: to pierwsza płatność/obecność, nie moment
// założenia kartoteki (SPEC.md sekcja 1).
export async function convertLeadToMemberAction(formData: FormData) {
  const session = await requireLeadAccess();
  const leadId = String(formData.get("leadId"));

  function fail(message: string): never {
    redirect(`/leady/${leadId}?blad=${encodeURIComponent(message)}`);
  }

  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    select: { id: true, fullName: true, convertedMemberId: true },
  });
  if (!lead) redirect("/leady");
  // Jeden lead = jedno konto. Gdy już skonwertowany, nie tworzymy drugiego.
  if (lead.convertedMemberId) redirect(`/leady/${leadId}`);

  const firstName = String(formData.get("firstName") ?? "").trim();
  const lastName = String(formData.get("lastName") ?? "").trim();
  const emailRaw = String(formData.get("email") ?? "").trim();
  const birthDateStr = String(formData.get("birthDate") ?? "");
  const sex = String(formData.get("sex") ?? "");
  const weightKgRaw = formData.get("weightKg");
  const goal = String(formData.get("goal") ?? "").trim();
  const homeLocationId = String(formData.get("homeLocationId") ?? "");
  const ownerTrainerId = String(formData.get("ownerTrainerId") ?? "");

  if (!firstName || !lastName || !birthDateStr || !homeLocationId || !ownerTrainerId) {
    fail(
      "Uzupełnij wszystkie wymagane pola (imię, nazwisko, data urodzenia, lokalizacja, trener).",
    );
  }
  if (sex !== "MALE" && sex !== "FEMALE") fail("Wybierz płeć.");

  const email = normalizeEmail(emailRaw);
  if (!email || !isValidEmail(email)) fail("Podaj poprawny adres e-mail.");

  const birthDate = new Date(birthDateStr);
  const now = new Date();
  if (Number.isNaN(birthDate.getTime()) || birthDate > now) fail("Nieprawidłowa data urodzenia.");
  const isMinor = calculateAge(birthDate, now) < 18;
  const weightKg = weightKgRaw && String(weightKgRaw).length > 0 ? Number(weightKgRaw) : null;

  let newMemberId = "";
  await prisma.$transaction(async (tx) => {
    const member = await tx.member.create({
      data: {
        firstName,
        lastName,
        email,
        birthDate,
        isMinor,
        sex: sex as Sex,
        weightKg,
        goal: goal || null,
        homeLocationId,
        ownerTrainerId,
        joinedAt: null,
      },
    });
    newMemberId = member.id;

    await tx.lead.update({
      where: { id: leadId },
      data: { convertedMemberId: member.id, status: "CONVERTED" as LeadStatus },
    });

    await logLeadActivity(tx, {
      leadId,
      actorUserId: session.user.id,
      kind: "CONVERTED",
      summary: `Utworzono konto klienta: ${firstName} ${lastName}`,
    });

    await logActivity(tx, {
      actorUserId: session.user.id,
      action: "MEMBER_CREATED",
      memberId: member.id,
      summary: `Dodano klienta ${firstName} ${lastName} (z leada: ${lead.fullName})`,
    });
  });

  revalidatePath(`/leady/${leadId}`);
  revalidatePath("/leady");
  redirect(`/admin/klienci/${newMemberId}`);
}

// Etap 4: podsumowanie rozmowy + opcjonalny SMS powitalny. Podsumowanie
// zapisujemy jako notatkę - dzięki temu jest widoczne także z karty klienta po
// konwersji (Etap 2). SMS idzie przez gniazdo sendSms; dopóki nie podłączono
// dostawcy, próba jest uczciwie logowana jako "nie wysłano" zamiast udawać
// sukces.
export async function saveCallSummaryAction(formData: FormData) {
  const session = await requireLeadAccess();
  const leadId = String(formData.get("leadId"));
  const summary = String(formData.get("summary") ?? "").trim();
  const phoneRaw = String(formData.get("phone") ?? "").trim();
  const emailRaw = String(formData.get("email") ?? "").trim();
  const channel = parseWelcomeChannel(String(formData.get("welcomeChannel") ?? ""));

  function fail(message: string): never {
    redirect(`/leady/${leadId}?blad=${encodeURIComponent(message)}`);
  }

  if (!summary) fail("Podsumowanie rozmowy nie może być puste.");

  const lead = await prisma.lead.findUniqueOrThrow({
    where: { id: leadId },
    select: { fullName: true, phone: true, email: true },
  });

  // Dane kontaktowe: z formularza (jeśli uzupełniono), inaczej te z leada.
  const phone = phoneRaw ? parseLeadPhone(phoneRaw) : lead.phone;
  if (phoneRaw && !phone) fail("Podany numer telefonu jest niepoprawny.");
  const email = emailRaw || lead.email;

  // Braki wyłapujemy PRZED zapisem - komunikat "podaj numer" po fakcie jest bez
  // wartości, bo podsumowanie już by się zapisało, a powitanie nie poszło.
  const missing = missingWelcomeContact(channel, { phone, email });
  if (missing) fail(missing);

  await prisma.$transaction(async (tx) => {
    if ((phone && phone !== lead.phone) || (email && email !== lead.email)) {
      await tx.lead.update({ where: { id: leadId }, data: { phone, email } });
    }
    await tx.leadNote.create({
      data: { leadId, authorUserId: session.user.id, body: `Podsumowanie rozmowy:\n${summary}` },
    });
    await logLeadActivity(tx, {
      leadId,
      actorUserId: session.user.id,
      kind: "SUMMARY",
      summary: "Zapisano podsumowanie rozmowy",
    });
  });

  // Powitanie idzie PO zapisaniu podsumowania: gdyby bramka SMS albo poczta
  // odmówiła, notatka z rozmowy i tak zostaje. Odwrotna kolejność gubiłaby
  // treść rozmowy przez awarię cudzej usługi.
  const { firstName } = splitFullName(lead.fullName);

  if ((channel === "SMS" || channel === "BOTH") && phone) {
    const sent = await sendSms(phone, buildWelcomeSms(firstName));
    await prisma.$transaction(async (tx) => {
      await logLeadActivity(tx, {
        leadId,
        actorUserId: session.user.id,
        kind: "WELCOME_SMS",
        summary: sent
          ? `Wysłano SMS powitalny na ${phone}`
          : `SMS powitalny na ${phone} - bramka SMS nieaktywna, nie wysłano`,
      });
    });
  }

  if ((channel === "EMAIL" || channel === "BOTH") && email) {
    const mail = buildWelcomeEmail(firstName);
    const sent = await sendEmail(email, mail.subject, mail.text);
    await prisma.$transaction(async (tx) => {
      await logLeadActivity(tx, {
        leadId,
        actorUserId: session.user.id,
        kind: "WELCOME_EMAIL",
        summary: sent
          ? `Wysłano e-mail powitalny na ${email}`
          : `E-mail powitalny na ${email} - poczta nieskonfigurowana, nie wysłano`,
      });
    });
  }

  revalidatePath(`/leady/${leadId}`);
  redirect(`/leady/${leadId}`);
}

export async function addLeadNoteAction(formData: FormData) {
  const session = await requireLeadAccess();
  const leadId = String(formData.get("leadId"));
  const body = String(formData.get("body") ?? "").trim();
  if (!body) redirect(`/leady/${leadId}`);

  await prisma.$transaction(async (tx) => {
    await tx.leadNote.create({ data: { leadId, authorUserId: session.user.id, body } });
    await logLeadActivity(tx, {
      leadId,
      actorUserId: session.user.id,
      kind: "NOTE_ADDED",
      summary: "Dodano notatkę",
    });
  });
  revalidatePath(`/leady/${leadId}`);
  redirect(`/leady/${leadId}`);
}
