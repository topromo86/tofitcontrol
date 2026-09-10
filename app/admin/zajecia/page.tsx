import { Info } from "lucide-react";
import { prisma } from "@/lib/prisma";
import { requireRole } from "@/lib/auth/guard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  MIN_BOOKING_LEAD_HOURS,
  SLOT_MINUTES_OPTIONS,
  WEEKDAY_LABELS,
} from "@/lib/domain/availability";
import {
  bookingHorizonEnd,
  describeHorizon,
  FIXED_HORIZON_OPTIONS,
  startOfWeek,
  weekDays,
} from "@/lib/domain/schedule";
import { resolveClassName } from "@/lib/domain/class-template";
import { assignCategoryColors, stripeClass, CATEGORY_COLORS } from "@/lib/domain/class-color";
import { addCalendarDays, todayInTimeZone, zonedTimeToUtc } from "@/lib/domain/time";
import { AdminWeekGrid, type GridSession } from "./tydzien/week-grid";
import { EditDialog } from "./edit-dialog";
import { MAX_CANCELLATION_WINDOW_HOURS, MIN_CANCELLATION_WINDOW_HOURS } from "@/lib/domain/booking";
import { getClubSettings } from "@/lib/services/settings";
import { formatDate, formatDayTime, toDateInputValue, toTimeInputValue } from "@/lib/format";
import {
  cancelSessionAction,
  createAvailabilityWindowAction,
  createCategoryAction,
  createClassTemplateAction,
  createSessionAction,
  deleteAvailabilityWindowAction,
  stopClassTemplateAction,
  toggleCategoryAction,
  updateBookingHorizonAction,
  updateCancellationWindowAction,
  updateCategoryAction,
  updateSessionAction,
} from "./actions";

const selectClass =
  "border-line bg-surface-2 text-text w-full rounded-md border px-2 py-2 text-base md:text-sm";

function durationMinutes(startsAt: Date, endsAt: Date): number {
  return Math.round((endsAt.getTime() - startsAt.getTime()) / 60_000);
}

export default async function AdminSessionsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; edit?: string; tydzien?: string; loc?: string }>;
}) {
  await requireRole("ADMIN");
  const { error, edit, tydzien, loc } = await searchParams;

  const now = new Date();

  const settings = await getClubSettings();
  const horizonEnd = bookingHorizonEnd({
    mode: settings.bookingHorizonMode,
    days: settings.bookingHorizonDays,
    now,
  });

  const [locations, trainers, sessions, windows, categories, templates] = await Promise.all([
    prisma.location.findMany({ orderBy: { name: "asc" } }),
    prisma.trainer.findMany({
      where: { active: true },
      include: { user: true, location: true },
      orderBy: { user: { name: "asc" } },
    }),
    prisma.session.findMany({
      where: { startsAt: { gte: now } },
      include: {
        location: true,
        trainer: { include: { user: true } },
        bookings: { where: { status: "BOOKED" } },
      },
      orderBy: { startsAt: "asc" },
      take: 60,
    }),
    prisma.availabilityWindow.findMany({
      where: { active: true },
      include: { trainer: { include: { user: true } }, location: true },
      orderBy: [{ weekday: "asc" }, { startTime: "asc" }],
    }),
    prisma.classCategory.findMany({ orderBy: [{ sortOrder: "asc" }, { name: "asc" }] }),
    prisma.classTemplate.findMany({
      where: { active: true },
      include: {
        location: true,
        trainer: { include: { user: true } },
        category: true,
      },
      orderBy: [{ weekday: "asc" }, { startTime: "asc" }],
    }),
  ]);

  const activeCategories = categories.filter((c) => c.active);

  const editing = edit ? (sessions.find((s) => s.id === edit) ?? null) : null;

  // Wbudowany podgląd grafiku w układzie tygodniowym - ten sam planer, który
  // widzą klienci. Domyślnie bieżący tydzień; strzałki przesuwają widok w obie
  // strony (admin czasem sprawdza, co było wstecz).
  const gridLocationId = locations.find((l) => l.id === loc)?.id ?? locations[0]?.id ?? null;
  const currentWeekStart = startOfWeek(todayInTimeZone(now));
  const requestedWeek = tydzien?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const weekStart = requestedWeek
    ? startOfWeek({
        year: Number(requestedWeek[1]),
        month: Number(requestedWeek[2]),
        day: Number(requestedWeek[3]),
      })
    : currentWeekStart;
  const weekStartUtc = zonedTimeToUtc(weekStart.year, weekStart.month, weekStart.day, 0, 0);
  const nextWeekStart = addCalendarDays(weekStart, 7);
  const prevWeekStart = addCalendarDays(weekStart, -7);
  const weekEndUtc = zonedTimeToUtc(
    nextWeekStart.year,
    nextWeekStart.month,
    nextWeekStart.day,
    0,
    0,
  );

  const weekSessions = gridLocationId
    ? await prisma.session.findMany({
        where: {
          locationId: gridLocationId,
          kind: "GROUP",
          startsAt: { gte: weekStartUtc, lt: weekEndUtc },
        },
        include: {
          category: true,
          trainer: { include: { user: true } },
          bookings: { where: { status: "BOOKED" } },
        },
        orderBy: { startsAt: "asc" },
      })
    : [];

  // Kolory rodzajów liczone raz dla całej listy - dzięki temu żadne dwa rodzaje
  // nie dostaną tej samej barwy (patrz lib/domain/class-color.ts).
  const categoryColors = assignCategoryColors(categories);

  const gridSessions: GridSession[] = weekSessions.map((s) => ({
    id: s.id,
    name: s.name,
    startsAt: s.startsAt,
    capacity: s.capacity,
    bookedCount: s.bookings.length,
    status: s.status,
    categoryName: s.category?.name ?? null,
    trainerName: s.trainer.user.name,
    stripe: stripeClass(s.categoryId ? categoryColors.get(s.categoryId) : null),
  }));

  const gridDays = weekDays(weekStart);
  const gridWeekLabel = `${gridDays[0].day}.${String(gridDays[0].month).padStart(2, "0")} - ${gridDays[6].day}.${String(gridDays[6].month).padStart(2, "0")}`;

  function isoDate(d: { year: number; month: number; day: number }): string {
    return `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;
  }
  function gridLink(overrides: { tydzien?: string; loc?: string }): string {
    const query = new URLSearchParams();
    query.set("tydzien", overrides.tydzien ?? isoDate(weekStart));
    if (overrides.loc ?? gridLocationId) query.set("loc", overrides.loc ?? gridLocationId!);
    return `/admin/zajecia?${query.toString()}`;
  }

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-brand-red text-2xl tracking-wide">Zajęcia</h1>
          <p className="text-muted-brand mt-1 text-sm">
            Grafik zajęć grupowych i okna, w których trenerzy przyjmują na treningi indywidualne.
          </p>
        </div>
        <a
          href="/admin/zajecia/tydzien"
          className="border-line bg-surface text-text hover:text-brand-red shrink-0 rounded-md border px-3 py-2 font-mono text-xs tracking-widest uppercase"
        >
          Pełny ekran →
        </a>
      </div>

      {error ? (
        <p role="alert" className="border-red/40 bg-red/5 text-red rounded-md border p-3 text-sm">
          {error}
        </p>
      ) : null}

      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-muted-brand font-mono text-xs tracking-widest uppercase">
            Grafik tygodniowy · {gridWeekLabel}
          </h2>
          <div className="flex items-center gap-2">
            <a
              href={gridLink({ tydzien: isoDate(prevWeekStart) })}
              className="border-line bg-surface text-text hover:text-brand-red rounded-md border px-3 py-1.5 font-mono text-xs uppercase"
            >
              ← Poprzedni
            </a>
            {isoDate(weekStart) !== isoDate(currentWeekStart) ? (
              <a
                href={gridLink({ tydzien: isoDate(currentWeekStart) })}
                className="border-line bg-surface text-text hover:text-brand-red rounded-md border px-3 py-1.5 font-mono text-xs uppercase"
              >
                Dziś
              </a>
            ) : null}
            <a
              href={gridLink({ tydzien: isoDate(nextWeekStart) })}
              className="border-line bg-surface text-text hover:text-brand-red rounded-md border px-3 py-1.5 font-mono text-xs uppercase"
            >
              Następny →
            </a>
          </div>
        </div>

        {locations.length > 1 ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-muted-brand w-16 font-mono text-xs tracking-widest uppercase">
              Miejsce
            </span>
            {locations.map((location) => (
              <a
                key={location.id}
                href={gridLink({ loc: location.id })}
                className={`rounded-md border px-3 py-1.5 text-sm ${
                  location.id === gridLocationId
                    ? "border-brand-red text-brand-red font-medium"
                    : "border-line bg-surface text-text"
                }`}
              >
                {location.name}
              </a>
            ))}
          </div>
        ) : null}

        {gridSessions.length === 0 ? (
          <p className="text-muted-brand border-line bg-surface rounded-md border p-4 text-sm">
            W tym tygodniu nie ma zajęć grupowych w tej lokalizacji.
          </p>
        ) : (
          <AdminWeekGrid
            weekStart={weekStart}
            sessions={gridSessions}
            now={now}
            returnTo={gridLink({})}
          />
        )}

        <div className="text-muted-brand flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
          <span className="flex items-center gap-1.5">
            <span className="border-line bg-surface inline-block size-3 rounded border" />
            Wolne miejsca
          </span>
          <span className="flex items-center gap-1.5">
            <span className="border-amber/50 bg-amber/10 inline-block size-3 rounded border" />
            Komplet
          </span>
          <span className="flex items-center gap-1.5">
            <span className="border-red/40 bg-red/5 inline-block size-3 rounded border" />
            Odwołane
          </span>
        </div>
      </section>

      <section>
        <h2 className="text-muted-brand font-mono text-xs tracking-widest uppercase">
          Rodzaje zajęć
        </h2>
        <p className="text-muted-brand mt-1 text-sm">
          Po tych rodzajach klienci filtrują planner. Możesz dodawać własne i zmieniać kolejność
          wyświetlania.
        </p>

        <ul className="mt-2 flex flex-col gap-2">
          {categories.map((category) => (
            <li
              key={category.id}
              className={`rounded-md border p-3 ${
                category.active ? "border-line bg-surface" : "border-line bg-surface-2 opacity-60"
              }`}
            >
              <div className="flex flex-wrap items-center gap-2">
                <form
                  action={updateCategoryAction}
                  className="flex flex-1 flex-wrap items-center gap-2"
                >
                  <input type="hidden" name="categoryId" value={category.id} />
                  {/* Kropka pokazuje kolor, jakim ten rodzaj świeci na grafiku. */}
                  <span
                    aria-hidden
                    className={`size-4 shrink-0 rounded-full ${categoryColors.get(category.id)?.dot ?? ""}`}
                  />
                  <Input
                    name="name"
                    defaultValue={category.name}
                    required
                    minLength={3}
                    className="border-line bg-surface-2 h-9 min-w-48 flex-1"
                  />
                  <select
                    name="color"
                    defaultValue={category.color ?? ""}
                    aria-label="Kolor na grafiku"
                    className="border-line bg-surface-2 text-text h-9 rounded-md border px-2 text-base md:text-sm"
                  >
                    <option value="">Kolor: automatyczny</option>
                    {CATEGORY_COLORS.map((c) => (
                      <option key={c.key} value={c.key}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                  <Input
                    name="sortOrder"
                    type="number"
                    defaultValue={category.sortOrder}
                    aria-label="Kolejność"
                    className="border-line bg-surface-2 h-9 w-20"
                  />
                  <Button type="submit" size="sm" variant="outline">
                    Zapisz
                  </Button>
                </form>

                {category.isIndividual ? (
                  <span className="bg-jade/10 text-jade rounded-full px-2 py-0.5 font-mono text-xs uppercase">
                    Auto: indywidualne
                  </span>
                ) : (
                  <form action={toggleCategoryAction}>
                    <input type="hidden" name="categoryId" value={category.id} />
                    <Button type="submit" size="sm" variant="outline">
                      {category.active ? "Ukryj" : "Przywróć"}
                    </Button>
                  </form>
                )}
              </div>
            </li>
          ))}
        </ul>

        <form
          action={createCategoryAction}
          className="border-line bg-surface mt-2 flex flex-wrap items-end gap-2 rounded-md border p-4"
        >
          <div className="flex-1">
            <Label htmlFor="newCategoryName">Nowy rodzaj</Label>
            <Input
              id="newCategoryName"
              name="name"
              required
              minLength={3}
              placeholder="np. Kickboxing"
              className="border-line bg-surface-2"
            />
          </div>
          <div className="w-24">
            <Label htmlFor="newCategoryOrder">Kolejność</Label>
            <Input
              id="newCategoryOrder"
              name="sortOrder"
              type="number"
              defaultValue={(categories.length + 1) * 10}
              className="border-line bg-surface-2"
            />
          </div>
          <Button type="submit">Dodaj rodzaj</Button>
        </form>
      </section>

      <section>
        <h2 className="text-muted-brand font-mono text-xs tracking-widest uppercase">
          Zajęcia cykliczne (regularne)
        </h2>
        <p className="text-muted-brand mt-1 text-sm">
          Ustawiasz dzień tygodnia i godzinę - zajęcia powtarzają się co tydzień automatycznie,{" "}
          <b className="text-text">do odwołania</b>. System dogenerowuje terminy na 8 tygodni w
          przód. Nazwa jest opcjonalna: gdy ją zostawisz pustą, zajęcia nazywają się jak wybrany
          rodzaj.
        </p>

        <form
          action={createClassTemplateAction}
          className="border-line bg-surface mt-2 flex flex-col gap-4 rounded-md border p-4"
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="tplCategoryId">Rodzaj</Label>
              <select id="tplCategoryId" name="categoryId" required className={selectClass}>
                <option value="">Wybierz...</option>
                {activeCategories.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label htmlFor="tplName">Nazwa (opcjonalnie)</Label>
              <Input
                id="tplName"
                name="name"
                placeholder="domyślnie nazwa rodzaju"
                className="border-line bg-surface-2"
              />
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <Label htmlFor="tplWeekday">Dzień tygodnia</Label>
              <select
                id="tplWeekday"
                name="weekday"
                required
                defaultValue="1"
                className={selectClass}
              >
                {WEEKDAY_LABELS.map((label, index) => (
                  <option key={label} value={index}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label htmlFor="tplStartTime">Godzina startu</Label>
              <Input
                id="tplStartTime"
                name="startTime"
                type="time"
                required
                defaultValue="18:00"
                className="border-line bg-surface-2"
              />
            </div>
            <div>
              <Label htmlFor="tplDuration">Czas trwania (min)</Label>
              <Input
                id="tplDuration"
                name="durationMin"
                type="number"
                min="15"
                step="5"
                required
                defaultValue={60}
                className="border-line bg-surface-2"
              />
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="tplLocationId">Miejsce</Label>
              <select id="tplLocationId" name="locationId" required className={selectClass}>
                <option value="">Wybierz...</option>
                {locations.map((location) => (
                  <option key={location.id} value={location.id}>
                    {location.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label htmlFor="tplTrainerId">Trener</Label>
              <select id="tplTrainerId" name="trainerId" required className={selectClass}>
                <option value="">Wybierz...</option>
                {trainers.map((trainer) => (
                  <option key={trainer.id} value={trainer.id}>
                    {trainer.user.name} ({trainer.location.name})
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="tplCapacity">Liczba miejsc</Label>
              <Input
                id="tplCapacity"
                name="capacity"
                type="number"
                min="1"
                required
                defaultValue={16}
                className="border-line bg-surface-2"
              />
            </div>
            <div>
              <Label htmlFor="tplStartDate">Obowiązuje od (opcjonalnie)</Label>
              <Input
                id="tplStartDate"
                name="startDate"
                type="date"
                className="border-line bg-surface-2"
              />
              <p className="text-muted-brand mt-1 text-xs">
                Puste = od zaraz. Ustaw, jeśli zajęcia ruszają dopiero za jakiś czas.
              </p>
            </div>
          </div>

          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="isKids" className="size-4" />
            <span className="text-text">Grupa dziecięca (widzą tylko niepełnoletni)</span>
          </label>

          <Button type="submit" className="self-start">
            Dodaj zajęcia cykliczne
          </Button>
        </form>

        <ul className="mt-3 flex flex-col gap-2">
          {templates.map((tpl) => {
            const startsInFuture = tpl.startDate ? tpl.startDate > now : false;
            return (
              <li
                key={tpl.id}
                className="border-line bg-surface flex flex-wrap items-start justify-between gap-3 rounded-md border p-3"
              >
                <div>
                  <p className="text-text font-medium">
                    {resolveClassName(tpl.name, tpl.category?.name ?? "Zajęcia")}
                    {tpl.isKids ? (
                      <span className="bg-amber/10 text-amber ml-2 rounded-full px-2 py-0.5 font-mono text-xs uppercase">
                        Dzieci
                      </span>
                    ) : null}
                  </p>
                  <p className="text-muted-brand mt-1 font-mono text-xs">
                    {WEEKDAY_LABELS[tpl.weekday]} · {tpl.startTime} · {tpl.durationMin} min ·{" "}
                    {tpl.location.name} · {tpl.trainer.user.name} · {tpl.capacity} miejsc
                    {tpl.category ? ` · ${tpl.category.name}` : ""}
                  </p>
                  {startsInFuture && tpl.startDate ? (
                    <p className="text-amber mt-1 text-xs">Rusza od {formatDate(tpl.startDate)}</p>
                  ) : null}
                </div>
                <form action={stopClassTemplateAction}>
                  <input type="hidden" name="templateId" value={tpl.id} />
                  <Button type="submit" size="sm" variant="outline">
                    Zakończ
                  </Button>
                </form>
              </li>
            );
          })}
          {templates.length === 0 ? (
            <li className="text-muted-brand text-sm">
              Brak zajęć cyklicznych. Dodaj plan powyżej - terminy wygenerują się automatycznie.
            </li>
          ) : null}
        </ul>
      </section>

      {(() => {
        const editorInner = (
          <>
            <h2 className="text-muted-brand font-mono text-xs tracking-widest uppercase">
              {editing ? "Edytuj zajęcia" : "Dodaj zajęcia jednorazowe"}
            </h2>

            <form
              action={editing ? updateSessionAction : createSessionAction}
              className="border-line bg-surface mt-2 flex flex-col gap-4 rounded-md border p-4"
            >
              {editing ? <input type="hidden" name="sessionId" value={editing.id} /> : null}

              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <Label htmlFor="name">Nazwa (opcjonalnie)</Label>
                  <Input
                    id="name"
                    name="name"
                    defaultValue={editing?.name ?? ""}
                    placeholder="domyślnie nazwa rodzaju"
                    className="border-line bg-surface-2"
                  />
                </div>
                <div>
                  <Label htmlFor="categoryId">Rodzaj</Label>
                  <select
                    id="categoryId"
                    name="categoryId"
                    required
                    defaultValue={editing?.categoryId ?? ""}
                    className={selectClass}
                  >
                    <option value="">Wybierz...</option>
                    {activeCategories.map((category) => (
                      <option key={category.id} value={category.id}>
                        {category.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <Label htmlFor="date">Data</Label>
                  <Input
                    id="date"
                    name="date"
                    type="date"
                    required
                    defaultValue={editing ? toDateInputValue(editing.startsAt) : ""}
                    className="border-line bg-surface-2"
                  />
                </div>
                <div>
                  <Label htmlFor="time">Godzina</Label>
                  <Input
                    id="time"
                    name="time"
                    type="time"
                    required
                    defaultValue={editing ? toTimeInputValue(editing.startsAt) : ""}
                    className="border-line bg-surface-2"
                  />
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <Label htmlFor="locationId">Miejsce</Label>
                  <select
                    id="locationId"
                    name="locationId"
                    required
                    defaultValue={editing?.locationId ?? ""}
                    className={selectClass}
                  >
                    <option value="">Wybierz...</option>
                    {locations.map((location) => (
                      <option key={location.id} value={location.id}>
                        {location.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <Label htmlFor="trainerId">Trener</Label>
                  <select
                    id="trainerId"
                    name="trainerId"
                    required
                    defaultValue={editing?.trainerId ?? ""}
                    className={selectClass}
                  >
                    <option value="">Wybierz...</option>
                    {trainers.map((trainer) => (
                      <option key={trainer.id} value={trainer.id}>
                        {trainer.user.name} ({trainer.location.name})
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <Label htmlFor="durationMin">Czas trwania (min)</Label>
                  <Input
                    id="durationMin"
                    name="durationMin"
                    type="number"
                    min="15"
                    step="5"
                    required
                    defaultValue={editing ? durationMinutes(editing.startsAt, editing.endsAt) : 60}
                    className="border-line bg-surface-2"
                  />
                </div>
                <div>
                  <Label htmlFor="capacity">Liczba miejsc</Label>
                  <Input
                    id="capacity"
                    name="capacity"
                    type="number"
                    min="1"
                    required
                    defaultValue={editing?.capacity ?? 16}
                    className="border-line bg-surface-2"
                  />
                </div>
              </div>

              <div className="flex items-center gap-3">
                <Button type="submit">{editing ? "Zapisz zmiany" : "Dodaj zajęcia"}</Button>
                {editing ? (
                  <a href="/admin/zajecia" className="text-muted-brand text-sm underline">
                    Anuluj edycję
                  </a>
                ) : null}
              </div>
            </form>

            {/* Odwołanie z powodem - osobny formularz (nie zagnieżdżamy w edycji).
            Tu trafia „Usuń" z plannera dla zajęć, na które ktoś jest zapisany:
            takich nie kasujemy po cichu, bo klienci muszą poznać powód. */}
            {editing && editing.status !== "CANCELLED" && editing.startsAt > now ? (
              <form
                action={cancelSessionAction}
                className="border-amber/40 bg-amber/5 mt-3 flex flex-col gap-2 rounded-md border p-4"
              >
                <input type="hidden" name="sessionId" value={editing.id} />
                <p className="text-text text-sm font-medium">Odwołaj te zajęcia</p>
                <p className="text-muted-brand text-xs">
                  Powód zobaczą zapisani klienci. Odwołanie zwalnia miejsca i zdejmuje zajęcia z
                  grafiku.
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    name="reason"
                    required
                    placeholder="Powód odwołania"
                    className="border-line bg-surface-2 h-9 flex-1"
                  />
                  <Button type="submit" variant="outline">
                    Odwołaj zajęcia
                  </Button>
                </div>
              </form>
            ) : null}
          </>
        );
        return editing ? (
          <EditDialog closeHref="/admin/zajecia">{editorInner}</EditDialog>
        ) : (
          <section>{editorInner}</section>
        );
      })()}

      <section>
        <details className="group">
          <summary className="text-muted-brand hover:text-brand-red flex cursor-pointer list-none items-center gap-2 font-mono text-xs tracking-widest uppercase [&::-webkit-details-marker]:hidden">
            <span className="transition-transform group-open:rotate-90">▸</span>
            Lista terminów · edycja i odwołanie ({sessions.length})
          </summary>
          <p className="text-muted-brand mt-1 text-sm">
            Grafik oglądasz w planerze wyżej. Tu edytujesz i odwołujesz pojedyncze terminy.
          </p>
          <ul className="mt-2 flex flex-col gap-2">
            {sessions.map((session) => {
              const isCancelled = session.status === "CANCELLED";
              return (
                <li
                  key={session.id}
                  className={`rounded-md border p-3 ${
                    isCancelled ? "border-line bg-surface-2 opacity-60" : "border-line bg-surface"
                  }`}
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="text-text font-medium">
                        {session.name}
                        {session.kind === "INDIVIDUAL" ? (
                          <span className="bg-jade/10 text-jade ml-2 rounded-full px-2 py-0.5 font-mono text-xs uppercase">
                            Indywidualny
                          </span>
                        ) : null}
                        {isCancelled ? (
                          <span className="bg-red/10 text-red ml-2 rounded-full px-2 py-0.5 font-mono text-xs uppercase">
                            Odwołane
                          </span>
                        ) : null}
                      </p>
                      <p className="text-muted-brand mt-1 font-mono text-xs">
                        {formatDayTime(session.startsAt)} · {session.location.name} ·{" "}
                        {session.trainer.user.name} · {session.bookings.length}/{session.capacity}{" "}
                        miejsc
                      </p>
                      {session.cancelledReason ? (
                        <p className="text-red mt-1 text-xs">Powód: {session.cancelledReason}</p>
                      ) : null}
                    </div>

                    {!isCancelled ? (
                      <div className="flex flex-wrap items-center gap-2">
                        {session.kind === "GROUP" ? (
                          <a
                            href={`/admin/zajecia?edit=${session.id}`}
                            className="border-line bg-surface-2 text-text hover:text-brand-red rounded-md border px-3 py-1.5 font-mono text-xs uppercase"
                          >
                            Edytuj
                          </a>
                        ) : null}
                        <form action={cancelSessionAction} className="flex items-center gap-2">
                          <input type="hidden" name="sessionId" value={session.id} />
                          <Input
                            name="reason"
                            required
                            placeholder="Powód odwołania"
                            className="border-line bg-surface-2 h-8 w-44 text-xs"
                          />
                          <Button type="submit" size="sm" variant="outline">
                            Odwołaj
                          </Button>
                        </form>
                      </div>
                    ) : null}
                  </div>
                </li>
              );
            })}
            {sessions.length === 0 ? (
              <li className="text-muted-brand text-sm">Brak zaplanowanych zajęć.</li>
            ) : null}
          </ul>
        </details>
      </section>

      <section>
        <h2 className="text-muted-brand font-mono text-xs tracking-widest uppercase">
          Okna treningów indywidualnych
        </h2>
        <p className="text-muted-brand mt-1 text-sm">
          Klient zapisuje się wyłącznie na terminy wyliczone z tych okien - poza nimi nie ma czego
          kliknąć.
        </p>

        <form
          action={createAvailabilityWindowAction}
          className="border-line bg-surface mt-2 grid gap-3 rounded-md border p-4 sm:grid-cols-5"
        >
          <div className="sm:col-span-2">
            <Label htmlFor="windowTrainerId">Trener</Label>
            <select id="windowTrainerId" name="trainerId" required className={selectClass}>
              <option value="">Wybierz...</option>
              {trainers.map((trainer) => (
                <option key={trainer.id} value={trainer.id}>
                  {trainer.user.name} ({trainer.location.name})
                </option>
              ))}
            </select>
          </div>

          <div>
            <Label htmlFor="windowLocationId">Sala</Label>
            <select id="windowLocationId" name="locationId" required className={selectClass}>
              {locations.map((location) => (
                <option key={location.id} value={location.id}>
                  {location.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <Label htmlFor="weekday">Dzień</Label>
            <select id="weekday" name="weekday" required defaultValue="1" className={selectClass}>
              {WEEKDAY_LABELS.map((label, index) => (
                <option key={label} value={index}>
                  {label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <Label htmlFor="startTime">Od</Label>
            <Input
              id="startTime"
              name="startTime"
              type="time"
              required
              defaultValue="16:00"
              className="border-line bg-surface-2"
            />
          </div>

          <div>
            <Label htmlFor="endTime">Do</Label>
            <Input
              id="endTime"
              name="endTime"
              type="time"
              required
              defaultValue="20:00"
              className="border-line bg-surface-2"
            />
          </div>

          <div className="sm:col-span-2">
            <Label htmlFor="slotMinutes">Długość treningu</Label>
            <select
              id="slotMinutes"
              name="slotMinutes"
              required
              defaultValue="60"
              className={selectClass}
            >
              {SLOT_MINUTES_OPTIONS.map((minutes) => (
                <option key={minutes} value={minutes}>
                  {minutes} min
                </option>
              ))}
            </select>
          </div>

          <div className="flex items-end sm:col-span-3">
            <Button type="submit">Dodaj okno</Button>
          </div>
        </form>

        <ul className="mt-3 flex flex-col gap-2">
          {windows.map((window) => (
            <li
              key={window.id}
              className="border-line bg-surface flex items-center justify-between rounded-md border p-3"
            >
              <div>
                <p className="text-text font-medium">{window.trainer.user.name}</p>
                <p className="text-muted-brand mt-1 font-mono text-xs">
                  {WEEKDAY_LABELS[window.weekday]} · {window.startTime}-{window.endTime} · treningi
                  po {window.slotMinutes} min · {window.location.name}
                </p>
              </div>
              <form action={deleteAvailabilityWindowAction}>
                <input type="hidden" name="windowId" value={window.id} />
                <Button type="submit" size="sm" variant="outline">
                  Usuń
                </Button>
              </form>
            </li>
          ))}
          {windows.length === 0 ? (
            <li className="text-muted-brand text-sm">
              Brak okien - nikt nie może zapisać się na trening indywidualny.
            </li>
          ) : null}
        </ul>
      </section>

      {/* Ustawienia okna zapisów i odwołania - zmienia się je rzadko, więc
      zwinięte na dole, żeby nie zaśmiecały codziennej pracy z grafikiem. */}
      <section>
        <details className="group border-line bg-surface rounded-md border">
          <summary className="text-text hover:bg-surface-2 flex cursor-pointer list-none items-center justify-between gap-2 rounded-md p-4 [&::-webkit-details-marker]:hidden">
            <span className="flex items-center gap-2">
              <span className="text-brand-red font-mono text-lg leading-none transition-transform group-open:rotate-90">
                ▸
              </span>
              <span className="font-mono text-sm font-bold tracking-widest uppercase">
                Okno zapisów i odwołania
              </span>
            </span>
            <span className="text-muted-brand group-hover:text-brand-red shrink-0 font-mono text-xs tracking-widest uppercase">
              <span className="group-open:hidden">Rozwiń ▾</span>
              <span className="hidden group-open:inline">Zwiń ▴</span>
            </span>
          </summary>
          <div className="border-line border-t p-4">
            <p className="text-muted-brand text-sm">
              Ustawienia horyzontu zapisów i granicy bezkosztowego odwołania. Zmienia się je rzadko.
            </p>

            <div className="mt-3 flex flex-col gap-6">
              <div>
                <h3 className="text-muted-brand font-mono text-xs tracking-widest uppercase">
                  Okno zapisów
                </h3>
                <form
                  action={updateBookingHorizonAction}
                  className="border-line bg-surface mt-2 flex flex-col gap-4 rounded-md border p-4"
                >
                  <div className="flex flex-col gap-3">
                    <label className="flex items-start gap-3">
                      <input
                        type="radio"
                        name="bookingHorizonMode"
                        value="CURRENT_WEEK"
                        defaultChecked={settings.bookingHorizonMode === "CURRENT_WEEK"}
                        className="mt-1 size-4 shrink-0"
                      />
                      <span>
                        <span className="text-text text-sm font-medium">Bieżący tydzień</span>
                        <span className="text-muted-brand block text-sm">
                          Klient zapisuje się do najbliższej niedzieli włącznie - niezależnie od
                          tego, czy dziś jest poniedziałek czy czwartek. Okno przeskakuje na kolejny
                          tydzień o północy z niedzieli na poniedziałek.
                        </span>
                      </span>
                    </label>

                    <label className="flex items-start gap-3">
                      <input
                        type="radio"
                        name="bookingHorizonMode"
                        value="FIXED_DAYS"
                        defaultChecked={settings.bookingHorizonMode === "FIXED_DAYS"}
                        className="mt-1 size-4 shrink-0"
                      />
                      <span className="flex-1">
                        <span className="text-text text-sm font-medium">Stała liczba dni</span>
                        <span className="text-muted-brand block text-sm">
                          Okno przesuwa się razem z dzisiejszą datą - zawsze tyle samo dni do
                          przodu.
                        </span>
                        <select
                          name="bookingHorizonDays"
                          defaultValue={String(settings.bookingHorizonDays)}
                          className={`${selectClass} mt-2 max-w-40`}
                        >
                          {FIXED_HORIZON_OPTIONS.map((days) => (
                            <option key={days} value={days}>
                              {days} dni
                            </option>
                          ))}
                        </select>
                      </span>
                    </label>
                  </div>

                  <p className="border-line bg-surface-2 text-muted-brand rounded-md border p-3 text-sm">
                    Teraz obowiązuje:{" "}
                    <b className="text-text">
                      {describeHorizon(settings.bookingHorizonMode, settings.bookingHorizonDays)}
                    </b>
                    . Ostatni dzień do zapisania się to{" "}
                    <b className="text-text">{formatDate(new Date(horizonEnd.getTime() - 1))}</b>.
                  </p>

                  <Button type="submit" className="self-start">
                    Zapisz okno zapisów
                  </Button>
                </form>
              </div>

              <div>
                <h3 className="text-muted-brand font-mono text-xs tracking-widest uppercase">
                  Okno odwołania
                </h3>
                <form
                  action={updateCancellationWindowAction}
                  className="border-line bg-surface mt-2 flex flex-col gap-4 rounded-md border p-4"
                >
                  <div>
                    <label
                      htmlFor="freeCancellationHours"
                      className="text-text block text-sm font-medium"
                    >
                      Ile godzin przed startem odwołanie jest bezkosztowe
                    </label>
                    <p className="text-muted-brand mt-0.5 text-sm">
                      Odwołanie poniżej tej granicy kosztuje wejście z karnetu - tak samo przy
                      zajęciach grupowych, indywidualnych i przy zgłoszeniu nieobecności. Trener
                      zawsze może zwrócić wejście ręcznie.
                    </p>
                    <div className="mt-2 flex items-center gap-2">
                      <Input
                        id="freeCancellationHours"
                        name="freeCancellationHours"
                        type="number"
                        inputMode="numeric"
                        min={MIN_CANCELLATION_WINDOW_HOURS}
                        max={MAX_CANCELLATION_WINDOW_HOURS}
                        step={1}
                        required
                        defaultValue={String(settings.freeCancellationHours)}
                        className="max-w-28"
                      />
                      <span className="text-muted-brand font-mono text-xs tracking-widest uppercase">
                        godz.
                      </span>
                    </div>
                  </div>

                  <p className="border-line bg-surface-2 text-muted-brand rounded-md border p-3 text-sm">
                    Teraz obowiązuje:{" "}
                    <b className="text-text">{settings.freeCancellationHours} godz.</b> Zmiana
                    działa tylko w przód - już odwołane zajęcia zachowują swój wynik, więc nikomu
                    nie odbierze ani nie odda wejścia wstecz.
                  </p>

                  <Button type="submit" className="self-start">
                    Zapisz okno odwołania
                  </Button>
                </form>
              </div>
            </div>
          </div>
        </details>
      </section>

      <details className="border-line bg-surface rounded-md border">
        <summary className="text-text flex cursor-pointer list-none items-center gap-2 p-4 font-mono text-xs tracking-widest uppercase [&::-webkit-details-marker]:hidden">
          <Info className="text-brand-red size-4" />
          Jak to działa
        </summary>
        <div className="border-line text-muted-brand flex max-w-[72ch] flex-col gap-5 border-t p-4 text-sm">
          <div>
            <p className="text-text mb-1 font-mono text-xs tracking-widest uppercase">
              Zajęcia grupowe
            </p>
            <p>
              Dodane tutaj zajęcia pojawiają się w grafiku klientów od razu. Zajęcia generowane
              automatycznie z powtarzalnego planu też są na liście - można je odwołać, ale edytuje
              się wyłącznie te dodane ręcznie. Zajęcia, które już się rozpoczęły, są zablokowane do
              edycji: zmiana historii rozjechałaby obecności i wyniki trenerów.
            </p>
          </div>

          <div>
            <p className="text-text mb-1 font-mono text-xs tracking-widest uppercase">
              Okna treningów indywidualnych
            </p>
            <p>
              Okno to reguła tygodniowa, np. „Adam, wtorki 16:00-20:00, treningi po 60 min”. System
              dzieli je na konkretne terminy (16:00, 17:00, 18:00, 19:00) i tylko te terminy widzi
              klient. Godzina spoza okna nie istnieje jako opcja -{" "}
              <b>nikt nie zapisze się na 23:00</b>, nawet próbując ominąć formularz, bo serwer
              sprawdza żądany termin względem tej samej listy.
            </p>
            <p className="mt-2">
              Niepełna końcówka okna przepada: przy oknie 16:00-17:30 i treningach 60-minutowych
              powstanie jeden termin (16:00), bo drugi nie zmieściłby się w całości.
            </p>
          </div>

          <div>
            <p className="text-text mb-1 font-mono text-xs tracking-widest uppercase">
              Zajęty termin i wyprzedzenie
            </p>
            <p>
              Termin znika z listy, gdy ktoś go zajmie oraz gdy do jego startu zostało mniej niż{" "}
              {MIN_BOOKING_LEAD_HOURS} godz. - trener musi mieć szansę zobaczyć zapis. Ten sam
              trener nie może mieć dwóch rzeczy naraz: system blokuje nachodzące na siebie terminy
              zarówno przy dodawaniu zajęć grupowych, jak i przy zapisie na trening indywidualny.
            </p>
          </div>

          <div>
            <p className="text-text mb-1 font-mono text-xs tracking-widest uppercase">
              Usunięcie okna
            </p>
            <p>
              Kasuje tylko regułę na przyszłość. Już umówione treningi zostają - to konkretne
              zobowiązania wobec klientów, więc odwołuje się je świadomie na liście zajęć powyżej, z
              podaniem powodu.
            </p>
          </div>
        </div>
      </details>
    </div>
  );
}
