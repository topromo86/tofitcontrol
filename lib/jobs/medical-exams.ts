import type { PrismaClient } from "@/app/generated/prisma/client";
import { isoDay, reminderForAthlete, shouldRemind } from "@/lib/domain/medical-exam";
import { notify } from "@/lib/services/notification";

// Powiadomienie wlascicieli idzie przez `notify`, a nie przez `alertAdmins`,
// z jednego powodu: `alertAdmins` nie ma idempotencji, a my przypominamy przez
// cale czternascie dni. Wlasciciel dostalby ten sam alert czternascie nocy
// z rzedu i przestalby na nie patrzec - czyli dokladnie to, przed czym te
// powiadomienia maja chronic. `notify` pilnuje tego po `subjectId`.
async function powiadomWlascicieli(
  prisma: PrismaClient,
  input: { subjectId: string; title: string; body: string },
): Promise<number> {
  const admini = await prisma.user.findMany({
    where: { role: "ADMIN", isDemo: false },
    select: { id: true },
  });
  let wyslane = 0;
  for (const a of admini) {
    const wynik = await notify({
      userId: a.id,
      type: "MEDICAL_EXAM",
      subjectId: input.subjectId,
      title: input.title,
      body: input.body,
    });
    if (wynik === "SENT") wyslane++;
  }
  return wyslane;
}

export type MedicalExamsResult = {
  // Ilu zawodnikow w ogole ma wpisany termin badan.
  checked: number;
  // Ilu z nich mieści się dziś w oknie przypomnienia. Osobno od
  // `athletesNotified`, bo to dwie różne rzeczy: pierwsza mówi, komu przypomnienie
  // się NALEŻY, druga - ile wiadomości realnie wyszło. Gdy padnie SMTP,
  // różnica między nimi jest jedynym sygnałem, że coś jest nie tak.
  due: number;
  athletesNotified: number;
  adminAlerts: number;
};

// Przypomnienie o kończących się badaniach lekarskich zawodnika.
//
// Bez ważnych badań zawodnik nie wystartuje, a klub dowiaduje się o tym zwykle
// na wadze, dzień przed walką. Reguła "kiedy przypomnieć" siedzi
// w lib/domain/medical-exam.ts i jest przetestowana; tutaj jest tylko dobór
// osób i wysyłka.
//
// Zawodnikiem bywa i klubowicz, i trener - to dwa różne modele, więc dwie
// pętle. Świadomie, zamiast trzeciej tabeli wiążącej: pól są dwa, a osobny
// model kosztowałby więcej niż powtórzona pętla.
//
// Idempotencja stoi na `notify` (klucz `subjectId`), nie na wąskim oknie dat:
// przypominamy przez cały czternastodniowy okres, bo gdyby warunek brzmiał
// "dokładnie 14 dni przed", jedno nieudane uruchomienie kasowałoby
// przypomnienie na zawsze.
export async function medicalExams(
  prisma: PrismaClient,
  now: Date = new Date(),
): Promise<MedicalExamsResult> {
  let checked = 0;
  let due = 0;
  let athletesNotified = 0;
  let adminAlerts = 0;

  // --- Klubowicze ---
  const members = await prisma.member.findMany({
    where: {
      isCompetitor: true,
      medicalExamValidUntil: { not: null },
      status: "ACTIVE",
      // Konto demonstracyjne nie ma właściciela - push nigdzie nie dojdzie,
      // a e-mail wróci odbiciem.
      isDemo: false,
    },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      medicalExamValidUntil: true,
      userId: true,
      guardianUserId: true,
    },
  });

  for (const m of members) {
    checked++;
    if (!shouldRemind(m.medicalExamValidUntil, now)) continue;
    due++;
    const doKiedy = m.medicalExamValidUntil!;
    const imie = `${m.firstName} ${m.lastName}`;

    // Kogo zawiadomić: zawodnika, a gdy nie ma własnego konta (dziecko) -
    // jego opiekuna. Bez tego przypomnienie o badaniach dziecka nie doszłoby
    // do nikogo, kto może je umówić.
    const odbiorca = m.userId ?? m.guardianUserId;
    if (odbiorca) {
      const tresc = reminderForAthlete({ name: imie, validUntil: doKiedy, now });
      const wynik = await notify({
        userId: odbiorca,
        type: "MEDICAL_EXAM",
        // Klucz zawiera DATĘ badań: nowy termin to nowe przypomnienie, ten sam
        // termin nie przypomni się drugi raz, choćby job chodził co noc.
        subjectId: `member:${m.id}:${isoDay(doKiedy)}`,
        title: tresc.title,
        body: m.userId ? tresc.body : `${imie}: ${tresc.body}`,
      });
      if (wynik === "SENT") athletesNotified++;
    }

    // Właściciel dostaje to samo w swojej formie - to on układa starty
    // i wie, kogo zgłasza na zawody.
    adminAlerts += await powiadomWlascicieli(prisma, {
      subjectId: `admin:member:${m.id}:${isoDay(doKiedy)}`,
      title: "Badania zawodnika wkrótce wygasną",
      body: `${imie} - badania ważne do ${isoDay(doKiedy)}.`,
    });
  }

  // --- Kadra ---
  const trainers = await prisma.trainer.findMany({
    where: { isCompetitor: true, medicalExamValidUntil: { not: null }, active: true },
    select: {
      id: true,
      medicalExamValidUntil: true,
      user: { select: { id: true, name: true, isDemo: true } },
    },
  });

  for (const t of trainers) {
    if (t.user.isDemo) continue;
    checked++;
    if (!shouldRemind(t.medicalExamValidUntil, now)) continue;
    due++;
    const doKiedy = t.medicalExamValidUntil!;

    const tresc = reminderForAthlete({ name: t.user.name, validUntil: doKiedy, now });
    const wynik = await notify({
      userId: t.user.id,
      type: "MEDICAL_EXAM",
      subjectId: `trainer:${t.id}:${isoDay(doKiedy)}`,
      title: tresc.title,
      body: tresc.body,
    });
    if (wynik === "SENT") athletesNotified++;

    adminAlerts += await powiadomWlascicieli(prisma, {
      subjectId: `admin:trainer:${t.id}:${isoDay(doKiedy)}`,
      title: "Badania zawodnika wkrótce wygasną",
      body: `${t.user.name} (kadra) - badania ważne do ${isoDay(doKiedy)}.`,
    });
  }

  return { checked, due, athletesNotified, adminAlerts };
}
