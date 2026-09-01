import "server-only";

import type { Prisma } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { zonedTimeToUtc } from "@/lib/domain/time";
import {
  chanceOf,
  createRng,
  DEMO_PREFIX,
  demoEmail,
  intBetween,
  pickFrom,
} from "@/lib/domain/demo-data";
import { DEMO_TRANSACTION_OPTIONS, DemoManifest, demoStatus } from "@/lib/services/demo-data";

// Treść danych demonstracyjnych: klub, który wygląda jak działający od roku.
//
// Wszystko, co tu powstaje, jest SAMODZIELNE - własna sala, właśni trenerzy,
// własny cennik, własna kartoteka. Nic nie doczepia się do prawdziwych zajęć
// ani do prawdziwych trenerów, i to nie jest ostrożność na wyrost:
// lib/services/payroll.ts liczy do wypłaty KAŻDĄ sesję prowadzoną przez
// trenera w miesiącu, bez żadnego filtra. Demo zajęcia dopięte do Daniela
// podbiłyby kwotę, według której klub płaci ludziom.
//
// Identyfikatory nadajemy w kodzie (nie bazie), żeby dało się użyć createMany
// i żeby spis powstawał bez ani jednego odczytu zwrotnego. Mają czytelny
// przedrostek - w surowym SQL widać wtedy gołym okiem, co jest demonstracyjne.

type Tx = Prisma.TransactionClient;

const IMIONA_M = ["Piotr", "Marcin", "Tomasz", "Jakub", "Michał", "Adam", "Rafał", "Krzysztof"];
const IMIONA_K = ["Anna", "Katarzyna", "Magdalena", "Ewa", "Joanna", "Alicja", "Karolina"];
const IMIONA_DZIECI = ["Antoni", "Julia", "Filip", "Zofia", "Szymon", "Maja", "Franciszek"];
const NAZWISKA = [
  "Zawadzki",
  "Piotrowska",
  "Wieczorek",
  "Sikora",
  "Baran",
  "Mazurek",
  "Kaczmarek",
  "Sadowski",
  "Głowacka",
  "Ostrowski",
  "Cieślak",
  "Marciniak",
  "Bąk",
  "Zalewska",
  "Rutkowski",
  "Jaworska",
  "Sobczak",
  "Górski",
  "Lewandowska",
  "Adamczyk",
];

const CELE = [
  "Redukcja wagi i kondycja",
  "Nauka techniki od podstaw",
  "Przygotowanie do pierwszej walki sparingowej",
  "Regularny trening 2x w tygodniu",
  "Powrót do formy po przerwie",
];

const NOTATKI = [
  "Rozmowa po treningu - wraca po kontuzji, na razie bez sparingów.",
  "Zapytał o karnet open. Przemyśli do końca miesiąca.",
  "Świetna forma, gotowy do pierwszych sparingów.",
  "Nie było go dwa tygodnie - wyjazd służbowy, wraca w przyszłym tygodniu.",
  "Prosi o dodatkowy trening techniczny w sobotę.",
];

const KOMENTARZE_OCEN = [
  "Konkretnie i na temat, dobra rozgrzewka.",
  "Trener poświęcił czas na poprawienie techniki.",
  "Trochę za mało czasu na worki.",
  "Mocno, dokładnie tak jak lubię.",
];

// Trzy zajęcia w tygodniu w sali pokazowej. Godziny takie jak w realnym
// grafiku klubu, żeby demo wyglądało jak klub, a nie jak zbiór danych.
const GRAFIK = [
  { weekday: 1, hour: 18, minute: 0, nazwa: "Boks - grupa ogólna", kids: false, capacity: 16 },
  { weekday: 3, hour: 17, minute: 0, nazwa: "Kids Boxing", kids: true, capacity: 12 },
  { weekday: 5, hour: 19, minute: 0, nazwa: "Boks - technika", kids: false, capacity: 14 },
] as const;

const TYGODNI_WSTECZ = 8;
const TYGODNI_W_PRZOD = 2;

type IdMaker = (model: string, n: number) => string;

function makeIdMaker(batchId: string): IdMaker {
  return (model, n) => `dmo${batchId}${model}${String(n).padStart(4, "0")}`;
}

function dzienTemu(now: Date, dni: number): Date {
  return new Date(now.getTime() - dni * 86_400_000);
}

// Data urodzenia dla wieku w latach - liczona kalendarzowo, bez przybliżeń,
// bo od isMinor zależy brama zgód opiekuna.
function urodzonyPrzedLaty(now: Date, lata: number, przesuniecieDni: number): Date {
  const d = new Date(now.getTime());
  d.setUTCFullYear(d.getUTCFullYear() - lata);
  return new Date(d.getTime() - przesuniecieDni * 86_400_000);
}

export type LoadResult = { ok: true; total: number } | { ok: false; message: string };

export async function loadDemoData(): Promise<LoadResult> {
  const stan = await demoStatus();
  if (stan.present) {
    return {
      ok: false,
      message:
        "Dane demonstracyjne już są w bazie. Najpierw je usuń - drugie wgranie zrobiłoby " +
        "drugi komplet, którego nie da się rozdzielić.",
    };
  }

  // Słowniki, których demo UŻYWA, ale nie zakłada: typy zgód i rodzaje zajęć
  // są wspólne dla klubu. Czytamy je i tyle - żaden z nich nie zostanie
  // dotknięty ani usunięty.
  const [typyZgod, kategorie, powodyOdejscia] = await Promise.all([
    prisma.consentType.findMany({
      where: { forMinorsOnly: false },
      select: { id: true, version: true },
    }),
    prisma.classCategory.findMany({
      where: { active: true, isIndividual: false },
      select: { id: true, name: true },
    }),
    prisma.churnReason.findMany({ select: { id: true } }),
  ]);

  const batchId = Math.random().toString(36).slice(2, 10);
  const id = makeIdMaker(batchId);
  const manifest = new DemoManifest(batchId);
  const now = new Date();

  try {
    await prisma.$transaction(async (tx) => {
      await zbudujDemo({ tx, id, manifest, now, typyZgod, kategorie, powodyOdejscia });
      await manifest.save(tx);
    }, DEMO_TRANSACTION_OPTIONS);
  } catch (blad) {
    // Transakcja cofa wszystko, więc w bazie nie zostaje połowa danych.
    // Mówimy o tym wprost, bo "nie udało się" bez tej informacji zostawia
    // człowieka z pytaniem, czy ma teraz co sprzątać.
    const powod = blad instanceof Error ? blad.message : "nieznany błąd";
    return {
      ok: false,
      message: `Nie udało się wgrać danych demonstracyjnych: ${powod}. Baza została bez zmian.`,
    };
  }

  return { ok: true, total: manifest.size };
}

async function zbudujDemo(input: {
  tx: Tx;
  id: IdMaker;
  manifest: DemoManifest;
  now: Date;
  typyZgod: { id: string; version: number }[];
  kategorie: { id: string; name: string }[];
  powodyOdejscia: { id: string }[];
}): Promise<void> {
  const { tx, id, manifest, now, typyZgod, kategorie, powodyOdejscia } = input;

  // --- Sala ------------------------------------------------------------------
  const salaId = manifest.add("location", id("loc", 1));
  await tx.location.create({
    data: {
      id: salaId,
      name: `${DEMO_PREFIX} Sala pokazowa`,
      address: "ul. Pokazowa 1, 00-001 Demo",
      isDemo: true,
    },
  });

  // --- Cennik ----------------------------------------------------------------
  // Własny, a nie realny: karnet demo na prawdziwym planie zostawiłby po sobie
  // licznik "sprzedany N razy" i blokował usunięcie planu z cennika klubu.
  const planySpec = [
    { nazwa: `${DEMO_PREFIX} Dorośli 3x w tygodniu`, cena: 22000, wejscia: 12, dni: 30 },
    { nazwa: `${DEMO_PREFIX} Dorośli 2x w tygodniu`, cena: 17000, wejscia: 8, dni: 30 },
    { nazwa: `${DEMO_PREFIX} Kids/Junior`, cena: 15000, wejscia: 8, dni: 30 },
  ];
  const planIds = planySpec.map((_, i) => manifest.add("plan", id("pln", i + 1)));
  await tx.plan.createMany({
    data: planySpec.map((p, i) => ({
      id: planIds[i],
      name: p.nazwa,
      priceGross: p.cena,
      entriesPerMonth: p.wejscia,
      durationDays: p.dni,
      forMinors: i === 2,
      active: true,
      isDemo: true,
    })),
  });

  // --- Trenerzy --------------------------------------------------------------
  const trenerzySpec = [
    { imie: "Robert", nazwisko: "Demiańczuk", dni: 700 },
    { imie: "Agata", nazwisko: "Lisowska", dni: 420 },
    { imie: "Paweł", nazwisko: "Wrona", dni: 210 },
  ];
  const trenerzy = trenerzySpec.map((spec, i) => ({
    ...spec,
    userId: manifest.add("user", id("usr", i + 1)),
    trainerId: manifest.add("trainer", id("trn", i + 1)),
  }));

  await tx.user.createMany({
    data: trenerzy.map((t) => ({
      id: t.userId,
      // Bez hasła: konto demonstracyjne nie ma być drogą wejścia do kartoteki
      // klubu. Adres na domenie .invalid, więc reset hasła nie ma dokąd dojść.
      passwordHash: null,
      email: demoEmail(`${t.imie}.${t.nazwisko}`.toLowerCase(), manifest.batchId),
      name: `${DEMO_PREFIX} ${t.imie} ${t.nazwisko}`,
      role: "TRAINER" as const,
      isDemo: true,
    })),
  });
  await tx.trainer.createMany({
    data: trenerzy.map((t) => ({
      id: t.trainerId,
      userId: t.userId,
      locationId: salaId,
      hiredAt: dzienTemu(now, t.dni),
      active: true,
      bio: "Trener demonstracyjny - konto pokazowe, nie prowadzi realnych zajęć.",
    })),
  });

  // --- Terminy zajęć ---------------------------------------------------------
  type Termin = { id: string; startsAt: Date; endsAt: Date; kids: boolean; trainerIdx: number };
  const terminy: Termin[] = [];
  let licznikSesji = 0;

  for (let tydzien = -TYGODNI_WSTECZ; tydzien <= TYGODNI_W_PRZOD; tydzien++) {
    for (const wpis of GRAFIK) {
      // Przesunięcie do właściwego dnia tygodnia w danym tygodniu.
      const baza = new Date(now.getTime() + tydzien * 7 * 86_400_000);
      const przesun = (wpis.weekday - baza.getUTCDay() + 7) % 7;
      const dzien = new Date(baza.getTime() + przesun * 86_400_000);

      // Godzina liczona przez zonedTimeToUtc, a nie przybliżeniem miesiąca -
      // osiem tygodni wstecz zawsze przecina zmianę czasu, a wtedy obecności
      // wylądowałyby przy zajęciach o godzinę obok.
      const startsAt = zonedTimeToUtc(
        dzien.getUTCFullYear(),
        dzien.getUTCMonth() + 1,
        dzien.getUTCDate(),
        wpis.hour,
        wpis.minute,
      );
      if (startsAt.getTime() > now.getTime() + TYGODNI_W_PRZOD * 7 * 86_400_000) continue;

      licznikSesji += 1;
      const sesjaId = manifest.add("session", id("ses", licznikSesji));
      const trainerIdx = licznikSesji % trenerzy.length;
      terminy.push({
        id: sesjaId,
        startsAt,
        endsAt: new Date(startsAt.getTime() + 60 * 60_000),
        kids: wpis.kids,
        trainerIdx,
      });
    }
  }

  const kategoriaDla = (kids: boolean) =>
    kategorie.find((k) => (kids ? /kids|junior/i.test(k.name) : !/kids|junior/i.test(k.name)))
      ?.id ?? null;

  await tx.session.createMany({
    data: terminy.map((t, i) => {
      const wpis = GRAFIK[i % GRAFIK.length];
      const przeszlosc = t.startsAt.getTime() < now.getTime();
      return {
        id: t.id,
        locationId: salaId,
        trainerId: trenerzy[t.trainerIdx].trainerId,
        name: `${DEMO_PREFIX} ${wpis.nazwa}`,
        kind: "GROUP" as const,
        startsAt: t.startsAt,
        endsAt: t.endsAt,
        capacity: wpis.capacity,
        status: "SCHEDULED" as const,
        categoryId: kategoriaDla(t.kids),
        // Bez tego każde demonstracyjne zajęcia świeciłyby na czerwono
        // "brak odbicia trenera" - demo wyglądałoby jak awaria.
        trainerCheckedInAt: przeszlosc ? new Date(t.startsAt.getTime() - 6 * 60_000) : null,
        trainerCheckedInUserId: przeszlosc ? trenerzy[t.trainerIdx].userId : null,
        attendanceConfirmedAt: przeszlosc ? t.endsAt : null,
      };
    }),
  });

  // --- Kartoteki -------------------------------------------------------------
  const rngLudzi = createRng(2002);
  const LICZBA_DOROSLYCH = 18;
  const LICZBA_DZIECI = 6;

  type Klubowicz = {
    memberId: string;
    userId: string | null;
    guardianUserId: string | null;
    kids: boolean;
    joinedAt: Date;
    trainerIdx: number;
    odszedl: boolean;
    imie: string;
    nazwisko: string;
  };

  const klubowicze: Klubowicz[] = [];
  const kontaDoZalozenia: Prisma.UserCreateManyInput[] = [];
  let licznikKont = trenerzy.length;

  for (let i = 0; i < LICZBA_DOROSLYCH + LICZBA_DZIECI; i++) {
    const kids = i >= LICZBA_DOROSLYCH;
    const meski = chanceOf(rngLudzi, 0.6);
    const imie = kids
      ? pickFrom(rngLudzi, IMIONA_DZIECI)
      : pickFrom(rngLudzi, meski ? IMIONA_M : IMIONA_K);
    const nazwisko = NAZWISKA[i % NAZWISKA.length];
    const stazDni = intBetween(rngLudzi, 20, 400);
    // Co szósty dorosły odszedł - bez tego retencja i powody odejść są puste,
    // a to jest połowa tego, co system ma pokazywać.
    const odszedl = !kids && i % 6 === 5;

    const memberId = manifest.add("member", id("mem", i + 1));
    let userId: string | null = null;
    let guardianUserId: string | null = null;

    licznikKont += 1;
    const kontoId = manifest.add("user", id("usr", licznikKont));
    kontaDoZalozenia.push({
      id: kontoId,
      passwordHash: null,
      email: demoEmail(`${imie}.${nazwisko}${i}`.toLowerCase(), manifest.batchId),
      name: kids ? `${DEMO_PREFIX} Opiekun ${nazwisko}` : `${DEMO_PREFIX} ${imie} ${nazwisko}`,
      role: kids ? ("GUARDIAN" as const) : ("MEMBER" as const),
      isDemo: true,
    });
    if (kids) guardianUserId = kontoId;
    else userId = kontoId;

    klubowicze.push({
      memberId,
      userId,
      guardianUserId,
      kids,
      joinedAt: dzienTemu(now, stazDni),
      trainerIdx: i % trenerzy.length,
      odszedl,
      imie,
      nazwisko,
    });
  }

  await tx.user.createMany({ data: kontaDoZalozenia });

  await tx.member.createMany({
    data: klubowicze.map((k) => {
      const staz = Math.floor((now.getTime() - k.joinedAt.getTime()) / 86_400_000);
      return {
        id: k.memberId,
        userId: k.userId,
        guardianUserId: k.guardianUserId,
        ownerTrainerId: trenerzy[k.trainerIdx].trainerId,
        homeLocationId: salaId,
        firstName: k.imie,
        lastName: `${k.nazwisko} ${DEMO_PREFIX}`,
        birthDate: urodzonyPrzedLaty(now, k.kids ? 11 : 31, intBetween(rngLudzi, 0, 300)),
        isMinor: k.kids,
        sex: null,
        level: staz > 250 ? "GREEN" : staz > 150 ? "ORANGE" : staz > 60 ? "YELLOW" : "WHITE",
        goal: chanceOf(rngLudzi, 0.7) ? pickFrom(rngLudzi, CELE) : null,
        status: k.odszedl ? ("CHURNED" as const) : ("ACTIVE" as const),
        approvalStatus: "APPROVED" as const,
        joinedAt: k.joinedAt,
        churnedAt: k.odszedl ? dzienTemu(now, intBetween(rngLudzi, 5, 60)) : null,
        // Bez tego demonstracyjny klient zapisze się tylko na PIERWSZE zajęcia
        // i pokaz zapisów rozbije się przy drugim kliknięciu.
        consentsDeliveredAt: k.joinedAt,
        isDemo: true,
      };
    }),
  });

  // --- Zgody -----------------------------------------------------------------
  if (typyZgod.length > 0) {
    const zgody: Prisma.ConsentCreateManyInput[] = [];
    let licznikZgod = 0;
    for (const k of klubowicze) {
      for (const typ of typyZgod) {
        licznikZgod += 1;
        zgody.push({
          id: manifest.add("consent", id("cns", licznikZgod)),
          memberId: k.memberId,
          consentTypeId: typ.id,
          version: typ.version,
          grantedAt: k.joinedAt,
          ipAddress: "127.0.0.1",
          userAgent: "toFitCONTROL demo",
          grantedByUserId: (k.userId ?? k.guardianUserId)!,
        });
      }
    }
    await tx.consent.createMany({ data: zgody });
  }

  // --- Karnety i wpłaty ------------------------------------------------------
  const rngPieniedzy = createRng(3003);
  const karnety: Prisma.PassCreateManyInput[] = [];
  const wplaty: Prisma.PaymentCreateManyInput[] = [];

  klubowicze.forEach((k, i) => {
    const planIdx = k.kids ? 2 : i % 2;
    const cena = planySpec[planIdx].cena;
    const start = k.odszedl ? dzienTemu(now, 70) : dzienTemu(now, intBetween(rngPieniedzy, 2, 28));
    const passId = manifest.add("pass", id("pas", i + 1));

    karnety.push({
      id: passId,
      memberId: k.memberId,
      planId: planIds[planIdx],
      priceGross: cena,
      startsAt: start,
      endsAt: new Date(start.getTime() + 30 * 86_400_000),
      entriesLeft: intBetween(rngPieniedzy, 0, planySpec[planIdx].wejscia),
      status: k.odszedl ? ("EXPIRED" as const) : ("ACTIVE" as const),
      soldByUserId: trenerzy[k.trainerIdx].userId,
    });

    wplaty.push({
      id: manifest.add("payment", id("pay", i + 1)),
      memberId: k.memberId,
      passId,
      amountGross: cena,
      // NIGDY gotówka: CashDay sumuje wpłaty CASH per sala i dzień, a dnia raz
      // zamkniętego nie da się w tym systemie otworzyć.
      method: chanceOf(rngPieniedzy, 0.5) ? ("TRANSFER" as const) : ("BLIK" as const),
      locationId: salaId,
      recordedByUserId: trenerzy[k.trainerIdx].userId,
      recordedAt: start,
    });
  });

  await tx.pass.createMany({ data: karnety });
  await tx.payment.createMany({ data: wplaty });

  // --- Zapisy, obecności, oceny ---------------------------------------------
  const rngSali = createRng(4004);
  const zapisy: Prisma.BookingCreateManyInput[] = [];
  const obecnosci: Prisma.AttendanceCreateManyInput[] = [];
  const oceny: Prisma.RatingCreateManyInput[] = [];
  const odbicia: Prisma.FloorCheckInCreateManyInput[] = [];
  let nrZapisu = 0;
  let nrObecnosci = 0;
  let nrOceny = 0;
  let nrOdbicia = 0;

  for (const termin of terminy) {
    const przeszlosc = termin.startsAt.getTime() < now.getTime();
    const kandydaci = klubowicze.filter(
      (k) => k.kids === termin.kids && k.joinedAt.getTime() <= termin.startsAt.getTime(),
    );

    for (const k of kandydaci) {
      // Klient, który odszedł, przestaje się pojawiać - to jest ten kształt,
      // po którym widać retencję na wykresie.
      const odszedlJuz = k.odszedl && termin.startsAt.getTime() > dzienTemu(now, 60).getTime();
      if (odszedlJuz) continue;
      if (!chanceOf(rngSali, przeszlosc ? 0.55 : 0.4)) continue;

      const byl = przeszlosc && chanceOf(rngSali, 0.85);
      nrZapisu += 1;
      zapisy.push({
        id: manifest.add("booking", id("bok", nrZapisu)),
        sessionId: termin.id,
        memberId: k.memberId,
        status: przeszlosc
          ? byl
            ? ("ATTENDED" as const)
            : ("NO_SHOW" as const)
          : ("BOOKED" as const),
        createdAt: new Date(termin.startsAt.getTime() - 2 * 86_400_000),
      });

      if (byl) {
        nrObecnosci += 1;
        obecnosci.push({
          id: manifest.add("attendance", id("att", nrObecnosci)),
          sessionId: termin.id,
          memberId: k.memberId,
          checkedInAt: new Date(termin.startsAt.getTime() - 5 * 60_000),
          method: chanceOf(rngSali, 0.8) ? ("QR" as const) : ("MANUAL" as const),
        });

        nrOdbicia += 1;
        odbicia.push({
          id: manifest.add("floorCheckIn", id("fci", nrOdbicia)),
          userId: (k.userId ?? k.guardianUserId)!,
          locationId: salaId,
          enteredAt: new Date(termin.startsAt.getTime() - 8 * 60_000),
        });

        if (chanceOf(rngSali, 0.3)) {
          nrOceny += 1;
          oceny.push({
            id: manifest.add("rating", id("rat", nrOceny)),
            sessionId: termin.id,
            memberId: k.memberId,
            score: intBetween(rngSali, 4, 5),
            comment: chanceOf(rngSali, 0.5) ? pickFrom(rngSali, KOMENTARZE_OCEN) : null,
            createdAt: termin.endsAt,
          });
        }
      }
    }
  }

  await tx.booking.createMany({ data: zapisy });
  await tx.attendance.createMany({ data: obecnosci });
  await tx.rating.createMany({ data: oceny });
  await tx.floorCheckIn.createMany({ data: odbicia });

  // --- Notatki, wdrożenie, retencja, pomiary, odejścia -----------------------
  const rngOpieki = createRng(5005);
  const notatki: Prisma.NoteCreateManyInput[] = [];
  const etapy: Prisma.OnboardingStepCreateManyInput[] = [];
  const alerty: Prisma.RetentionTaskCreateManyInput[] = [];
  const pomiary: Prisma.MeasurementCreateManyInput[] = [];
  const ankiety: Prisma.ChurnSurveyCreateManyInput[] = [];
  let nrNotatki = 0;
  let nrEtapu = 0;
  let nrAlertu = 0;
  let nrPomiaru = 0;
  let nrAnkiety = 0;

  klubowicze.forEach((k) => {
    const autor = trenerzy[k.trainerIdx].userId;

    if (chanceOf(rngOpieki, 0.6)) {
      nrNotatki += 1;
      notatki.push({
        id: manifest.add("note", id("not", nrNotatki)),
        memberId: k.memberId,
        authorUserId: autor,
        kind: "CONTACT" as const,
        body: pickFrom(rngOpieki, NOTATKI),
        createdAt: dzienTemu(now, intBetween(rngOpieki, 1, 40)),
      });
    }

    for (const [nr, offset] of [
      [1, 3],
      [2, 14],
      [3, 84],
    ] as const) {
      const termin = new Date(k.joinedAt.getTime() + offset * 86_400_000);
      if (termin.getTime() > now.getTime()) continue;
      nrEtapu += 1;
      etapy.push({
        id: manifest.add("onboardingStep", id("onb", nrEtapu)),
        memberId: k.memberId,
        step: nr,
        dueAt: termin,
        // Część etapów świadomie niezamknięta - to jest ta luka, którą ekran
        // wdrożenia ma pokazywać.
        completedAt: chanceOf(rngOpieki, 0.7) ? termin : null,
      });
    }

    if (!k.odszedl && chanceOf(rngOpieki, 0.25)) {
      nrAlertu += 1;
      alerty.push({
        id: manifest.add("retentionTask", id("ret", nrAlertu)),
        memberId: k.memberId,
        trainerId: trenerzy[k.trainerIdx].trainerId,
        type: chanceOf(rngOpieki, 0.5) ? ("INACTIVE_7" as const) : ("RENEWAL" as const),
        dueAt: dzienTemu(now, intBetween(rngOpieki, 0, 5)),
      });
    }

    if (chanceOf(rngOpieki, 0.5)) {
      nrPomiaru += 1;
      pomiary.push({
        id: manifest.add("measurement", id("msr", nrPomiaru)),
        memberId: k.memberId,
        recordedByUserId: autor,
        recordedAt: dzienTemu(now, intBetween(rngOpieki, 5, 90)),
        weightKg: 60 + intBetween(rngOpieki, 0, 35),
      });
    }

    if (k.odszedl && powodyOdejscia.length > 0) {
      nrAnkiety += 1;
      ankiety.push({
        id: manifest.add("churnSurvey", id("chn", nrAnkiety)),
        memberId: k.memberId,
        reasonId: pickFrom(rngOpieki, powodyOdejscia).id,
        comment: "Ankieta demonstracyjna.",
        sentAt: dzienTemu(now, intBetween(rngOpieki, 5, 50)),
        answeredAt: dzienTemu(now, intBetween(rngOpieki, 1, 4)),
      });
    }
  });

  await tx.note.createMany({ data: notatki });
  await tx.onboardingStep.createMany({ data: etapy });
  await tx.retentionTask.createMany({ data: alerty });
  await tx.measurement.createMany({ data: pomiary });
  if (ankiety.length > 0) await tx.churnSurvey.createMany({ data: ankiety });
}
