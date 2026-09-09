"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireRole } from "@/lib/auth/guard";
import { logActivity } from "@/lib/services/activity";
import { formatMoney } from "@/lib/format";
import { redirect } from "next/navigation";
import { cancelPayment, changePaymentDate } from "@/lib/services/payment-correction";
import { safeReturnPath } from "@/lib/domain/return-path";

// Payment jest append-only (reguła 11 CLAUDE.md) - korekta to NOWY wpis
// wskazujący przez correctsPaymentId na oryginał, nigdy edycja ani usunięcie.
// amountGross korekty to DELTA (ujemna = zwrot, dodatnia = dopłata) - suma
// wszystkich wpisów danego klienta to jego rzeczywisty rozrachunek.
export async function correctPaymentAction(formData: FormData) {
  const session = await requireRole("ADMIN");
  const paymentId = String(formData.get("paymentId"));
  const deltaZlRaw = String(formData.get("deltaZl") ?? "");
  const note = String(formData.get("note") ?? "").trim();

  const deltaZl = Number(deltaZlRaw.replace(",", "."));
  if (!Number.isFinite(deltaZl) || deltaZl === 0) {
    throw new Error("Podaj niezerową kwotę korekty (dodatnią dla dopłaty, ujemną dla zwrotu).");
  }
  if (note.length < 5) {
    throw new Error("Korekta wymaga powodu (min. 5 znaków).");
  }

  const original = await prisma.payment.findUniqueOrThrow({
    where: { id: paymentId },
    include: { member: true },
  });

  const deltaGross = Math.round(deltaZl * 100);

  await prisma.$transaction(async (tx) => {
    await tx.payment.create({
      data: {
        memberId: original.memberId,
        passId: original.passId,
        amountGross: deltaGross,
        method: original.method,
        locationId: original.locationId,
        recordedByUserId: session.user.id,
        correctsPaymentId: original.id,
        note,
      },
    });

    await logActivity(tx, {
      actorUserId: session.user.id,
      action: "PAYMENT_CORRECTED",
      memberId: original.memberId,
      summary: `Korekta płatności ${formatMoney(original.amountGross)} dla ${original.member.firstName} ${original.member.lastName}: ${deltaGross > 0 ? "+" : ""}${formatMoney(deltaGross)} - ${note}`,
    });
  });

  revalidatePath("/admin/finanse");
}

// "Pomyłka - anuluj wpłatę". Dla klubu to jest usunięcie; w bazie wpis
// odwracający, bo na wpłatę wiszą karnety, karty podarunkowe i zamknięcia kasy.
// Cała reguła (ile odwrócić, czego nie wolno) siedzi w
// lib/services/payment-correction.ts, żeby dała się sprawdzić bez ekranu.
export async function cancelPaymentAction(formData: FormData) {
  const session = await requireRole("ADMIN");
  const paymentId = String(formData.get("paymentId"));
  const note = String(formData.get("note") ?? "");
  // Adres powrotu idzie z formularza, więc musi przejść przez strażnika -
  // inaczej byłby to otwarty przekierowywacz.
  const powrot = safeReturnPath(
    formData.get("returnTo"),
    ["/admin/finanse", "/admin/klienci"],
    "/admin/finanse",
  );

  const wynik = await cancelPayment({
    paymentId,
    actorUserId: session.user.id,
    note,
    now: new Date(),
  });

  if (!wynik.ok) {
    redirect(`${powrot}?blad=${encodeURIComponent(wynik.message)}`);
  }

  revalidatePath("/admin/finanse");
  revalidatePath("/admin/kasa");
  revalidatePath("/admin/wplaty");
  revalidatePath("/trainer/kasa");

  const komunikat = wynik.ostrzezenie
    ? `Wpłata anulowana. ${wynik.ostrzezenie}`
    : "Wpłata anulowana.";
  redirect(`${powrot}?info=${encodeURIComponent(komunikat)}`);
}

// Poprawienie daty wpłaty. Osobno od anulowania, bo to nie jest cofnięcie
// pieniędzy, tylko przestawienie ich do właściwego dnia - a od dnia zależy,
// w której kasie się liczą.
export async function changePaymentDateAction(formData: FormData) {
  const session = await requireRole("ADMIN");
  const paymentId = String(formData.get("paymentId"));
  const rawDate = String(formData.get("dataWplaty") ?? "");
  const powrot = safeReturnPath(
    formData.get("returnTo"),
    ["/admin/finanse", "/admin/klienci"],
    "/admin/finanse",
  );

  const wynik = await changePaymentDate({
    paymentId,
    actorUserId: session.user.id,
    rawDate,
    now: new Date(),
  });

  if (!wynik.ok) redirect(`${powrot}?blad=${encodeURIComponent(wynik.message)}`);

  revalidatePath("/admin/finanse");
  revalidatePath("/admin/kasa");
  revalidatePath("/admin/wplaty");

  const opis =
    `Data wpłaty zmieniona na ${wynik.na.toISOString().slice(0, 10)}.` +
    (wynik.korekt > 0 ? ` Korekty (${wynik.korekt}) przesunięte razem z nią.` : "") +
    // Ważność karnetu liczy się od sprzedaży, więc idzie razem z datą - i klub
    // ma to zobaczyć, bo to jest zmiana widoczna dla klienta.
    (wynik.karnetDo ? ` Karnet ważny teraz do ${wynik.karnetDo.toISOString().slice(0, 10)}.` : "");
  redirect(`${powrot}?info=${encodeURIComponent(opis)}`);
}
