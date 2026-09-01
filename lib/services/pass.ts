import "server-only";
import { Prisma, type PrismaClient, type PaymentMethod } from "@/app/generated/prisma/client";
import { markJoinedIfNeeded } from "./member";
import { logActivity } from "./activity";
import { formatMoney } from "@/lib/format";
import { settlePass, sumPayments, validatePaymentAmount } from "@/lib/domain/payment-status";
import { pickPassForSession, type SessionKindForPass } from "@/lib/domain/pass";
import {
  applyGiftCard,
  discountedPrice,
  normalizeCode,
  validateGiftCard,
  validatePromoCode,
  GIFT_CARD_ERROR_MESSAGE,
  PROMO_ERROR_MESSAGE,
} from "@/lib/domain/discount";

type Tx = PrismaClient | Prisma.TransactionClient;

// Błąd sprzedaży z komunikatem dla klienta (np. zły kod rabatowy). Akcja łapie
// go i pokazuje treść, zamiast wywracać całą transakcję generycznym 500.
export class SaleError extends Error {}

// Zdejmuje jedno wejście z aktywnego karnetu limitowanego klienta. Wywoływane
// dopiero przy realnej obecności (Attendance) albo spóźnionym odwołaniu
// (NO_SHOW) - nigdy przy samej rezerwacji (SPEC.md sekcja 2: "rezerwacja NIE
// zdejmuje wejścia"). Karnety OPEN (entriesLeft null) są pomijane.
//
// Zwraca id karnetu, z którego zeszło wejście (albo null). Wywołujący zapisuje
// je przy rezerwacji, żeby ewentualny zwrot trafił dokładnie tam, skąd wejście
// zeszło - klient mógł w międzyczasie kupić nowy karnet.
export async function decrementPassEntryIfLimited(
  tx: Tx,
  memberId: string,
  kind: SessionKindForPass,
): Promise<string | null> {
  const pass = await findPassForSession(tx, memberId, kind);
  if (pass && pass.entriesLeft != null) {
    await tx.pass.update({ where: { id: pass.id }, data: { entriesLeft: { decrement: 1 } } });
    return pass.id;
  }
  return null;
}

// Karnet, który obsługuje zajęcia danego rodzaju - jedno miejsce dla zapisu
// (czy klient w ogóle ma czym zapłacić) i dla zdjęcia wejścia. Gdyby te dwa
// pytania odpowiadały sobie różnymi karnetami, klient przechodziłby kontrolę
// na jednym karnecie, a wejście schodziłoby z drugiego.
export async function findPassForSession(tx: Tx, memberId: string, kind: SessionKindForPass) {
  const passes = await tx.pass.findMany({
    where: { memberId, status: "ACTIVE" },
    include: { plan: { select: { forIndividual: true } } },
  });

  const chosen = pickPassForSession(
    passes.map((p) => ({
      id: p.id,
      endsAt: p.endsAt,
      entriesLeft: p.entriesLeft,
      forIndividual: p.plan.forIndividual,
    })),
    kind,
  );

  return chosen ? (passes.find((p) => p.id === chosen.id) ?? null) : null;
}

// Zwrot wejścia na konkretny karnet - odwrotność powyższego. Świadomie bez
// sprawdzania, czy karnet jest wciąż aktywny: jeśli trener uznaje, że wejście
// się należy, ma wrócić tam, skąd zeszło, nawet gdy karnet zdążył wygasnąć.
export async function refundPassEntry(tx: Tx, passId: string) {
  const pass = await tx.pass.findUnique({ where: { id: passId } });
  if (pass && pass.entriesLeft != null) {
    await tx.pass.update({ where: { id: passId }, data: { entriesLeft: { increment: 1 } } });
  }
}

// Sprzedaż karnetu (SPEC.md sekcja 2 "Sprzedaż karnetu"): Pass + Payment w
// jednej transakcji. Współdzielone przez ekran admina i ekran „Kasa" trenera -
// gotówka realnie zmienia ręce przy trenerze, na sali, więc to on najczęściej
// wykonuje tę akcję (CLAUDE.md: kasa musi działać w 15 s na telefonie).
// Strażnik mieszania demo z danymi klubu. Jedno miejsce, bo sprzedaż i dopłata
// mają tę samą regułę, a rozjazd między nimi byłby dziurą.
function assertNoDemoMix(input: {
  member: { isDemo: boolean; firstName: string; lastName: string };
  plan: { isDemo: boolean; name: string };
  location: { isDemo: boolean; name: string };
  method: PaymentMethod;
}): void {
  const { member, plan, location, method } = input;

  if (member.isDemo !== plan.isDemo) {
    throw new SaleError(
      member.isDemo
        ? `${member.firstName} ${member.lastName} to kartoteka demonstracyjna - wybierz karnet z demonstracyjnego cennika. Karnet z cennika klubu zostawiłby po sobie licznik sprzedaży i wpłatę w kasie klubu.`
        : `"${plan.name}" to demonstracyjny rodzaj karnetu - nie sprzedawaj go prawdziwemu klientowi. Po usunięciu danych demonstracyjnych ten karnet nie miałby się do czego odnosić.`,
    );
  }

  if (member.isDemo && !location.isDemo) {
    throw new SaleError(
      `Sprzedaż demonstracyjna musi być zapisana w sali pokazowej, a nie w "${location.name}". Wpłata w prawdziwej sali weszłaby do zamknięcia kasy klubu, którego nie da się później otworzyć.`,
    );
  }

  if (member.isDemo && method === "CASH") {
    throw new SaleError(
      "Demonstracyjna wpłata nie może być gotówką: kasa sumuje gotówkę per sala i dzień, a zamkniętego dnia nie da się w tym systemie otworzyć. Wybierz przelew albo BLIK.",
    );
  }
}

export async function sellPass(
  tx: Tx,
  params: {
    memberId: string;
    planId: string;
    locationId: string;
    method: PaymentMethod;
    actorUserId: string;
    now: Date;
    // Opcjonalny kod rabatowy i karta podarunkowa. amountGross to gotówka
    // realnie pobrana - po rabacie i po odjęciu tego, co pokryła karta.
    promoCode?: string | null;
    giftCardCode?: string | null;
    // Ile klient wpłaca TERAZ. Pominięte = płaci całość. Mniejsza kwota tworzy
    // karnet z zaległością, którą widać w kasie i na karcie klienta.
    paidGross?: number;
  },
) {
  const [plan, currentActivePass, member, location] = await Promise.all([
    tx.plan.findUniqueOrThrow({ where: { id: params.planId } }),
    tx.pass.findFirst({
      where: { memberId: params.memberId, status: "ACTIVE" },
      orderBy: { endsAt: "desc" },
    }),
    tx.member.findUniqueOrThrow({ where: { id: params.memberId } }),
    tx.location.findUniqueOrThrow({ where: { id: params.locationId } }),
  ]);

  // Dane demonstracyjne i dane klubu nie mieszają się w pieniądzach.
  //
  // Generator trzyma demo osobno (własna sala, własny cennik), ale ten ekran
  // pozwala wybrać dowolne połączenie - i każde z nich zostawia trwały ślad
  // po usunięciu demo: wpłata demonstracyjnego klienta w prawdziwej sali
  // wchodzi do zamknięcia kasy, którego nie da się już otworzyć, a karnet
  // prawdziwego klienta na demonstracyjnym cenniku blokuje usunięcie demo.
  assertNoDemoMix({ member, plan, location, method: params.method });

  // 1. Kod rabatowy: obniża cenę planu. Walidacja w transakcji, żeby limit
  //    użyć i termin liczyły się na moment sprzedaży, nie na podgląd wcześniej.
  let priceGross = plan.priceGross;
  let promo = null;
  const promoRaw = params.promoCode?.trim();
  if (promoRaw) {
    promo = await tx.promoCode.findUnique({ where: { code: normalizeCode(promoRaw) } });
    if (!promo) throw new SaleError("Nie znaleziono takiego kodu rabatowego.");
    const err = validatePromoCode(promo, { planId: params.planId, now: params.now });
    if (err) throw new SaleError(PROMO_ERROR_MESSAGE[err]);
    priceGross = discountedPrice(plan.priceGross, promo.kind, promo.value);
  }

  // 2. Karta podarunkowa: pokrywa część (albo całość) należności po rabacie.
  let giftCard = null;
  let giftApplied = 0;
  const giftRaw = params.giftCardCode?.trim();
  if (giftRaw) {
    giftCard = await tx.giftCard.findUnique({ where: { code: normalizeCode(giftRaw) } });
    if (!giftCard) throw new SaleError("Nie znaleziono takiej karty podarunkowej.");
    const err = validateGiftCard(giftCard, params.now);
    if (err) throw new SaleError(GIFT_CARD_ERROR_MESSAGE[err]);
    giftApplied = applyGiftCard(priceGross, giftCard.balanceGross).applied;
  }

  // Do zapłaty gotówką: cena po rabacie minus to, co pokryła karta podarunkowa
  // (ta część jest już opłacona z góry). To ta kwota rozlicza karnet.
  const cashGross = priceGross - giftApplied;

  // Klient może wpłacić mniej - klub przyjmuje zaliczki. Brak wartości znaczy
  // "płaci całość".
  const paidNow = params.paidGross ?? cashGross;
  if (paidNow < 0) throw new SaleError("Kwota wpłaty nie może być ujemna.");
  if (paidNow > cashGross) {
    throw new SaleError(
      `Wpłata (${formatMoney(paidNow)}) przekracza należność (${formatMoney(cashGross)}).`,
    );
  }

  // Jeśli klient ma jeszcze aktywny karnet - nowy startuje od endsAt starego,
  // nie od dziś (SPEC.md sekcja 2: "inaczej okradasz klienta z dni").
  const startsAt =
    currentActivePass && currentActivePass.endsAt > params.now
      ? currentActivePass.endsAt
      : params.now;
  const endsAt = new Date(startsAt.getTime() + plan.durationDays * 86_400_000);

  const pass = await tx.pass.create({
    data: {
      memberId: params.memberId,
      planId: params.planId,
      priceGross: cashGross,
      startsAt,
      endsAt,
      entriesLeft: plan.entriesPerMonth,
      status: "ACTIVE",
      soldByUserId: params.actorUserId,
    },
  });

  // Wpłata zerowa (karnet "na potem") nie tworzy wpisu w kasie - inaczej
  // zaśmiecałaby raport dnia zerowymi pozycjami.
  const payment =
    paidNow > 0
      ? await tx.payment.create({
          data: {
            memberId: params.memberId,
            passId: pass.id,
            amountGross: paidNow,
            method: params.method,
            locationId: params.locationId,
            recordedByUserId: params.actorUserId,
            promoCodeId: promo?.id ?? null,
          },
        })
      : null;

  // 3. Zapisz zużycie kodu i realizację karty (zmniejsz saldo). Po sprzedaży,
  //    żeby liczyły się tylko przy realnie zawartej transakcji.
  if (promo) {
    await tx.promoCode.update({
      where: { id: promo.id },
      data: { usedCount: { increment: 1 } },
    });
  }
  if (giftCard && giftApplied > 0) {
    await tx.giftCardRedemption.create({
      data: { giftCardId: giftCard.id, paymentId: payment?.id ?? null, amountGross: giftApplied },
    });
    await tx.giftCard.update({
      where: { id: giftCard.id },
      data: { balanceGross: { decrement: giftApplied } },
    });
  }

  // Pierwsza opłacona transakcja = joinedAt. Przy samej zaliczce też liczymy -
  // klient realnie dołączył do klubu, choć nie rozliczył się do końca.
  if (paidNow > 0 || giftApplied > 0) {
    await markJoinedIfNeeded(tx, params.memberId, params.now);
  }

  const parts = [`Sprzedano karnet "${plan.name}" (${formatMoney(cashGross)})`];
  if (paidNow < cashGross) {
    parts.push(`wpłata ${formatMoney(paidNow)}, do dopłaty ${formatMoney(cashGross - paidNow)}`);
  }
  if (promo) parts.push(`kod ${promo.code}`);
  if (giftApplied > 0) parts.push(`karta ${formatMoney(giftApplied)}`);
  await logActivity(tx, {
    actorUserId: params.actorUserId,
    action: "PASS_SOLD",
    memberId: params.memberId,
    summary: `${parts.join(", ")} - klient ${member.firstName} ${member.lastName}`,
  });

  return pass;
}

// Dopłata do karnetu już sprzedanego - klient wraca i wyrównuje zaległość.
// Osobna funkcja, bo nie tworzy karnetu ani nie rusza rabatów: dokłada wyłącznie
// wpłatę do istniejącego rozliczenia.
export async function recordPassPayment(
  tx: Tx,
  params: {
    passId: string;
    amountGross: number;
    method: PaymentMethod;
    locationId: string;
    actorUserId: string;
    now: Date;
  },
) {
  const invalid = validatePaymentAmount(params.amountGross);
  if (invalid) throw new SaleError(invalid);

  const pass = await tx.pass.findUniqueOrThrow({
    where: { id: params.passId },
    include: { plan: true, member: true, payments: { select: { amountGross: true } } },
  });

  // Ta sama reguła co przy sprzedaży - dopłata to też wpłata i tak samo
  // wchodzi do kasy sali, którą wskaże formularz.
  const location = await tx.location.findUniqueOrThrow({ where: { id: params.locationId } });
  assertNoDemoMix({ member: pass.member, plan: pass.plan, location, method: params.method });

  const before = settlePass(pass.priceGross, sumPayments(pass.payments));
  if (before.outstandingGross === 0) {
    throw new SaleError(`Karnet "${pass.plan.name}" jest już rozliczony.`);
  }
  if (params.amountGross > before.outstandingGross) {
    throw new SaleError(
      `Do dopłaty zostało ${formatMoney(before.outstandingGross)} - podana kwota jest wyższa.`,
    );
  }

  await tx.payment.create({
    data: {
      memberId: pass.memberId,
      passId: pass.id,
      amountGross: params.amountGross,
      method: params.method,
      locationId: params.locationId,
      recordedByUserId: params.actorUserId,
    },
  });

  // Dopłata też może być pierwszą realną wpłatą klienta (gdy karnet założono
  // z zerową zaliczką).
  await markJoinedIfNeeded(tx, pass.memberId, params.now);

  const after = settlePass(pass.priceGross, sumPayments(pass.payments) + params.amountGross);
  const stan =
    after.outstandingGross === 0
      ? "rozliczony w całości"
      : `zostaje ${formatMoney(after.outstandingGross)}`;

  await logActivity(tx, {
    actorUserId: params.actorUserId,
    action: "PASS_SOLD",
    memberId: pass.memberId,
    summary:
      `Przyjęto wpłatę ${formatMoney(params.amountGross)} do karnetu "${pass.plan.name}" ` +
      `(${stan}) - klient ${pass.member.firstName} ${pass.member.lastName}`,
  });

  return after;
}
