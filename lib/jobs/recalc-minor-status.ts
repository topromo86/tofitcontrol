import type { PrismaClient } from "@/app/generated/prisma/client";
import { calculateAge } from "@/lib/domain/booking";
import { logActivity } from "@/lib/services/activity";
import { sendEmail } from "@/lib/services/notify";

export type RecalcMinorStatusResult = {
  recalculatedCount: number;
  // Ilu byłym opiekunom wygasło powiązanie tej nocy.
  expiredGuardianships: number;
};

// PLAN.md Faza 4: przelicza isMinor po 18. urodzinach, żeby status dorosłości
// nie musiał być sprawdzany ręcznie. Idempotentny.
//
// W 18. URODZINY WYGASA TEŻ POWIĄZANIE Z OPIEKUNEM.
//
// Wcześniej ten job celowo nie ruszał `guardianUserId` z komentarzem, że
// odpięcie opiekuna to decyzja biznesowa, a nie automat. Właściciel klubu tę
// decyzję podjął: powiązanie ma wygasać.
//
// Powód jest prawny, nie techniczny. Powiązanie daje rodzicowi pełny wgląd
// w kartotekę, prawo wycofywania zgód i drukowania dokumentów. Wobec osoby
// dorosłej to już nie jest opieka nad dzieckiem, tylko dostęp do cudzych danych -
// i nie ma podstawy, żeby trwał dalej bez zgody tej osoby. Powrót wymaga
// świadomego przypisania przez klub (lib/services/guardian.ts), a to działa
// wyłącznie dla niepełnoletnich - czyli po 18. urodzinach nie ma już powrotu.
//
// Rodzic dostaje o tym e-mail. Nie idzie to przez `notify`, bo tamta droga
// szanuje preferencje powiadomień - a utrata dostępu do danych dziecka nie jest
// czymś, z czego się rezygnuje w ustawieniach.
export async function recalcMinorStatus(
  prisma: PrismaClient,
  now: Date = new Date(),
): Promise<RecalcMinorStatusResult> {
  const candidates = await prisma.member.findMany({
    where: { isMinor: true },
    select: {
      id: true,
      birthDate: true,
      firstName: true,
      lastName: true,
      userId: true,
      guardianUser: { select: { id: true, name: true, email: true } },
    },
  });

  let recalculatedCount = 0;
  let expiredGuardianships = 0;

  for (const member of candidates) {
    if (calculateAge(member.birthDate, now) < 18) continue;

    const opiekun = member.guardianUser;
    const imieNazwisko = `${member.firstName} ${member.lastName}`;

    await prisma.$transaction(async (tx) => {
      await tx.member.update({
        where: { id: member.id },
        data: { isMinor: false, ...(opiekun ? { guardianUserId: null } : {}) },
      });

      if (opiekun) {
        await logActivity(tx, {
          // Automat, nie człowiek - ale ActivityLog wymaga sprawcy, więc
          // zostaje nim konto, które i tak jest opiekunem: to jego dostęp
          // wygasa i to jego dotyczy wpis.
          actorUserId: opiekun.id,
          action: "GUARDIAN_UNLINKED",
          memberId: member.id,
          summary:
            `Powiązanie z opiekunem wygasło automatycznie: ${imieNazwisko} kończy 18 lat. ` +
            `Opiekun ${opiekun.name} (${opiekun.email}) stracił dostęp do kartoteki.` +
            (member.userId
              ? ""
              : " UWAGA: ta osoba nie ma własnego konta - załóż jej login, inaczej nie zaloguje się do aplikacji."),
        });
      }
    });

    recalculatedCount++;
    if (!opiekun) continue;
    expiredGuardianships++;

    // Wysyłka POZA transakcją: wolny SMTP nie ma prawa trzymać blokady na
    // kartotece ani wywrócić przeliczenia, które już się zapisało.
    await sendEmail(
      opiekun.email,
      "Czapla Boxing - koniec opieki nad kontem",
      [
        `Cześć ${opiekun.name.split(" ")[0]},`,
        "",
        `${imieNazwisko} kończy dziś 18 lat, więc powiązanie Twojego konta z tą kartoteką`,
        "wygasło. Od teraz to konto pełnoletniej osoby i tylko ona decyduje o swoich danych.",
        "",
        member.userId
          ? "Zaloguje się swoim dotychczasowym kontem."
          : "Jeśli nie ma jeszcze własnego konta w aplikacji, poproście o nie w klubie.",
        "",
        "Do zobaczenia na sali,",
        "Czapla Boxing",
      ].join("\n"),
    );
  }

  return { recalculatedCount, expiredGuardianships };
}
