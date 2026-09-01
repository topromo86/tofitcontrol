import "server-only";
import { prisma } from "@/lib/prisma";
import { sendPushNotification } from "@/lib/services/notify";
import { formatDayTime } from "@/lib/format";

// Powiadomienia o zastępstwach.
//
// Push jest kanałem dodatkowym, nie głównym: trener może nie mieć włączonych
// powiadomień w przeglądarce, a właściciel może nie mieć skonfigurowanych
// kluczy VAPID. Źródłem prawdy jest zawsze stan w panelu (licznik przy
// "Dziś" u trenera, sekcja "Zastępstwa" u admina) - push tylko przyspiesza
// reakcję. Dlatego nie przerywamy operacji, gdy push zawiedzie.
export async function notifyUser(userId: string, title: string, body: string): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { pushSubscription: true, isDemo: true },
  });
  if (!user?.pushSubscription || user.isDemo) return;
  await sendPushNotification(user.pushSubscription as never, { title, body });
}

type SessionForNotice = {
  id: string;
  name: string;
  startsAt: Date;
};

// Powiadomienie zastępcy o wyznaczeniu. Treść mówi wprost, czy to polecenie
// właściciela, czy prośba kolegi - od tego zależy, co zastępca może zrobić.
export async function notifySubstituteRequested(input: {
  substituteUserId: string;
  session: SessionForNotice;
  requestedByName: string;
  byAdmin: boolean;
}): Promise<void> {
  const what = input.byAdmin ? "Wyznaczono Cię na zastępstwo" : "Prośba o zastępstwo";
  const action = input.byAdmin ? "Potwierdź przyjęcie w panelu." : "Potwierdź lub odmów w panelu.";
  await notifyUser(
    input.substituteUserId,
    what,
    `${input.session.name}, ${formatDayTime(input.session.startsAt)} - od: ${input.requestedByName}. ${action}`,
  );
}

// Właściciel ma wiedzieć o każdym zastępstwie, także tym uzgodnionym między
// trenerami bez jego udziału - to jego grafik i jego wypłaty.
export async function notifyAdminsAboutSubstitute(input: {
  title: string;
  body: string;
}): Promise<void> {
  const admins = await prisma.user.findMany({
    where: { role: "ADMIN" },
    select: { id: true },
  });
  await Promise.all(admins.map((a) => notifyUser(a.id, input.title, input.body)));
}
