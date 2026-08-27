"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireSession } from "@/lib/auth/guard";
import { scanClassQr } from "@/lib/services/class-qr";
import { SCAN_REJECTION_MESSAGE } from "@/lib/domain/class-qr";

// Odbicie jest osobnym kliknięciem, a nie efektem samego wejścia na adres.
// Powód praktyczny: skaner telefonu potrafi otworzyć link w tle albo podgląd
// odwiedza go zanim człowiek zdecyduje. Obecność ma być świadoma.
export async function confirmScanAction(formData: FormData) {
  const session = await requireSession();
  const token = String(formData.get("token") ?? "");

  const result = await scanClassQr({ token, userId: session.user.id });

  if (!result.ok) {
    redirect(`/z/${token}?blad=${encodeURIComponent(SCAN_REJECTION_MESSAGE[result.reason])}`);
  }

  revalidatePath("/trainer");
  revalidatePath("/app");
  revalidatePath("/kod-zajec");

  const ok =
    result.role !== "TRAINER"
      ? "klubowicz"
      : !result.assigned
        ? "trener-nie-swoje"
        : result.late
          ? "trener-po-czasie"
          : "trener";
  redirect(`/z/${token}?ok=${ok}`);
}
