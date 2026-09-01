"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireRole } from "@/lib/auth/guard";
import { logActivity } from "@/lib/services/activity";
import { recordCountLabel } from "@/lib/domain/demo-data";
import { removeDemoData } from "@/lib/services/demo-data";
import { loadDemoData } from "@/lib/services/demo-dataset";

// Wgrywanie i usuwanie danych demonstracyjnych.
//
// requireRole("ADMIN") w PIERWSZEJ linii każdej akcji, a nie tylko w layoucie:
// Server Action to osobny punkt wejścia i layout jej nie chroni. Bez tego
// kartotekę mogłoby skasować każde zalogowane konto - łącznie z kontem kiosku,
// którego hasło zna cały klub.
//
// Superadmin to w tym systemie zwykłe konto z rolą ADMIN (patrz
// prisma/setup-club.ts) - nie ma osobnego tieru, więc jedna rola pokrywa
// właściciela i konto wsparcia.

const EKRAN = "/admin/ustawienia/dane-demo";

function wroc(parametr: string, wartosc: string): never {
  redirect(`${EKRAN}?${parametr}=${encodeURIComponent(wartosc)}`);
}

export async function loadDemoDataAction(formData: FormData) {
  const session = await requireRole("ADMIN");

  // Świadome potwierdzenie, a nie samo kliknięcie. Ta operacja dokłada do bazy
  // klubu kilkaset rekordów widocznych na wszystkich ekranach.
  if (formData.get("potwierdzam") !== "tak") {
    wroc("blad", "Zaznacz potwierdzenie - bez niego nic nie wgrywam.");
  }

  const wynik = await loadDemoData();
  if (!wynik.ok) wroc("blad", wynik.message);

  await logActivity(prisma, {
    actorUserId: session.user.id,
    action: "DEMO_DATA_LOADED",
    summary: `Wgrano dane demonstracyjne: ${recordCountLabel(wynik.total)}`,
  });

  revalidatePath("/admin", "layout");
  wroc("wgrano", String(wynik.total));
}

export async function removeDemoDataAction(formData: FormData) {
  const session = await requireRole("ADMIN");

  if (formData.get("potwierdzam") !== "tak") {
    wroc("blad", "Zaznacz potwierdzenie - bez niego nic nie usuwam.");
  }

  const wynik = await removeDemoData();
  if (!wynik.ok) wroc("blad", wynik.message);

  await logActivity(prisma, {
    actorUserId: session.user.id,
    action: "DEMO_DATA_REMOVED",
    summary: `Usunięto dane demonstracyjne: ${recordCountLabel(wynik.removed)}`,
  });

  revalidatePath("/admin", "layout");
  wroc("usunieto", String(wynik.removed));
}
