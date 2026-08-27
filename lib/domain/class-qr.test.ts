import { describe, expect, it } from "vitest";
import {
  checkScanTime,
  classifyTrainerCheckIn,
  isQrOpen,
  judgeTrainerScan,
  qrWindow,
  trainerDeadline,
} from "./class-qr";

const MINUTE = 60_000;
const START = new Date("2026-08-10T17:00:00Z");
const END = new Date("2026-08-10T18:00:00Z");
const session = { startsAt: START, endsAt: END, status: "SCHEDULED" };

function minutesFromStart(minutes: number): Date {
  return new Date(START.getTime() + minutes * MINUTE);
}

describe("qrWindow", () => {
  it("otwiera się na zadaną liczbę minut przed startem", () => {
    expect(qrWindow(session, 15).opensAt).toEqual(minutesFromStart(-15));
  });

  it("zamyka się z końcem zajęć", () => {
    expect(qrWindow(session, 15).closesAt).toEqual(END);
  });
});

describe("isQrOpen", () => {
  it("zamknięty 16 minut przed startem", () => {
    expect(isQrOpen(session, minutesFromStart(-16), 15)).toBe(false);
  });

  it("otwarty dokładnie 15 minut przed startem", () => {
    expect(isQrOpen(session, minutesFromStart(-15), 15)).toBe(true);
  });

  it("otwarty w trakcie zajęć", () => {
    expect(isQrOpen(session, minutesFromStart(30), 15)).toBe(true);
  });

  it("zamknięty po zakończeniu", () => {
    expect(isQrOpen(session, minutesFromStart(61), 15)).toBe(false);
  });

  it("dłuższe okno wpuszcza wcześniej", () => {
    expect(isQrOpen(session, minutesFromStart(-25), 30)).toBe(true);
  });
});

describe("trainerDeadline", () => {
  it("liczy termin od startu zajęć", () => {
    expect(trainerDeadline(session, 5)).toEqual(minutesFromStart(-5));
  });
});

describe("classifyTrainerCheckIn", () => {
  const call = (checkedInAt: Date | null, now: Date) =>
    classifyTrainerCheckIn({ session, checkedInAt, now, minutesBefore: 5 });

  it("odbicie przed terminem jest na czas", () => {
    expect(call(minutesFromStart(-10), minutesFromStart(-10))).toBe("ON_TIME");
  });

  it("odbicie dokładnie na termin jeszcze się liczy", () => {
    expect(call(minutesFromStart(-5), minutesFromStart(-5))).toBe("ON_TIME");
  });

  it("odbicie po terminie to spóźnienie", () => {
    expect(call(minutesFromStart(-4), minutesFromStart(-4))).toBe("LATE");
  });

  // Zanim minie termin, brak odbicia to nie jest jeszcze problem - nie ma po co
  // zawracać właścicielowi głowy.
  it("przed terminem brak odbicia to zwykłe oczekiwanie", () => {
    expect(call(null, minutesFromStart(-10))).toBe("PENDING");
  });

  it("po terminie brak odbicia to alert", () => {
    expect(call(null, minutesFromStart(-1))).toBe("MISSING");
  });
});

describe("checkScanTime", () => {
  it("wpuszcza w oknie", () => {
    expect(checkScanTime(session, minutesFromStart(-10), 15)).toBeNull();
  });

  it("odrzuca za wcześnie", () => {
    expect(checkScanTime(session, minutesFromStart(-20), 15)).toBe("TOO_EARLY");
  });

  it("odrzuca po zajęciach", () => {
    expect(checkScanTime(session, minutesFromStart(90), 15)).toBe("TOO_LATE");
  });

  it("odrzuca odwołane zajęcia nawet w oknie", () => {
    expect(checkScanTime({ ...session, status: "CANCELLED" }, minutesFromStart(-10), 15)).toBe(
      "SESSION_CANCELLED",
    );
  });
});

describe("judgeTrainerScan", () => {
  const LEAD = "user-prowadzacy";
  const INNY = "user-inny-trener";

  it("prowadzący to prowadzący", () => {
    expect(
      judgeTrainerScan({
        leadUserId: LEAD,
        scannerUserId: LEAD,
        scannerIsTrainer: true,
        trainerCheckedInUserId: null,
      }),
    ).toBe("LEAD");
  });

  it("klubowicz bez rekordu trenera idzie zwykłą drogą", () => {
    expect(
      judgeTrainerScan({
        leadUserId: LEAD,
        scannerUserId: "user-klubowicz",
        scannerIsTrainer: false,
        trainerCheckedInUserId: null,
      }),
    ).toBe("NOT_TRAINER");
  });

  it("inny trener przy braku odbicia to zastępstwo bez wpisu", () => {
    expect(
      judgeTrainerScan({
        leadUserId: LEAD,
        scannerUserId: INNY,
        scannerIsTrainer: true,
        trainerCheckedInUserId: null,
      }),
    ).toBe("STAND_IN");
  });

  it("inny trener, gdy prowadzący już się odbił - nie ma czego zastępować", () => {
    expect(
      judgeTrainerScan({
        leadUserId: LEAD,
        scannerUserId: INNY,
        scannerIsTrainer: true,
        trainerCheckedInUserId: LEAD,
      }),
    ).toBe("CHECK_IN_TAKEN");
  });

  it("druga próba tego samego zastępcy nie jest kolejnym zastępstwem", () => {
    // Bez tego kamera widząca ten sam kod przez kilka klatek zasypywałaby
    // właściciela powiadomieniami o jednym zdarzeniu.
    expect(
      judgeTrainerScan({
        leadUserId: LEAD,
        scannerUserId: INNY,
        scannerIsTrainer: true,
        trainerCheckedInUserId: INNY,
      }),
    ).toBe("CHECK_IN_TAKEN");
  });

  it("potwierdzony zastępca JEST prowadzącym - liczy się leadUserId, nie grafik", () => {
    // leadUserId wylicza lib/domain/substitute.ts; tutaj sprawdzamy tylko, że
    // ta funkcja nie ma własnego zdania na temat zastępstw.
    expect(
      judgeTrainerScan({
        leadUserId: INNY,
        scannerUserId: INNY,
        scannerIsTrainer: true,
        trainerCheckedInUserId: null,
      }),
    ).toBe("LEAD");
  });
});

describe("classifyTrainerCheckIn - kto się odbił", () => {
  const LEAD = "user-prowadzacy";
  const INNY = "user-inny-trener";

  it("odbicie prowadzącego w terminie zostaje na zielono", () => {
    expect(
      classifyTrainerCheckIn({
        session,
        checkedInAt: minutesFromStart(-10),
        checkedInUserId: LEAD,
        leadUserId: LEAD,
        now: minutesFromStart(0),
        minutesBefore: 5,
      }),
    ).toBe("ON_TIME");
  });

  it("odbicie kogoś innego nie jest 'trener odbity', choćby było w terminie", () => {
    expect(
      classifyTrainerCheckIn({
        session,
        checkedInAt: minutesFromStart(-10),
        checkedInUserId: INNY,
        leadUserId: LEAD,
        now: minutesFromStart(0),
        minutesBefore: 5,
      }),
    ).toBe("OTHER_TRAINER");
  });

  it("bez wiedzy o kontach zostaje sama punktualność", () => {
    // Ekrany, które nie mają pod ręką prowadzącego, mają działać jak dotąd.
    expect(
      classifyTrainerCheckIn({
        session,
        checkedInAt: minutesFromStart(-10),
        now: minutesFromStart(0),
        minutesBefore: 5,
      }),
    ).toBe("ON_TIME");
  });

  it("brak odbicia po terminie to nadal MISSING, kimkolwiek jest prowadzący", () => {
    expect(
      classifyTrainerCheckIn({
        session,
        checkedInAt: null,
        checkedInUserId: null,
        leadUserId: LEAD,
        now: minutesFromStart(0),
        minutesBefore: 5,
      }),
    ).toBe("MISSING");
  });
});
