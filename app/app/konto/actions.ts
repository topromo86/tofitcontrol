"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireRole, requireSession } from "@/lib/auth/guard";
import { prisma } from "@/lib/prisma";
import { isValidEmail, normalizeEmail } from "@/lib/domain/registration";
import { PHONE_ERROR_MESSAGE, parsePhone } from "@/lib/domain/phone";

// Rodzic PROSI o wgląd w grafik dziecka - powiązanie aktywuje dopiero admin
// (dostęp do danych dziecka jest wrażliwy). Tu tylko zakładamy prośbę i, jeśli
// się da, od razu dowiązujemy pasującą kartotekę po e-mailu, żeby ułatwić
// adminowi decyzję. Samo powiązanie (Member.guardianUserId) ustawia dopiero
// zatwierdzenie w /admin/zatwierdzenia.
export async function requestGuardianLinkAction(formData: FormData) {
  const session = await requireRole("MEMBER", "GUARDIAN");
  const childEmail = normalizeEmail(String(formData.get("childEmail") ?? ""));

  function back(code: string) {
    redirect(`/app/konto?req=${code}`);
  }

  if (!isValidEmail(childEmail)) back("ZLY_EMAIL");

  // Nie można prosić o powiązanie z samym sobą.
  const me = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { email: true },
  });
  if (me?.email && normalizeEmail(me.email) === childEmail) back("TO_TY");

  // Próba dopasowania kartoteki po adresie: login dziecka (User.email) albo
  // e-mail kontaktowy na kartotece (Member.email). Bierzemy tylko jedno,
  // jednoznaczne trafienie - przy niejednoznaczności zostawiamy adminowi.
  const candidates = await prisma.member.findMany({
    where: {
      status: { not: "CHURNED" },
      OR: [{ email: childEmail }, { user: { email: childEmail } }],
    },
    select: { id: true, guardianUserId: true },
    take: 2,
  });
  const match = candidates.length === 1 ? candidates[0] : null;

  // Już jesteś opiekunem tego dziecka - nie ma o co prosić.
  if (match && match.guardianUserId === session.user.id) back("JUZ_POWIAZANE");

  // Nie dubluj otwartej prośby o ten sam adres.
  const existing = await prisma.guardianLinkRequest.findFirst({
    where: { requesterUserId: session.user.id, childEmail, status: "PENDING" },
    select: { id: true },
  });
  if (existing) back("JUZ_WYSLANE");

  await prisma.guardianLinkRequest.create({
    data: {
      requesterUserId: session.user.id,
      childEmail,
      memberId: match?.id ?? null,
    },
  });

  revalidatePath("/app/konto");
  back("WYSLANO");
}

// Zapis numeru telefonu na koncie.
//
// Numer jest wymagany przy rejestracji, ale konta zalozone WCZESNIEJ go nie
// maja - a klub dzwoni czesciej, niz pisze. To jest miejsce, w ktorym da sie
// go uzupelnic bez chodzenia do klubu.
export async function savePhoneAction(formData: FormData) {
  const session = await requireSession();
  const raw = String(formData.get("phone") ?? "");

  const numer = parsePhone(raw);
  if ("error" in numer) {
    redirect(`/app/konto?tel=${encodeURIComponent(PHONE_ERROR_MESSAGE[numer.error])}`);
  }

  await prisma.user.update({
    where: { id: session.user.id },
    data: { phone: numer.phone },
  });

  revalidatePath("/app/konto");
  redirect("/app/konto?tel=ok");
}
