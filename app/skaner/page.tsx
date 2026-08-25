import Link from "next/link";
import { requireRole } from "@/lib/auth/guard";
import { prisma } from "@/lib/prisma";
import { getClubSettings } from "@/lib/services/settings";
import { isVisitValid } from "@/lib/domain/floor-checkin";
import { todayInTimeZone, zonedTimeToUtc } from "@/lib/domain/time";
import { formatTime } from "@/lib/format";
import { ConnectionBadge } from "../connection-badge";
import { OfflineBar } from "../offline-bar";
import { Scanner } from "./scanner";

const ROLE_LABEL: Record<string, string> = {
  ADMIN: "Właściciel",
  TRAINER: "Trener",
  MEMBER: "Klubowicz",
  GUARDIAN: "Opiekun",
};

export default async function ScannerStationPage({
  searchParams,
}: {
  searchParams: Promise<{ loc?: string }>;
}) {
  await requireRole("ADMIN", "TRAINER");
  const { loc } = await searchParams;

  const [locations, settings] = await Promise.all([
    prisma.location.findMany({ orderBy: { name: "asc" } }),
    getClubSettings(),
  ]);
  const activeLocation = locations.find((l) => l.id === loc) ?? locations[0] ?? null;
  const activeLocationId = activeLocation?.id ?? null;

  const now = new Date();
  const today = todayInTimeZone(now);
  const dayStart = zonedTimeToUtc(today.year, today.month, today.day, 0, 0);

  const entries = activeLocationId
    ? await prisma.floorCheckIn.findMany({
        where: { locationId: activeLocationId, enteredAt: { gte: dayStart } },
        include: { user: { select: { name: true, role: true } } },
        orderBy: { enteredAt: "desc" },
      })
    : [];

  return (
    <main className="mx-auto flex min-h-full w-full max-w-md flex-1 flex-col gap-5 p-4">
      {/* Stacja stoi na sali i nie ma nad sobą nagłówka panelu, więc wskaźnik
          połączenia i pas kolejki wchodzą tutaj - inaczej to jedyne miejsce
          w systemie, gdzie brak bazy byłby niewidoczny. */}
      <OfflineBar />

      <div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h1 className="font-display text-brand-red text-2xl tracking-wide">Stacja wejścia</h1>
          <ConnectionBadge />
        </div>
        <p className="text-muted-brand mt-1 text-sm">
          Zeskanuj osobisty kod QR klubowicza lub trenera, żeby odbić wejście na salę.
          {settings.floorMinMinutes > 0
            ? ` Wizyta zalicza się po ${settings.floorMinMinutes} min na sali.`
            : " Minimalny czas na sali nie jest ustawiony."}
        </p>
      </div>

      {locations.length > 1 ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-muted-brand w-16 font-mono text-xs tracking-widest uppercase">
            Sala
          </span>
          {locations.map((location) => (
            <Link
              key={location.id}
              href={`/skaner?loc=${location.id}`}
              className={`rounded-md border px-3 py-1.5 text-sm ${
                location.id === activeLocationId
                  ? "border-brand-red text-brand-red font-medium"
                  : "border-line bg-surface text-text"
              }`}
            >
              {location.name}
            </Link>
          ))}
        </div>
      ) : null}

      {activeLocationId ? (
        <Scanner locationId={activeLocationId} locationName={activeLocation?.name ?? null} />
      ) : (
        <p className="text-muted-brand border-line bg-surface rounded-md border p-4 text-sm">
          Brak lokalizacji w systemie.
        </p>
      )}

      <section className="flex flex-col gap-2">
        <h2 className="text-muted-brand font-mono text-xs tracking-widest uppercase">
          Dziś na sali ({entries.length})
        </h2>
        {entries.length === 0 ? (
          <p className="text-muted-brand text-sm">Jeszcze nikt się nie odbił.</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {entries.map((e) => {
              const valid = isVisitValid(e.enteredAt, now, settings.floorMinMinutes);
              return (
                <li
                  key={e.id}
                  className="border-line bg-surface flex items-center justify-between gap-2 rounded-md border p-2.5"
                >
                  <div className="min-w-0">
                    <p className="text-text truncate text-sm font-medium">{e.user.name}</p>
                    <p className="text-muted-brand font-mono text-[10px] tracking-widest uppercase">
                      {ROLE_LABEL[e.user.role] ?? "Konto"}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-text font-mono text-sm">{formatTime(e.enteredAt)}</p>
                    <p className={`font-mono text-[10px] ${valid ? "text-jade" : "text-amber"}`}>
                      {valid ? "zaliczona" : "w trakcie"}
                    </p>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </main>
  );
}
