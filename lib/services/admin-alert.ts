import "server-only";

import { prisma } from "@/lib/prisma";
import { sendEmail, sendPushNotification } from "@/lib/services/notify";

// Alert do właściciela klubu - jedno miejsce, z którego wychodzą wiadomości
// "zdarzyło się coś, o czym musisz wiedzieć".
//
// Idzie do WSZYSTKICH kont z rolą ADMIN, a nie do jednego adresu w kodzie:
// właściciel może dołożyć sobie drugie konto albo je wymienić, a alert ma iść
// dalej bez wdrożenia.
//
// Dwa kanały, bo push bywa niedostarczony (przeglądarka bez zgody, laptop
// wyłączony, subskrypcja wygasła). Sprawy, które muszą dojść, dostają też
// e-mail. Żaden kanał nie ma prawa wywrócić operacji, która ten alert
// wywołała - odbicie na sali jest ważniejsze niż powiadomienie o nim.
export async function alertAdmins(input: {
  title: string;
  body: string;
  // Włączane świadomie: e-mail przy każdym drobiazgu skończyłby się filtrem
  // w skrzynce, a wtedy nie dochodzi już nic.
  alsoEmail?: boolean;
}): Promise<void> {
  const admins = await prisma.user.findMany({
    // Generator danych demo nie zakłada kont ADMIN, ale gdyby kiedyś zaczął,
    // alerty klubu nie mają prawa polecieć na fikcyjne adresy.
    where: { role: "ADMIN", isDemo: false },
    select: { id: true, email: true, pushSubscription: true },
  });

  await Promise.all(
    admins.map(async (admin) => {
      if (admin.pushSubscription) {
        try {
          await sendPushNotification(admin.pushSubscription as never, {
            title: input.title,
            body: input.body,
          });
        } catch {
          // celowo połknięte - patrz komentarz nad funkcją
        }
      }
      if (input.alsoEmail && admin.email) {
        try {
          await sendEmail(admin.email, input.title, input.body);
        } catch {
          // jw.
        }
      }
    }),
  );
}
