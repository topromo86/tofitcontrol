import "server-only";

import type { Prisma, PrismaClient } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import {
  blockerMessage,
  deletionOrder,
  isDemoModel,
  summarizeManifest,
  type DemoBlocker,
  type DemoModel,
  type DemoSummaryLine,
} from "@/lib/domain/demo-data";

// Wgrywanie i usuwanie danych demonstracyjnych - warstwa, która pilnuje
// bezpieczeństwa. Samą TREŚĆ demo (ilu klubowiczów, jaka historia) generuje
// lib/services/demo-dataset.ts; tutaj jest to, co decyduje, czy klub może tej
// funkcji użyć bez ryzyka.
//
// Trzy zasady, na których to stoi:
//
//   1. SPIS. Każdy założony rekord jest zapisywany w DemoRecord (model + id +
//      kolejność). Usuwanie idzie WYŁĄCZNIE po tym spisie, wstecz. Nic nie jest
//      kasowane "po kształcie" - po nazwisku, adresie czy dacie - bo klub ma
//      prawdziwych Nowaków i prawdziwe konta.
//
//   2. ODMOWA ZAMIAST SZKODY. Zanim cokolwiek zniknie, sprawdzamy, czy do
//      danych demo nie doczepiło się coś prawdziwego. Booking, Attendance
//      i Rating lecą KASKADĄ z zajęć - gdyby realny klubowicz zapisał się na
//      pokazowe zajęcia, usunięcie demo zabrałoby jego obecność bez śladu.
//      W takiej sytuacji nie kasujemy nic i mówimy, co stoi na drodze.
//
//   3. ZAMIATANIE POCHODNYCH. Nocne joby potrafią dołożyć rekordy o kliencie
//      demo już PO wgraniu (alert retencyjny, ankieta odejścia). Spis ich nie
//      zna, więc po przejściu spisu dokładamy jawne czyszczenie wszystkiego,
//      co wisi na kartotece/zajęciach/koncie demo. Takie rekordy z definicji
//      nie mogą być prawdziwe - dotyczą osoby, która nie istnieje.

type Tx = Prisma.TransactionClient;

// Transakcja obejmuje setki wierszy na bazie po drugiej stronie internetu.
// Domyślne 5 s Prismy jest tu za mało, a przerwana w połowie operacja to
// dokładnie stan, którego nie wolno zostawić.
const TRANSAKCJA = { maxWait: 15_000, timeout: 120_000 } as const;

export type DemoStatus = {
  present: boolean;
  batchId: string | null;
  loadedAt: Date | null;
  total: number;
  summary: DemoSummaryLine[];
};

export async function demoStatus(db: PrismaClient | Tx = prisma): Promise<DemoStatus> {
  const rows = await db.demoRecord.findMany({
    select: { model: true, recordId: true, seq: true, batchId: true, createdAt: true },
    orderBy: { seq: "asc" },
  });

  if (rows.length === 0) {
    return { present: false, batchId: null, loadedAt: null, total: 0, summary: [] };
  }

  return {
    present: true,
    batchId: rows[0].batchId,
    loadedAt: rows[0].createdAt,
    total: rows.length,
    summary: summarizeManifest(rows),
  };
}

// Jawna mapa model -> delegat Prismy. Świadomie switch, a nie indeksowanie
// `(tx as any)[model]`: nazwa modelu przychodzi z bazy, a dynamiczne
// indeksowanie klienta danymi z bazy to dokładnie ta konstrukcja, przez którą
// literówka w jednym wierszu kasuje nie tę tabelę.
function usunPoId(tx: Tx, model: DemoModel, ids: string[]): Promise<{ count: number }> {
  const where = { id: { in: ids } };
  switch (model) {
    case "location":
      return tx.location.deleteMany({ where });
    case "plan":
      return tx.plan.deleteMany({ where });
    case "user":
      return tx.user.deleteMany({ where });
    case "trainer":
      return tx.trainer.deleteMany({ where });
    case "session":
      return tx.session.deleteMany({ where });
    case "member":
      return tx.member.deleteMany({ where });
    case "consent":
      return tx.consent.deleteMany({ where });
    case "pass":
      return tx.pass.deleteMany({ where });
    case "payment":
      return tx.payment.deleteMany({ where });
    case "booking":
      return tx.booking.deleteMany({ where });
    case "attendance":
      return tx.attendance.deleteMany({ where });
    case "note":
      return tx.note.deleteMany({ where });
    case "onboardingStep":
      return tx.onboardingStep.deleteMany({ where });
    case "retentionTask":
      return tx.retentionTask.deleteMany({ where });
    case "rating":
      return tx.rating.deleteMany({ where });
    case "measurement":
      return tx.measurement.deleteMany({ where });
    case "churnSurvey":
      return tx.churnSurvey.deleteMany({ where });
    case "floorCheckIn":
      return tx.floorCheckIn.deleteMany({ where });
    case "trainerScore":
      return tx.trainerScore.deleteMany({ where });
  }
}

type DemoIds = {
  locationIds: string[];
  userIds: string[];
  trainerIds: string[];
  memberIds: string[];
  sessionIds: string[];
  planIds: string[];
  passIds: string[];
};

async function demoIds(db: PrismaClient | Tx): Promise<DemoIds> {
  const rows = await db.demoRecord.findMany({ select: { model: true, recordId: true } });
  const wybierz = (model: DemoModel) =>
    rows.filter((r) => r.model === model).map((r) => r.recordId);

  return {
    locationIds: wybierz("location"),
    userIds: wybierz("user"),
    trainerIds: wybierz("trainer"),
    memberIds: wybierz("member"),
    sessionIds: wybierz("session"),
    planIds: wybierz("plan"),
    passIds: wybierz("pass"),
  };
}

// Czy do danych demo doczepiło się coś prawdziwego. To jest ten sprawdzian,
// dla którego całość ma sens - bez niego "usuń demo" jest przyciskiem, który
// czasem kasuje historię klubu.
export async function demoBlockers(db: PrismaClient | Tx = prisma): Promise<DemoBlocker[]> {
  const ids = await demoIds(db);
  if (ids.locationIds.length === 0 && ids.sessionIds.length === 0) return [];

  const nieDemo = { isDemo: false } as const;

  const [
    zapisy,
    obecnosci,
    oceny,
    trenerzyWSali,
    trenerzyPrzypisani,
    kartotekiWSali,
    wplatyWSali,
    zajeciaObce,
    odbiciaObce,
    oknaDostepnosci,
    karnetyNaPlanach,
    wplatyDemoPozaSala,
    karnetyDemoPozaCennikiem,
    kodyNaCennikuDemo,
    kartotekiUTreneraDemo,
    zajeciaUTreneraDemo,
  ] = await Promise.all([
    db.booking.count({ where: { sessionId: { in: ids.sessionIds }, member: nieDemo } }),
    db.attendance.count({ where: { sessionId: { in: ids.sessionIds }, member: nieDemo } }),
    db.rating.count({ where: { sessionId: { in: ids.sessionIds }, member: nieDemo } }),
    // Ukryta tabela M2M _TrainerLocations kasuje się kaskadą razem z salą.
    // Prawdziwy trener, który TYLKO pracuje w tej sali, straciłby przypisanie
    // bez błędu i bez śladu.
    db.trainer.count({
      where: {
        locations: { some: { id: { in: ids.locationIds } } },
        id: { notIn: ids.trainerIds },
      },
    }),
    db.trainer.count({
      where: { locationId: { in: ids.locationIds }, id: { notIn: ids.trainerIds } },
    }),
    db.member.count({ where: { homeLocationId: { in: ids.locationIds }, isDemo: false } }),
    db.payment.count({
      where: { locationId: { in: ids.locationIds }, member: nieDemo },
    }),
    db.session.count({
      where: { locationId: { in: ids.locationIds }, id: { notIn: ids.sessionIds } },
    }),
    db.floorCheckIn.count({
      where: { locationId: { in: ids.locationIds }, user: { isDemo: false } },
    }),
    db.availabilityWindow.count({ where: { locationId: { in: ids.locationIds } } }),
    db.pass.count({ where: { planId: { in: ids.planIds }, member: nieDemo } }),
    // Kierunek odwrotny: to demo doczepiło się do klubu. Sprzedaż tego nie
    // wpuści (assertNoDemoMix w lib/services/pass.ts), ale baza mogła takie
    // wiersze dostać wcześniej - a wpłata demo w prawdziwej sali wchodzi do
    // zamknięcia kasy, którego nie da się otworzyć.
    db.payment.count({
      where: { memberId: { in: ids.memberIds }, locationId: { notIn: ids.locationIds } },
    }),
    db.pass.count({ where: { memberId: { in: ids.memberIds }, planId: { notIn: ids.planIds } } }),
    db.promoCode.count({ where: { planId: { in: ids.planIds } } }),
    db.member.count({ where: { ownerTrainerId: { in: ids.trainerIds }, isDemo: false } }),
    db.session.count({
      where: { trainerId: { in: ids.trainerIds }, id: { notIn: ids.sessionIds } },
    }),
  ]);

  const blockers: DemoBlocker[] = [];
  const dodaj = (co: string, ile: number) => {
    if (ile > 0) blockers.push({ co, ile });
  };

  dodaj("zapisy prawdziwych klubowiczów na zajęcia demonstracyjne", zapisy);
  dodaj("obecności prawdziwych klubowiczów na zajęciach demonstracyjnych", obecnosci);
  dodaj("oceny wystawione przez prawdziwych klubowiczów", oceny);
  dodaj("prawdziwi trenerzy przypisani do sali pokazowej", trenerzyWSali + trenerzyPrzypisani);
  dodaj("prawdziwe kartoteki z salą pokazową jako macierzystą", kartotekiWSali);
  dodaj("prawdziwe wpłaty przypisane do sali pokazowej", wplatyWSali);
  dodaj("prawdziwe zajęcia w sali pokazowej", zajeciaObce);
  dodaj("wejścia prawdziwych osób do sali pokazowej", odbiciaObce);
  dodaj("terminy indywidualne trenerów w sali pokazowej", oknaDostepnosci);
  dodaj("karnety prawdziwych klubowiczów na demonstracyjnym cenniku", karnetyNaPlanach);
  dodaj("wpłaty klienta demonstracyjnego zapisane w prawdziwej sali", wplatyDemoPozaSala);
  dodaj("karnety klienta demonstracyjnego na cenniku klubu", karnetyDemoPozaCennikiem);
  dodaj("kody rabatowe przypięte do demonstracyjnego cennika", kodyNaCennikuDemo);
  dodaj("prawdziwe kartoteki przypisane do trenera demonstracyjnego", kartotekiUTreneraDemo);
  dodaj("prawdziwe zajęcia prowadzone przez trenera demonstracyjnego", zajeciaUTreneraDemo);

  return blockers;
}

export type RemoveResult =
  { ok: true; removed: number; summary: DemoSummaryLine[] } | { ok: false; message: string };

export async function removeDemoData(): Promise<RemoveResult> {
  const stan = await demoStatus();
  if (!stan.present) {
    return { ok: false, message: "Nie ma czego usuwać - w bazie nie ma danych demonstracyjnych." };
  }

  const blockers = await demoBlockers();
  if (blockers.length > 0) {
    return { ok: false, message: blockerMessage(blockers) };
  }

  const usuniete = await prisma.$transaction(async (tx) => {
    const ids = await demoIds(tx);

    // Licznik obejmuje ZAMIATANIE i spis razem. Sam spis podałby liczbę
    // mniejszą niż to, co powstało: dzieci kartotek i zajęć znikają
    // w zamiataniu, zanim dojdzie do nich kolejka po spisie.
    let licznik = 0;
    const skasuj = async (co: Promise<{ count: number }>) => {
      licznik += (await co).count;
    };

    // --- 1. Pochodne, których spis nie zna ------------------------------------
    // Rekordy dołożone przez nocne joby o kliencie demo już po wgraniu.
    // Wszystkie dotyczą osoby, która nie istnieje, więc żaden z nich nie może
    // być danymi klubu. Idą przed spisem, bo część trzyma kartotekę na RESTRICT.
    const czlonkowie = { memberId: { in: ids.memberIds } };
    if (ids.memberIds.length > 0) {
      await skasuj(tx.retentionTask.deleteMany({ where: czlonkowie }));
      await skasuj(tx.churnSurvey.deleteMany({ where: czlonkowie }));
      await skasuj(tx.absenceReport.deleteMany({ where: czlonkowie }));
      await skasuj(tx.onboardingStep.deleteMany({ where: czlonkowie }));
      await skasuj(tx.measurement.deleteMany({ where: czlonkowie }));
      await skasuj(tx.rating.deleteMany({ where: czlonkowie }));
      await skasuj(tx.attendance.deleteMany({ where: czlonkowie }));
      await skasuj(tx.booking.deleteMany({ where: czlonkowie }));
      await skasuj(tx.consent.deleteMany({ where: czlonkowie }));
      await skasuj(tx.note.deleteMany({ where: czlonkowie }));
      await skasuj(tx.payment.deleteMany({ where: czlonkowie }));
      await skasuj(tx.pass.deleteMany({ where: czlonkowie }));
      await skasuj(
        tx.referral.deleteMany({
          where: {
            OR: [
              { referrerMemberId: { in: ids.memberIds } },
              { refereeMemberId: { in: ids.memberIds } },
            ],
          },
        }),
      );
      await skasuj(tx.guardianLinkRequest.deleteMany({ where: czlonkowie }));
      // Lead wskazujący na kartotekę demo zostałby ze statusem CONVERTED
      // i pustym powiązaniem - w CRM wygląda jak obsłużony, a konta nie ma.
      await tx.lead.updateMany({
        where: { convertedMemberId: { in: ids.memberIds } },
        data: { convertedMemberId: null, status: "NEW" },
      });
    }
    if (ids.sessionIds.length > 0) {
      await skasuj(tx.rating.deleteMany({ where: { sessionId: { in: ids.sessionIds } } }));
      await skasuj(tx.attendance.deleteMany({ where: { sessionId: { in: ids.sessionIds } } }));
      await skasuj(tx.booking.deleteMany({ where: { sessionId: { in: ids.sessionIds } } }));
    }
    if (ids.locationIds.length > 0) {
      // Nocne zamknięcie kasy chodzi po WSZYSTKICH salach, więc po jednej nocy
      // sala pokazowa ma własny CashDay. To nie jest dokument klubu - dotyczy
      // sali, której nie ma - a przez RESTRICT zablokowałby usunięcie sali.
      await skasuj(tx.cashDay.deleteMany({ where: { locationId: { in: ids.locationIds } } }));
    }
    if (ids.userIds.length > 0) {
      // NotificationLog nie ma klucza obcego do User - baza nie zaprotestuje
      // i sama go nie posprząta, więc "co do rekordu" wymaga jawnego kroku.
      await skasuj(tx.notificationLog.deleteMany({ where: { userId: { in: ids.userIds } } }));
      await skasuj(
        tx.notificationPreference.deleteMany({ where: { userId: { in: ids.userIds } } }),
      );
      await skasuj(
        tx.emailVerificationToken.deleteMany({ where: { userId: { in: ids.userIds } } }),
      );
      await skasuj(tx.passwordResetToken.deleteMany({ where: { userId: { in: ids.userIds } } }));
      await skasuj(tx.floorCheckIn.deleteMany({ where: { userId: { in: ids.userIds } } }));
    }

    // --- 2. Spis, wstecz ------------------------------------------------------
    const spis = await tx.demoRecord.findMany({
      select: { model: true, recordId: true },
      orderBy: { seq: "desc" },
    });

    for (const model of deletionOrder()) {
      const ids = spis.filter((r) => r.model === model).map((r) => r.recordId);
      if (ids.length === 0) continue;
      if (!isDemoModel(model)) continue;
      const { count } = await usunPoId(tx, model, ids);
      licznik += count;
    }

    await tx.demoRecord.deleteMany({});
    return licznik;
  }, TRANSAKCJA);

  // Sprawdzenie po fakcie. Przy operacji, która kasuje kartoteki, "gotowe" bez
  // pokrycia w bazie jest bezwartościowe - pytamy bazę, czy naprawdę pusto.
  const [spisZostal, saleZostaly, kartotekiZostaly, kontaZostaly] = await Promise.all([
    prisma.demoRecord.count(),
    prisma.location.count({ where: { isDemo: true } }),
    prisma.member.count({ where: { isDemo: true } }),
    prisma.user.count({ where: { isDemo: true } }),
  ]);
  const resztki = spisZostal + saleZostaly + kartotekiZostaly + kontaZostaly;
  if (resztki > 0) {
    return {
      ok: false,
      message:
        `Usunięto ${usuniete} rekordów, ale w bazie zostało ${resztki} śladów danych ` +
        "demonstracyjnych. Nie zgłaszam sukcesu, dopóki nie jest pusto - zgłoś to programiście.",
    };
  }

  return { ok: true, removed: usuniete, summary: stan.summary };
}

// --- Zapis do spisu (używa go generator) -------------------------------------

export class DemoManifest {
  private readonly wiersze: { model: DemoModel; recordId: string }[] = [];

  constructor(readonly batchId: string) {}

  // Zapisuje, że rekord powstał. Nazwa modelu jest typowana listą DEMO_MODELS,
  // więc nie da się dopisać czegoś, czego usuwanie nie umie skasować.
  add(model: DemoModel, recordId: string): string {
    this.wiersze.push({ model, recordId });
    return recordId;
  }

  addMany(model: DemoModel, ids: string[]): void {
    for (const id of ids) this.add(model, id);
  }

  get size(): number {
    return this.wiersze.length;
  }

  async save(tx: Tx): Promise<void> {
    if (this.wiersze.length === 0) return;
    await tx.demoRecord.createMany({
      data: this.wiersze.map((w, index) => ({
        batchId: this.batchId,
        model: w.model,
        recordId: w.recordId,
        seq: index,
      })),
    });
  }
}

export { TRANSAKCJA as DEMO_TRANSACTION_OPTIONS };
