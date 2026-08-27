import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { requireRole } from "@/lib/auth/guard";
import {
  classifyTrainerCheckIn,
  qrWindow,
  TRAINER_CHECK_IN_LABEL,
  type TrainerCheckInState,
} from "@/lib/domain/class-qr";
import { effectiveTrainerId } from "@/lib/domain/substitute";
import { getOrCreateSessionQrToken } from "@/lib/services/class-qr";
import { getClubSettings } from "@/lib/services/settings";
import { requestBaseUrl } from "@/lib/base-url";
import { formatTime } from "@/lib/format";
import { qrSvg } from "@/lib/qr";
import { ConnectionBadge } from "../connection-badge";
import { OfflineBar } from "../offline-bar";
import { ClassScanner } from "./class-scanner";
import { KioskClock } from "./kiosk-clock";

// Stacja z kodem zajęć - tablet albo telefon leżący przy wejściu na salę.
// Zalogowany personel otwiera ten ekran i zostawia go włączony; nie ma tu nic
// poza kodem, bo urządzenie zostaje w rękach wszystkich wchodzących.
//
// Strona odświeża się sama, więc kod przeskakuje na kolejne zajęcia bez
// dotykania tabletu. Bez JS - zwykły <meta refresh>.
const REFRESH_SECONDS = 30;

// Konto prowadzącego - z uwzględnieniem potwierdzonego zastępstwa. Bez tego
// kafelek nie ma z czym porównać osoby, która się odbiła.
function leadUserIdOf(session: {
  trainerId: string;
  substituteTrainerId: string | null;
  substituteStatus: "PENDING" | "ACCEPTED" | "DECLINED" | null;
  trainer: { userId: string };
  substituteTrainer: { userId: string } | null;
}): string {
  return effectiveTrainerId(session) === session.trainerId
    ? session.trainer.userId
    : (session.substituteTrainer?.userId ?? session.trainer.userId);
}

const STATE_STYLE: Record<TrainerCheckInState, string> = {
  ON_TIME: "text-jade",
  LATE: "text-amber",
  MISSING: "text-red",
  PENDING: "text-muted-brand",
  // Czerwień, nie pomarańcz: to nie jest "spóźnił się", tylko "prowadzi ktoś
  // inny niż w grafiku" - i wymaga decyzji właściciela, nie tylko odnotowania.
  OTHER_TRAINER: "text-red",
};

export default async function ClassQrStationPage({
  searchParams,
}: {
  searchParams: Promise<{ loc?: string }>;
}) {
  // KIOSK to konto samego tabletu; ADMIN i TRENER dostają ten ekran także ze
  // swojego telefonu, gdy tablet akurat nie działa.
  await requireRole("ADMIN", "TRAINER", "KIOSK");
  const { loc } = await searchParams;

  const [locations, settings] = await Promise.all([
    prisma.location.findMany({ orderBy: { name: "asc" } }),
    getClubSettings(),
  ]);
  const activeLocation = locations.find((l) => l.id === loc) ?? locations[0] ?? null;
  const activeLocationId = activeLocation?.id ?? null;

  const now = new Date();

  // Zajęcia, których kod jest teraz aktywny: start nie dalej niż okno kodu
  // przed nami, koniec jeszcze przed nami. W sali potrafią wypaść dwie grupy
  // pod rząd, więc bierzemy wszystkie pasujące, nie tylko jedne.
  const openFrom = new Date(now.getTime() - 12 * 3_600_000);
  const sessions = activeLocationId
    ? await prisma.session.findMany({
        where: {
          locationId: activeLocationId,
          status: "SCHEDULED",
          endsAt: { gte: now },
          startsAt: { gte: openFrom, lte: new Date(now.getTime() + 12 * 3_600_000) },
        },
        include: {
          trainer: { include: { user: true } },
          substituteTrainer: { include: { user: true } },
          attendances: { select: { id: true } },
          bookings: { where: { status: { in: ["BOOKED", "ATTENDED"] } }, select: { id: true } },
        },
        orderBy: { startsAt: "asc" },
      })
    : [];

  const live = sessions.filter((s) => {
    const window = qrWindow(s, settings.qrOpensMinutesBefore);
    return now >= window.opensAt && now <= window.closesAt;
  });

  const next = sessions.find((s) => s.startsAt > now && !live.includes(s)) ?? null;

  const baseUrl = await requestBaseUrl();
  const cards = await Promise.all(
    live.map(async (s) => {
      // Kod niesie pełny adres, żeby telefon otworzył go od razu w przeglądarce.
      const token = await getOrCreateSessionQrToken(s.id);
      return {
        session: s,
        svg: await qrSvg(`${baseUrl}/z/${token}`),
        state: classifyTrainerCheckIn({
          session: s,
          checkedInAt: s.trainerCheckedInAt,
          checkedInUserId: s.trainerCheckedInUserId,
          leadUserId: leadUserIdOf(s),
          now,
          minutesBefore: settings.trainerCheckInMinutesBefore,
        }),
        trainerName:
          effectiveTrainerId(s) === s.trainerId
            ? s.trainer.user.name
            : (s.substituteTrainer?.user.name ?? s.trainer.user.name),
      };
    }),
  );

  return (
    <main className="mx-auto flex min-h-full w-full max-w-2xl flex-1 flex-col gap-5 p-4">
      <meta httpEquiv="refresh" content={String(REFRESH_SECONDS)} />

      {/* Kiosk nie ma nad sobą nagłówka panelu (widzi go też konto KIOSK bez
          dostępu do reszty systemu), więc stan bazy wchodzi tutaj. */}
      <OfflineBar />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="font-display text-brand-red text-2xl tracking-wide">Kod na zajęcia</h1>
        <div className="flex items-center gap-2">
          <ConnectionBadge />
          <KioskClock initial={formatTime(now)} />
        </div>
      </div>

      {locations.length > 1 ? (
        <div className="flex flex-wrap items-center gap-2">
          {locations.map((location) => (
            <Link key={location.id} href={`/kod-zajec?loc=${location.id}`}>
              <span
                className={`rounded-md border px-3 py-1.5 text-sm ${
                  location.id === activeLocationId
                    ? "border-brand-red text-brand-red font-medium"
                    : "border-line bg-surface text-text"
                }`}
              >
                {location.name}
              </span>
            </Link>
          ))}
        </div>
      ) : null}

      {/* Skaner na górze: to jest droga PROWADZĄCEGO i jedyna, która dowodzi
          obecności na sali - kod z telefonu żyje 30 s, więc trzeba stanąć przy
          tym urządzeniu. Klubowicze mogą go użyć tak samo, ale mają też kod
          zajęć niżej, żeby dwadzieścia osób nie stało w kolejce. */}
      <section className="border-line bg-surface rounded-md border p-4">
        <h2 className="text-muted-brand font-mono text-xs tracking-widest uppercase">
          Odbicie kodem z telefonu
        </h2>
        <p className="text-muted-brand mt-1 mb-3 text-sm">
          Prowadzący odbija się wyłącznie tędy. Pokaż kod z zakładki „Mój kod wejścia”.
        </p>
        <ClassScanner locationId={activeLocationId} locationName={activeLocation?.name ?? null} />
      </section>

      {cards.length === 0 ? (
        <div className="border-line bg-surface rounded-md border p-6 text-center">
          <p className="text-text">Teraz nie ma aktywnego kodu.</p>
          <p className="text-muted-brand mt-1 text-sm">
            {next
              ? `Kod najbliższych zajęć („${next.name}”, ${formatTime(next.startsAt)}) pojawi się ${settings.qrOpensMinutesBefore} min przed startem.`
              : "W tej sali nie ma dziś więcej zajęć w grafiku."}
          </p>
        </div>
      ) : (
        cards.map(({ session, svg, state, trainerName }) => (
          <section key={session.id} className="border-line bg-surface rounded-md border p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-text font-display text-xl">{session.name}</h2>
              <p className="text-muted-brand font-mono text-xs tracking-widest uppercase">
                {formatTime(session.startsAt)}-{formatTime(session.endsAt)} · {trainerName}
              </p>
            </div>

            {/* Biała ramka niezależnie od motywu - czytnik telefonu potrzebuje
                kontrastu, a tablet bywa ustawiony na ciemny motyw. */}
            <div
              className="mx-auto mt-3 w-full max-w-[18rem] rounded-lg bg-white p-4 shadow-sm"
              dangerouslySetInnerHTML={{ __html: svg }}
            />

            <p className="text-muted-brand mt-3 text-center text-sm">
              Klubowicze: zeskanujcie telefonem i potwierdźcie obecność.
            </p>

            <div className="border-line-soft mt-3 flex flex-wrap items-center justify-between gap-2 border-t pt-3 font-mono text-xs">
              <span className={STATE_STYLE[state]}>{TRAINER_CHECK_IN_LABEL[state]}</span>
              <span className="text-muted-brand">
                Odbici: {session.attendances.length}/{session.bookings.length}
              </span>
            </div>
          </section>
        ))
      )}

      <p className="text-muted-brand text-center text-xs">
        Ekran odświeża się co {REFRESH_SECONDS} s - kod sam przeskakuje na kolejne zajęcia.
      </p>
    </main>
  );
}
