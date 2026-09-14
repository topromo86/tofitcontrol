import type { Metadata } from "next";
import Link from "next/link";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { getAccessibleMembers } from "@/lib/auth/guard";
import { Button, buttonVariants } from "@/components/ui/button";
import { BOOKING_ERROR_MESSAGE } from "@/lib/domain/booking";
import { freeSlots } from "@/lib/domain/public-schedule";
import { bookingHorizonEnd, sessionBookableStatus } from "@/lib/domain/schedule";
import { effectiveTrainerId } from "@/lib/domain/substitute";
import { getClubSettings } from "@/lib/services/settings";
import { formatDayTime } from "@/lib/format";
import { bookSessionAction } from "@/app/app/actions";
import { SiteFooter } from "../../site-footer";
import { ThemeToggle } from "../../theme-toggle";
import { ChildMark } from "@/app/child-mark";

// Strona pojedynczych zajęć - miejsce, w które prowadzi harmonogram na witrynie
// klubu (czaplaboxing.pl/harmonogram-zajec).
//
// Wchodzi się tu BEZ logowania: kto przegląda grafik, ma zobaczyć, kiedy i gdzie
// są zajęcia, zanim zdecyduje, czy w ogóle zakłada konto. Hasło pojawia się
// dopiero przy zapisie, bo dopiero wtedy system musi wiedzieć, KOGO zapisuje.
//
// Sam zapis idzie tą samą akcją co planner w /app - reguły (zgody, karnet,
// wiek, komplet) są sprawdzane w jednym miejscu, więc wejście "z witryny" nie
// omija niczego, czego pilnuje panel klienta.

export const metadata: Metadata = {
  title: "Zapis na zajęcia - toFitCONTROL",
};

export default async function PublicSessionPage({
  params,
  searchParams,
}: {
  params: Promise<{ sessionId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { sessionId } = await params;
  const { error } = await searchParams;

  const klasa = await prisma.session.findUnique({
    where: { id: sessionId },
    include: {
      location: true,
      category: true,
      trainer: { include: { user: { select: { name: true } } } },
      substituteTrainer: { include: { user: { select: { name: true } } } },
      bookings: { select: { memberId: true, status: true } },
    },
  });

  if (!klasa || klasa.kind === "INDIVIDUAL") {
    return (
      <Shell>
        <h1 className="font-display text-brand-red text-2xl tracking-wide">Nie ma takich zajęć</h1>
        <p className="text-muted-brand text-center text-sm">
          Termin mógł zostać odwołany albo odsyłacz jest nieaktualny. Sprawdź aktualny grafik na
          stronie klubu.
        </p>
        <SiteLink />
      </Shell>
    );
  }

  const session = await auth();
  const settings = await getClubSettings();
  const now = new Date();
  const horizonEnd = bookingHorizonEnd({
    mode: settings.bookingHorizonMode,
    days: settings.bookingHorizonDays,
    now,
  });

  const leadsSubstitute = effectiveTrainerId(klasa) === klasa.substituteTrainerId;
  const trainerName =
    (leadsSubstitute ? klasa.substituteTrainer?.user.name : klasa.trainer.user.name) ??
    klasa.trainer.user.name;
  const bookedCount = klasa.bookings.filter((b) => b.status === "BOOKED").length;
  const wolne = freeSlots(klasa.capacity, bookedCount);

  // Konta trenerskie, kiosk i admin nie zapisują się na zajęcia - dla nich
  // ta strona jest tylko podglądem terminu.
  const canBook = session?.user.role === "MEMBER" || session?.user.role === "GUARDIAN";
  const members = canBook ? await getAccessibleMembers() : [];

  return (
    <Shell>
      <div className="text-center">
        <p className="text-muted-brand font-mono text-xs tracking-widest uppercase">
          {klasa.location.name}
          {klasa.category ? ` · ${klasa.category.name}` : ""}
        </p>
        <h1 className="font-display text-brand-red mt-1 text-2xl tracking-wide">{klasa.name}</h1>
        <p className="text-text mt-1 text-sm">{formatDayTime(klasa.startsAt)}</p>
        <p className="text-muted-brand mt-1 text-sm">
          Prowadzi {trainerName} · {wolne > 0 ? `wolne miejsca: ${wolne}` : "brak wolnych miejsc"}
        </p>
      </div>

      {error ? (
        <p
          role="alert"
          className="border-red/40 bg-red/10 text-red w-full rounded-md border p-3 text-center text-sm"
        >
          {BOOKING_ERROR_MESSAGE[error as keyof typeof BOOKING_ERROR_MESSAGE] ??
            "Nie udało się zapisać na te zajęcia."}
        </p>
      ) : null}

      {!session ? (
        <div className="border-line bg-surface flex w-full flex-col gap-3 rounded-md border p-4">
          <p className="text-text text-center text-sm">
            Zapis na zajęcia wymaga konta w systemie klubu.
          </p>
          <Link
            href={`/login?powrot=/zapis/${klasa.id}`}
            className={buttonVariants({ size: "lg", className: "w-full" })}
          >
            Zaloguj się i zapisz
          </Link>
          <Link
            href="/rejestracja"
            className={buttonVariants({ variant: "outline", size: "lg", className: "w-full" })}
          >
            Nie mam jeszcze konta
          </Link>
        </div>
      ) : null}

      {session && !canBook ? (
        <p className="border-line bg-surface text-muted-brand w-full rounded-md border p-3 text-center text-sm">
          To konto obsługuje klub, a nie zapisy klubowiczów. Zapisu dokonuje się z konta klubowicza
          albo jego opiekuna.
        </p>
      ) : null}

      {canBook
        ? members.map((member) => {
            const booking = klasa.bookings.find(
              (b) => b.memberId === member.id && b.status !== "CANCELLED",
            );
            const status = sessionBookableStatus({
              session: { startsAt: klasa.startsAt, status: klasa.status, capacity: klasa.capacity },
              bookedCount,
              memberAlreadyBooked: booking != null,
              now,
              horizonEnd,
            });

            return (
              <div
                key={member.id}
                className="border-line bg-surface flex w-full flex-col gap-3 rounded-md border p-4"
              >
                <p className="text-text text-center text-sm">
                  {member.firstName} {member.lastName}
                  {member.relation === "child" ? <ChildMark className="ml-1" /> : null}
                </p>

                {status === "BOOKABLE" ? (
                  <form action={bookSessionAction}>
                    <input type="hidden" name="memberId" value={member.id} />
                    <input type="hidden" name="sessionId" value={klasa.id} />
                    <input type="hidden" name="returnTo" value={`/zapis/${klasa.id}`} />
                    <Button type="submit" className="w-full">
                      Zapisz się na te zajęcia
                    </Button>
                  </form>
                ) : (
                  <p className="text-muted-brand text-center text-sm">{STATUS_NOTE[status]}</p>
                )}
              </div>
            );
          })
        : null}

      {session ? (
        <Link href="/app" className="text-muted-brand hover:text-brand-red text-sm underline">
          Przejdź do panelu i całego grafiku
        </Link>
      ) : null}

      <SiteLink />
      <SiteFooter />
    </Shell>
  );
}

const STATUS_NOTE: Record<string, string> = {
  ALREADY_BOOKED: "Jesteś już zapisany na te zajęcia.",
  FULL: "Komplet - na te zajęcia nie ma już wolnych miejsc.",
  BEYOND_HORIZON: "Zapisy na ten termin jeszcze nie ruszyły - zajrzyj bliżej daty.",
  PAST: "Te zajęcia już się odbyły.",
  CANCELLED: "Te zajęcia zostały odwołane.",
};

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto flex min-h-full w-full max-w-sm flex-1 flex-col items-center justify-center gap-4 p-4">
      <div className="absolute top-4 right-4">
        <ThemeToggle />
      </div>
      {children}
    </main>
  );
}

function SiteLink() {
  return (
    <a
      href="https://czaplaboxing.pl/harmonogram-zajec/"
      className="text-muted-brand hover:text-brand-red text-sm underline"
    >
      Wróć do harmonogramu
    </a>
  );
}
