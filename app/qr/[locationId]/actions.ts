"use server";

import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireMemberAccess } from "@/lib/auth/guard";
import { selfCheckIn } from "@/lib/services/attendance";

// Meldunek klubowicza z kodu na ścianie. Sam zapis (okno czasowe, karnet,
// powiadomienie opiekuna) siedzi w lib/services/attendance.ts, bo tą samą
// drogą idą meldunki dopisywane z kolejki offline.
export async function checkInAction(formData: FormData) {
  const bookingId = String(formData.get("bookingId"));

  const booking = await prisma.booking.findUniqueOrThrow({
    where: { id: bookingId },
    select: { memberId: true },
  });
  await requireMemberAccess(booking.memberId);

  const result = await selfCheckIn({ bookingId, at: new Date() });
  if (!result.ok) redirect(`/qr/${result.locationId}?error=WINDOW`);

  redirect(`/qr/${result.locationId}?success=1`);
}
