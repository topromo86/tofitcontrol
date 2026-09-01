import { prisma } from "@/lib/prisma";
import { getAccessibleMembers } from "@/lib/auth/guard";
import { isWithinCheckInWindow } from "@/lib/domain/booking";
import { Button } from "@/components/ui/button";
import { ConnectionBadge } from "../../connection-badge";
import { OfflineBar } from "../../offline-bar";
import { OfflineForm } from "../../offline-form";
import { checkInAction } from "./actions";

export default async function QrCheckInPage({
  params,
  searchParams,
}: {
  params: Promise<{ locationId: string }>;
  searchParams: Promise<{ success?: string; error?: string }>;
}) {
  const { locationId } = await params;
  const { success, error } = await searchParams;

  const location = await prisma.location.findUnique({ where: { id: locationId } });
  if (!location) {
    return (
      <main className="flex flex-1 items-center justify-center p-4 text-center">
        <p className="text-muted-brand">Nieznana lokalizacja.</p>
      </main>
    );
  }

  const members = await getAccessibleMembers();
  const now = new Date();

  const candidates = await Promise.all(
    members.map(async (member) => {
      const bookings = await prisma.booking.findMany({
        where: { memberId: member.id, status: "BOOKED", session: { locationId } },
        include: { session: true },
      });
      const eligible = bookings.find((b) => isWithinCheckInWindow(b.session.startsAt, now));
      return { member, booking: eligible ?? null };
    }),
  );

  return (
    <main className="mx-auto flex min-h-full max-w-sm flex-1 flex-col items-center justify-center gap-4 p-4 text-center">
      {/* Kod na ścianie skanuje się telefonem, a zasięg na sali bywa żaden -
          stan łącza i kolejka muszą tu być widoczne, bo to jedyny ekran
          meldunku. */}
      <div className="w-full">
        <OfflineBar />
      </div>

      <h1 className="font-display text-brand-red text-2xl tracking-wide">{location.name}</h1>
      <div className="flex flex-col items-center gap-2">
        <p className="text-muted-brand font-mono text-xs tracking-widest uppercase">
          Meldowanie na zajęcia
        </p>
        <ConnectionBadge />
      </div>

      {success ? (
        <p
          role="status"
          className="border-jade/40 bg-jade/10 text-jade w-full rounded-md border p-3 text-sm"
        >
          Obecność zaliczona. Miłego treningu!
        </p>
      ) : null}
      {error ? (
        <p
          role="alert"
          className="border-red/40 bg-red/10 text-red w-full rounded-md border p-3 text-sm"
        >
          Brak rezerwacji w oknie czasowym (-30/+20 min) na zajęcia w tej lokalizacji.
        </p>
      ) : null}

      {candidates.map(({ member, booking }) => (
        <div key={member.id} className="border-line bg-surface w-full rounded-md border p-4">
          <p className="text-text font-medium">
            {member.firstName} {member.lastName}
          </p>
          {booking ? (
            <>
              <p className="text-muted-brand mt-1 text-sm">{booking.session.name}</p>
              <OfflineForm
                action={checkInAction}
                op="MELDUNEK_KLUBOWICZA"
                detail={`${member.firstName} ${member.lastName} · ${booking.session.name}`}
                fields={["bookingId"]}
                offlineLabel="Zapisane bez sieci - wyśle się samo po powrocie zasięgu"
              >
                <input type="hidden" name="bookingId" value={booking.id} />
                <Button type="submit" className="mt-3 w-full">
                  Zamelduj obecność
                </Button>
              </OfflineForm>
            </>
          ) : (
            <p className="text-muted-brand mt-2 text-sm">Brak rezerwacji w oknie czasowym.</p>
          )}
        </div>
      ))}
    </main>
  );
}
