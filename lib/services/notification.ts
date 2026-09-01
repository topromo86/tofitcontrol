import "server-only";
import type { Prisma, PrismaClient } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import {
  wantsNotification,
  type NotificationType,
  type StoredPreference,
} from "@/lib/domain/notification";
import { sendEmail, sendPushNotification, sendSms } from "@/lib/services/notify";

type Db = PrismaClient | Prisma.TransactionClient;

export async function getPreferences(userId: string): Promise<StoredPreference[]> {
  const rows = await prisma.notificationPreference.findMany({
    where: { userId },
    select: { type: true, push: true, email: true, sms: true },
  });
  return rows as StoredPreference[];
}

// Zapis całego kompletu naraz. Upsert per typ, bo brak wiersza znaczy
// "wartość domyślna" - a po świadomym wyłączeniu przez klienta musi znaczyć
// "wyłączone", nie "domyślnie włączone".
export async function savePreferences(
  db: Db,
  userId: string,
  prefs: readonly StoredPreference[],
): Promise<void> {
  for (const pref of prefs) {
    await db.notificationPreference.upsert({
      where: { userId_type: { userId, type: pref.type } },
      create: { userId, type: pref.type, push: pref.push, email: pref.email, sms: pref.sms },
      update: { push: pref.push, email: pref.email, sms: pref.sms },
    });
  }
}

export type NotifyResult = "SENT" | "SKIPPED_PREFERENCE" | "SKIPPED_DUPLICATE" | "NO_CHANNEL";

// Jedno wejście dla wszystkich powiadomień do użytkownika.
//
// `subjectId` służy idempotencji: ten sam (user, typ, subject) nie zostanie
// wysłany drugi raz. Bez tego codzienny cron przypominałby o tych samych
// zajęciach każdego dnia aż do ich rozpoczęcia.
export async function notify(input: {
  userId: string;
  type: NotificationType;
  subjectId: string;
  title: string;
  body: string;
}): Promise<NotifyResult> {
  const user = await prisma.user.findUnique({
    where: { id: input.userId },
    select: { email: true, phone: true, pushSubscription: true, isDemo: true },
  });
  if (!user) return "NO_CHANNEL";
  // Konto demonstracyjne nie ma właściciela. Push nigdzie nie dojdzie, e-mail
  // poleci na domenę .invalid i wróci odbiciem, a SMS jest płatny za sztukę -
  // to jedyne miejsce, przez które przechodzą wszystkie trzy kanały naraz.
  if (user.isDemo) return "NO_CHANNEL";

  const prefs = await getPreferences(input.userId);

  const wantsPush = wantsNotification(prefs, input.type, "PUSH");
  const wantsEmail = wantsNotification(prefs, input.type, "EMAIL");
  const wantsSms = wantsNotification(prefs, input.type, "SMS");
  if (!wantsPush && !wantsEmail && !wantsSms) return "SKIPPED_PREFERENCE";

  // Rezerwujemy wpis PRZED wysyłką. Przy równoległym uruchomieniu dwóch
  // instancji cronu druga dostanie błąd unikalności i nie wyśle duplikatu.
  let reservation;
  try {
    reservation = await prisma.notificationLog.create({
      data: { userId: input.userId, type: input.type, subjectId: input.subjectId },
    });
  } catch {
    return "SKIPPED_DUPLICATE";
  }

  // Push i e-mail są kanałami samodzielnymi: kto zaznaczył oba, dostaje oba.
  // To świadome - push znika po chwili z ekranu, a mail zostaje w skrzynce
  // i do niego można wrócić.
  let pushSent = false;
  if (wantsPush && user.pushSubscription) {
    pushSent = await sendPushNotification(user.pushSubscription as never, {
      title: input.title,
      body: input.body,
    });
  }

  let emailSent = false;
  if (wantsEmail && user.email) {
    emailSent = await sendEmail(user.email, input.title, input.body);
  }

  let sent = pushSent || emailSent;

  // SMS wyłącznie jako ratunek, gdy pozostałe kanały zawiodły - a nie jako
  // kolejny egzemplarz tej samej wiadomości. Kosztuje za sztukę.
  if (!sent && wantsSms && user.phone) {
    sent = await sendSms(user.phone, `${input.title}: ${input.body}`);
  }

  // Nic nie poszło - zwalniamy rezerwację, żeby kolejne uruchomienie mogło
  // spróbować ponownie. Dziennik ma odzwierciedlać to, co realnie wysłano;
  // gdyby wpis został, chwilowa awaria push kasowałaby powiadomienie na stałe.
  if (!sent) {
    await prisma.notificationLog.delete({ where: { id: reservation.id } });
    return "NO_CHANNEL";
  }

  return "SENT";
}
