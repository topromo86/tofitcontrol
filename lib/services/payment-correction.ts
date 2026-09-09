import "server-only";

import { prisma } from "@/lib/prisma";
import { logActivity } from "@/lib/services/activity";
import { isCashDayClosed, recalcCashDay } from "@/lib/jobs/close-cash-day";
import {
  CANCEL_MESSAGE,
  planCancellation,
  type CancelError,
} from "@/lib/domain/payment-correction";
import { todayInTimeZone } from "@/lib/domain/time";
import { formatMoney } from "@/lib/format";
import { settlePass, sumPayments } from "@/lib/domain/payment-status";

// Anulowanie wpłaty wpisanej przez pomyłkę.
//
// Dla klubu to jest "usuń tę wpłatę". W bazie to wpis odwracający na dokładnie
// tę samą kwotę, wskazujący oryginał przez `correctsPaymentId` - bo na Payment
// wiszą karnety, karty podarunkowe i zamknięcia kasy, a wszystkie klucze obce
// są `SetNull`: twarde DELETE nie odbiłoby się o bazę, tylko zostawiło kartę
// podarunkową bez zapisu przychodu i osieroconą realizację.
//
// Wpis odwracający dostaje datę ORYGINAŁU, nie dzisiejszą. Inaczej wpłata
// gotówkowa z wtorku znikałaby z wtorkowej kasy dopiero w czwartek i oba dni
// pokazywałyby nieprawdę.

export type CancelPaymentResult =
  | { ok: false; reason: CancelError | "KASA_ZAMKNIETA" | "KARTA_UZYTA"; message: string }
  | { ok: true; deltaGross: number; ostrzezenie: string | null };

export async function cancelPayment(input: {
  paymentId: string;
  actorUserId: string;
  note: string;
  now: Date;
}): Promise<CancelPaymentResult> {
  const payment = await prisma.payment.findUniqueOrThrow({
    where: { id: input.paymentId },
    include: {
      member: { select: { firstName: true, lastName: true } },
      corrections: { select: { amountGross: true } },
      soldGiftCard: { select: { id: true, code: true, initialGross: true, balanceGross: true } },
      giftRedemptions: { select: { id: true, giftCardId: true, amountGross: true } },
      pass: { select: { id: true, priceGross: true, plan: { select: { name: true } } } },
    },
  });

  const plan = planCancellation({
    payment: { amountGross: payment.amountGross, correctsPaymentId: payment.correctsPaymentId },
    corrections: payment.corrections,
    note: input.note,
  });
  if (!plan.ok) return { ok: false, reason: plan.reason, message: CANCEL_MESSAGE[plan.reason] };

  const dzienWplaty = todayInTimeZone(payment.recordedAt);

  // Gotówka z dnia, którego kasa jest już zamknięta: odmawiamy, zamiast
  // zapisywać korektę, której to rozliczenie nigdy nie zobaczy. Zamkniętego
  // dnia w tym systemie nie da się otworzyć, więc cicha zmiana zostawiłaby
  // właścicielowi manko bez wyjaśnienia.
  if (
    payment.method === "CASH" &&
    (await isCashDayClosed(prisma, payment.locationId, dzienWplaty))
  ) {
    return {
      ok: false,
      reason: "KASA_ZAMKNIETA",
      message:
        "Kasa tej sali za dzień tej wpłaty jest już zamknięta, więc nie da się jej cofnąć bez " +
        "rozjechania rozliczenia. Rozlicz to z klientem osobno i opisz w notatce.",
    };
  }

  // Wpłata, za którą klub wydał kartę podarunkową: jeśli ktoś już nią zapłacił,
  // cofnięcie zapłaty za kartę zostawiłoby klub bez pieniędzy i bez towaru.
  if (
    payment.soldGiftCard &&
    payment.soldGiftCard.balanceGross < payment.soldGiftCard.initialGross
  ) {
    return {
      ok: false,
      reason: "KARTA_UZYTA",
      message: `Za tę wpłatę wydano kartę podarunkową ${payment.soldGiftCard.code}, z której już korzystano. Najpierw rozlicz kartę.`,
    };
  }

  await prisma.$transaction(async (tx) => {
    await tx.payment.create({
      data: {
        memberId: payment.memberId,
        passId: payment.passId,
        amountGross: plan.deltaGross,
        method: payment.method,
        locationId: payment.locationId,
        recordedByUserId: input.actorUserId,
        // Data oryginału - patrz komentarz na górze pliku.
        recordedAt: payment.recordedAt,
        correctsPaymentId: payment.id,
        note: `Anulowano wpłatę (pomyłka): ${input.note.trim()}`,
      },
    });

    // Karta podarunkowa, którą dopłacono do tej wpłaty: saldo wraca. Wpisem
    // przeciwnym, nie skasowaniem realizacji - historia karty ma zostać.
    for (const realizacja of payment.giftRedemptions) {
      await tx.giftCardRedemption.create({
        data: {
          giftCardId: realizacja.giftCardId,
          paymentId: null,
          amountGross: -realizacja.amountGross,
        },
      });
      await tx.giftCard.update({
        where: { id: realizacja.giftCardId },
        data: { balanceGross: { increment: realizacja.amountGross } },
      });
    }

    // Karta wydana za tę wpłatę i nietknięta - gasimy ją, bo nie została
    // opłacona.
    if (payment.soldGiftCard) {
      await tx.giftCard.update({
        where: { id: payment.soldGiftCard.id },
        data: { active: false, note: `Anulowano wpłatę za kartę: ${input.note.trim()}` },
      });
    }

    // Kod rabatowy użyty przy tej sprzedaży wraca do puli.
    if (payment.promoCodeId) {
      await tx.promoCode.updateMany({
        where: { id: payment.promoCodeId, usedCount: { gt: 0 } },
        data: { usedCount: { decrement: 1 } },
      });
    }

    // Kasa dnia, którego dotyczyła wpłata - przeliczana od razu, bo nocny job
    // wraca tylko do dnia, w którym się odpala.
    if (payment.method === "CASH") {
      await recalcCashDay(tx, payment.locationId, dzienWplaty);
    }

    await logActivity(tx, {
      actorUserId: input.actorUserId,
      action: "PAYMENT_CORRECTED",
      memberId: payment.memberId,
      summary:
        `Anulowano wpłatę ${formatMoney(payment.amountGross)} ` +
        `(${payment.method}, ${payment.recordedAt.toISOString().slice(0, 10)}) ` +
        `dla ${payment.member.firstName} ${payment.member.lastName}: ${input.note.trim()}`,
    });
  });

  // Karnet zostaje - to osobna decyzja człowieka. Ale właściciel MUSI o tym
  // wiedzieć, bo po cofnięciu wpłaty kasa trenera znów pokaże ten karnet jako
  // niedopłacony i podsunie pobranie tych samych pieniędzy drugi raz.
  let ostrzezenie: string | null = null;
  if (payment.pass) {
    const pozostale = await prisma.payment.findMany({
      where: { passId: payment.pass.id },
      select: { amountGross: true },
    });
    const rozliczenie = settlePass(payment.pass.priceGross, sumPayments(pozostale));
    if (rozliczenie.outstandingGross > 0) {
      ostrzezenie =
        `Karnet "${payment.pass.plan.name}" ma teraz do zapłaty ` +
        `${formatMoney(rozliczenie.outstandingGross)}. Jeśli cała sprzedaż była pomyłką, ` +
        `anuluj też karnet - inaczej kasa poprosi o te pieniądze ponownie.`;
    }
  }

  return { ok: true, deltaGross: plan.deltaGross, ostrzezenie };
}
