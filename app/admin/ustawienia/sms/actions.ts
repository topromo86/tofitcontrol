"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth/guard";
import { prisma } from "@/lib/prisma";
import { parsePhoneOrNull } from "@/lib/domain/phone";
import { readSmsConfig, sendSmsDetailed } from "@/lib/services/notify";
import { logActivity } from "@/lib/services/activity";

const EKRAN = "/admin/ustawienia/sms";

function wroc(params: { ok?: string; blad?: string }): never {
  const klucz = params.ok ? "ok" : "blad";
  redirect(`${EKRAN}?${klucz}=${encodeURIComponent(params.ok ?? params.blad ?? "")}`);
}

// Dane administratora danych i treść formularza kampanii. Oba wchodzą DOSŁOWNIE
// do zapisu zgody, więc zmiana dotyczy wyłącznie zgód zapisanych PO niej -
// wcześniejsze mają własną kopię i tak ma zostać.
export async function saveConsentSettingsAction(formData: FormData) {
  const session = await requireRole("ADMIN");

  const dataController = String(formData.get("dataController") ?? "").trim();
  const leadConsentText = String(formData.get("leadConsentText") ?? "").trim();

  await prisma.clubSettings.upsert({
    where: { id: "singleton" },
    create: {
      id: "singleton",
      dataController: dataController || null,
      leadConsentText: leadConsentText || null,
    },
    update: {
      dataController: dataController || null,
      leadConsentText: leadConsentText || null,
    },
  });

  await logActivity(prisma, {
    actorUserId: session.user.id,
    action: "SETTINGS_UPDATED",
    summary: "Zmieniono dane do klauzul zgody (administrator danych / treść formularza kampanii)",
  });

  revalidatePath(EKRAN);
  wroc({ ok: "Zapisano dane do klauzul zgody." });
}

// Test bramki. Dwa tryby, bo odpowiadają na dwa różne pytania:
//
//   - "próba" pyta bramkę o wszystko (token, nazwa nadawcy, numer) i nic nie
//     wysyła - nic nie kosztuje i nikomu nie dzwoni telefon,
//   - "wyślij" pokazuje to, czego próba nie pokaże: jak wiadomość wygląda na
//     ekranie telefonu i jaka nazwa nadawcy się na nim wyświetla.
export async function sendTestSmsAction(formData: FormData) {
  const session = await requireRole("ADMIN");

  const config = readSmsConfig();
  if (!config) {
    wroc({
      blad:
        "Bramka SMS nie jest skonfigurowana - ustaw SMSAPI_TOKEN (i ewentualnie SMSAPI_SENDER) " +
        "na hostingu, a potem wróć na ten ekran.",
    });
  }

  const phone = parsePhoneOrNull(String(formData.get("phone") ?? ""));
  if (!phone) wroc({ blad: "Podaj poprawny numer telefonu, na który ma pójść test." });

  const proba = String(formData.get("tryb") ?? "") !== "wyslij";
  const teraz = new Date().toLocaleString("pl-PL", { timeZone: "Europe/Warsaw" });

  const wynik = await sendSmsDetailed(
    phone,
    `toFITcontrol: test bramki SMS z ${teraz}. Jesli to czytasz, wysylka dziala.`,
    { test: proba },
  );

  await logActivity(prisma, {
    actorUserId: session.user.id,
    action: "SETTINGS_UPDATED",
    summary: wynik.ok
      ? `Test bramki SMS na ${phone} (${proba ? "próba, bez wysyłki" : "realna wysyłka"}) - przyjęty`
      : `Test bramki SMS na ${phone} nie powiódł się: ${wynik.error}`,
  });

  if (!wynik.ok) wroc({ blad: wynik.error });

  wroc({
    ok: proba
      ? `Bramka przyjęła wiadomość w trybie próbnym - token i nazwa nadawcy "${config.sender}" działają. Nic nie wysłano i nic nie kosztowało.`
      : `Wysłano SMS testowy na ${phone} jako "${config.sender}" (${wynik.segments} segm.).`,
  });
}
