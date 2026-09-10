"use server";

import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireRole } from "@/lib/auth/guard";
import { logActivity } from "@/lib/services/activity";
import { MAX_FROZEN_DAYS } from "@/lib/domain/pass";
import { safeReturnPath } from "@/lib/domain/return-path";

// Dokąd wrócić po zamrożeniu albo odmrożeniu.
//
// Wcześniej obie akcje kończyły się twardym redirect("/admin"), czyli kasowały
// szukanie, filtry, grupowanie i pozycję przewinięcia. Przy liście, po której
// realnie się scrolluje, oznacza to powrót na górę i szukanie tego samego
// człowieka od nowa.
//
// Adres przychodzi z formularza, więc jest daną od użytkownika - bez
// `safeReturnPath` byłby to otwarty przekierowywacz do phishingu, dokładnie
// ten sam powód, dla którego pilnuje się parametru `?powrot=` przy logowaniu.
function powrotNaListe(formData: FormData): string {
  return safeReturnPath(formData.get("powrot"), ["/admin"], "/admin");
}

// Sprzedaż karnetu (Payment) przeniesiona wyłącznie do trenera - patrz
// /trainer/kasa i lib/services/pass.ts#sellPass. Gotówka realnie zmienia ręce
// przy trenerze, na sali, nie u właściciela w biurze.

// Zamrożenie karnetu (SPEC.md sekcja 2, maks. 30 dni/rok - uproszczone tu do
// 30 dni per Pass, patrz PLAN.md Faza 3). Zamrożenie wstrzymuje zegar: przy
// odmrożeniu liczba faktycznie zamrożonych dni dopisuje się do endsAt, więc
// klient nie traci opłaconego czasu.
export async function freezePassAction(formData: FormData) {
  const session = await requireRole("ADMIN");
  const passId = String(formData.get("passId"));
  const powrot = powrotNaListe(formData);

  const pass = await prisma.pass.findUniqueOrThrow({
    where: { id: passId },
    include: { member: true },
  });

  if (pass.status !== "ACTIVE") {
    throw new Error("Zamrozić można tylko aktywny karnet.");
  }
  if (pass.frozenDaysUsed >= MAX_FROZEN_DAYS) {
    throw new Error(`Wykorzystano już limit ${MAX_FROZEN_DAYS} dni zamrożenia dla tego karnetu.`);
  }

  await prisma.$transaction(async (tx) => {
    await tx.pass.update({
      where: { id: passId },
      data: { status: "FROZEN", frozenAt: new Date() },
    });

    await logActivity(tx, {
      actorUserId: session.user.id,
      action: "PASS_FROZEN",
      memberId: pass.memberId,
      summary: `Zamrożono karnet klienta ${pass.member.firstName} ${pass.member.lastName}`,
    });
  });

  redirect(powrot);
}

export async function unfreezePassAction(formData: FormData) {
  const session = await requireRole("ADMIN");
  const passId = String(formData.get("passId"));
  const powrot = powrotNaListe(formData);

  const pass = await prisma.pass.findUniqueOrThrow({
    where: { id: passId },
    include: { member: true },
  });

  if (pass.status !== "FROZEN" || !pass.frozenAt) {
    throw new Error("Ten karnet nie jest zamrożony.");
  }

  const now = new Date();
  const frozenDays = Math.max(1, Math.ceil((now.getTime() - pass.frozenAt.getTime()) / 86_400_000));
  const newEndsAt = new Date(pass.endsAt.getTime() + frozenDays * 86_400_000);

  await prisma.$transaction(async (tx) => {
    await tx.pass.update({
      where: { id: passId },
      data: {
        status: "ACTIVE",
        frozenAt: null,
        frozenDaysUsed: { increment: frozenDays },
        endsAt: newEndsAt,
      },
    });

    await logActivity(tx, {
      actorUserId: session.user.id,
      action: "PASS_UNFROZEN",
      memberId: pass.memberId,
      summary: `Odmrożono karnet klienta ${pass.member.firstName} ${pass.member.lastName} (${frozenDays} dni zamrożenia, nowy koniec: ${newEndsAt.toISOString().slice(0, 10)})`,
    });
  });

  redirect(powrot);
}
