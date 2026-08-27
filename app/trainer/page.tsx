import { prisma } from "@/lib/prisma";
import { requireTrainerSelf } from "@/lib/auth/guard";
import { addCalendarDays, todayInTimeZone, zonedTimeToUtc } from "@/lib/domain/time";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { effectiveTrainerId, seesSessionWhere } from "@/lib/domain/substitute";
import { formatDayTime } from "@/lib/format";
import {
  classifyTrainerCheckIn,
  TRAINER_CHECK_IN_LABEL,
  type TrainerCheckInState,
} from "@/lib/domain/class-qr";
import { getClubSettings } from "@/lib/services/settings";
import {
  assignSubstituteAction,
  cancelSessionAction,
  confirmAttendanceAction,
  confirmConsentDeliveryAction,
  markManualAttendanceAction,
  respondToSubstituteAction,
} from "./actions";
import { OfflineForm } from "../offline-form";

// Odbicie prowadzącego: kolor idzie za stanem, nie za samą godziną. Doszedł
// stan "odbił się inny trener" - dawny warunek na trainerCheckedInAt nie miał
// jak go pokazać, bo nie wiedział, KTO się odbił.
const CHECK_IN_STYLE: Record<TrainerCheckInState, string> = {
  ON_TIME: "text-jade",
  LATE: "text-amber",
  MISSING: "text-red",
  PENDING: "text-muted-brand",
  OTHER_TRAINER: "text-red",
};

// Konto prowadzącego - z uwzględnieniem potwierdzonego zastępstwa.
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

function formatTime(date: Date): string {
  return new Intl.DateTimeFormat("pl-PL", {
    timeZone: "Europe/Warsaw",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export default async function TrainerTodayPage() {
  const { trainer } = await requireTrainerSelf();
  const settings = await getClubSettings();
  const now = new Date();

  const today = todayInTimeZone(now);
  const tomorrow = addCalendarDays(today, 1);
  const todayStart = zonedTimeToUtc(today.year, today.month, today.day, 0, 0);
  const todayEnd = zonedTimeToUtc(tomorrow.year, tomorrow.month, tomorrow.day, 0, 0);

  const [sessions, pendingForMe, otherTrainers] = await Promise.all([
    prisma.session.findMany({
      where: {
        startsAt: { gte: todayStart, lt: todayEnd },
        status: "SCHEDULED",
        ...seesSessionWhere(trainer.id),
      },
      include: {
        bookings: {
          where: { status: { in: ["BOOKED", "ATTENDED"] } },
          include: { member: true },
        },
        attendances: true,
        trainer: { include: { user: true } },
        substituteTrainer: { include: { user: true } },
      },
      orderBy: { startsAt: "asc" },
    }),

    // Prośby o zastępstwo z całej przyszłości, nie tylko z dzisiaj - inaczej
    // prośba na przyszły tydzień byłaby niewidoczna aż do dnia zajęć.
    prisma.session.findMany({
      where: {
        substituteTrainerId: trainer.id,
        substituteStatus: "PENDING",
        status: "SCHEDULED",
        startsAt: { gte: new Date() },
      },
      include: {
        location: true,
        trainer: { include: { user: true } },
      },
      orderBy: { startsAt: "asc" },
    }),

    prisma.trainer.findMany({
      where: { locationId: trainer.locationId, active: true, id: { not: trainer.id } },
      include: { user: true },
    }),
  ]);

  return (
    <div className="flex flex-col gap-6">
      {pendingForMe.length > 0 ? (
        <section className="border-amber bg-surface rounded-md border-2 p-4">
          <h2 className="text-amber font-mono text-xs tracking-widest uppercase">
            Zastępstwa do potwierdzenia ({pendingForMe.length})
          </h2>
          <ul className="mt-3 flex flex-col gap-3">
            {pendingForMe.map((s) => (
              <li key={s.id} className="border-line bg-surface-2 rounded-md border p-3">
                <p className="text-text font-medium">{s.name}</p>
                <p className="text-muted-brand mt-0.5 font-mono text-xs">
                  {formatDayTime(s.startsAt)} · {s.location.name}
                </p>
                <p className="text-muted-brand mt-1 text-sm">
                  {s.substituteByAdmin ? (
                    <>
                      Wyznaczone przez właściciela. Zajęcia prowadzi{" "}
                      <b className="text-text">{s.trainer.user.name}</b> - potwierdź, że przyjmujesz
                      zastępstwo do wiadomości.
                    </>
                  ) : (
                    <>
                      <b className="text-text">{s.trainer.user.name}</b> prosi Cię o zastępstwo.
                      Możesz potwierdzić albo odmówić.
                    </>
                  )}
                </p>

                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <form action={respondToSubstituteAction}>
                    <input type="hidden" name="sessionId" value={s.id} />
                    <input type="hidden" name="decision" value="ACCEPT" />
                    <Button type="submit" size="sm">
                      {s.substituteByAdmin ? "Przyjmuję do wiadomości" : "Potwierdzam"}
                    </Button>
                  </form>

                  {/* Odmowa tylko przy prośbie od trenera - polecenia
                      właściciela się nie odrzuca (lib/domain/substitute.ts). */}
                  {!s.substituteByAdmin ? (
                    <form action={respondToSubstituteAction} className="flex items-center gap-2">
                      <input type="hidden" name="sessionId" value={s.id} />
                      <input type="hidden" name="decision" value="DECLINE" />
                      <Input
                        name="reason"
                        placeholder="Powód odmowy (opcjonalnie)"
                        className="w-56"
                      />
                      <Button type="submit" variant="outline" size="sm">
                        Nie mogę
                      </Button>
                    </form>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
          <p className="text-muted-brand mt-3 text-xs">
            Dopóki nie potwierdzisz, zajęcia prowadzi trener pierwotny - nikt nie zostaje bez
            opieki.
          </p>
        </section>
      ) : null}

      {sessions.length === 0 ? <p className="text-muted-brand">Brak zajęć dzisiaj.</p> : null}

      {sessions.map((s) => (
        <section key={s.id} className="border-line bg-surface rounded-md border p-4">
          <div className="flex items-center justify-between">
            <h2 className="text-text font-medium">
              {s.name} - {formatTime(s.startsAt)}
            </h2>
            {s.substituteStatus && s.substituteTrainer ? (
              <span
                className={`font-mono text-xs tracking-widest uppercase ${
                  s.substituteStatus === "ACCEPTED"
                    ? "text-jade"
                    : s.substituteStatus === "DECLINED"
                      ? "text-red"
                      : "text-amber"
                }`}
              >
                {s.substituteStatus === "ACCEPTED"
                  ? `Prowadzi ${s.substituteTrainer.user.name}`
                  : s.substituteStatus === "DECLINED"
                    ? `${s.substituteTrainer.user.name} odmówił(a)`
                    : `Czeka na ${s.substituteTrainer.user.name}`}
              </span>
            ) : null}
          </div>

          {/* Odmowa musi być widoczna dla trenera pierwotnego - to on wraca
              do prowadzenia i musi wiedzieć dlaczego. */}
          {s.substituteStatus === "DECLINED" && s.trainerId === trainer.id ? (
            <p className="border-red bg-surface-2 text-text mt-2 rounded-md border p-2 text-sm">
              {s.substituteTrainer?.user.name} nie może poprowadzić tych zajęć
              {s.substituteDeclineReason ? `: ${s.substituteDeclineReason}.` : "."} Zajęcia wracają
              do Ciebie - wyznacz kogoś innego albo poprowadź je sam(a).
            </p>
          ) : null}

          {/* Zastępca przed potwierdzeniem widzi zajęcia, ale nie odhacza
              jeszcze obecności - odpowiada za nie trener pierwotny. */}
          {s.substituteStatus === "PENDING" && s.substituteTrainerId === trainer.id ? (
            <p className="border-amber bg-surface-2 text-muted-brand mt-2 rounded-md border p-2 text-sm">
              Potwierdź zastępstwo powyżej, żeby móc prowadzić listę obecności.
            </p>
          ) : null}

          {/* Stan odbić na tych zajęciach: czy prowadzący się odbił i ile
              osób odbiło kod. Zatwierdzenie zamyka listę. */}
          <div className="border-line-soft bg-surface-2 mt-3 flex flex-wrap items-center justify-between gap-2 rounded-md border p-2 font-mono text-xs">
            {(() => {
              const checkIn = classifyTrainerCheckIn({
                session: s,
                checkedInAt: s.trainerCheckedInAt,
                checkedInUserId: s.trainerCheckedInUserId,
                leadUserId: leadUserIdOf(s),
                now,
                minutesBefore: settings.trainerCheckInMinutesBefore,
              });
              return (
                <span className={CHECK_IN_STYLE[checkIn]}>{TRAINER_CHECK_IN_LABEL[checkIn]}</span>
              );
            })()}
            <span className="text-muted-brand">
              Odbić: {s.attendances.length}/{s.bookings.length}
            </span>
          </div>

          {s.attendanceConfirmedAt ? (
            <p className="border-jade/40 bg-jade/5 text-jade mt-2 rounded-md border p-2 text-sm">
              Obecność potwierdzona: {s.attendanceConfirmedCount} os.
            </p>
          ) : (
            <OfflineForm
              action={confirmAttendanceAction}
              op="POTWIERDZENIE_OBECNOSCI"
              detail={`${s.name} · ${formatTime(s.startsAt)}`}
              fields={["sessionId", "count"]}
              className="border-line-soft mt-2 flex flex-wrap items-center gap-2 rounded-md border p-2"
            >
              <input type="hidden" name="sessionId" value={s.id} />
              <span className="text-muted-brand text-sm">Policzone na sali:</span>
              <Input
                name="count"
                type="number"
                min={0}
                inputMode="numeric"
                defaultValue={s.attendances.length}
                aria-label="Liczba osób policzonych na sali"
                className="border-line bg-surface h-9 w-20"
              />
              <Button type="submit" size="sm" variant="outline">
                Potwierdź obecność
              </Button>
            </OfflineForm>
          )}

          <ul className="mt-3 flex flex-col gap-2">
            {s.bookings.map((b) => {
              const attendance = s.attendances.find((a) => a.memberId === b.memberId);
              const consentsMissing = b.member.consentsDeliveredAt == null;
              return (
                <li key={b.id} className="flex flex-col gap-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-text text-sm">
                      {b.member.firstName} {b.member.lastName}
                    </span>
                    {attendance ? (
                      <span className="text-jade font-mono text-xs tracking-widest uppercase">
                        Obecny ({attendance.method === "QR" ? "QR" : "ręcznie"})
                      </span>
                    ) : (
                      <OfflineForm
                        action={markManualAttendanceAction}
                        op="OBECNOSC_RECZNA"
                        detail={`${b.member.firstName} ${b.member.lastName} · ${s.name}`}
                        fields={["bookingId"]}
                      >
                        <input type="hidden" name="bookingId" value={b.id} />
                        <Button type="submit" variant="outline" size="sm">
                          Zaznacz obecność
                        </Button>
                      </OfflineForm>
                    )}
                  </div>

                  {/* Nowy klient bez dostarczonych podpisanych zgód: trener ma
                      odebrać wydruk i tu potwierdzić - do tego czasu klient nie
                      zapisze się na kolejne zajęcia. */}
                  {consentsMissing ? (
                    <div className="border-amber bg-amber/5 flex flex-wrap items-center justify-between gap-2 rounded-md border px-2 py-1.5">
                      <span className="text-amber text-xs">
                        Nowy - odbierz podpisane zgody do przekazania klubowi.
                      </span>
                      <form action={confirmConsentDeliveryAction}>
                        <input type="hidden" name="memberId" value={b.memberId} />
                        <Button type="submit" size="sm">
                          Potwierdź odbiór zgód
                        </Button>
                      </form>
                    </div>
                  ) : null}
                </li>
              );
            })}
            {s.bookings.length === 0 ? (
              <li className="text-muted-brand text-sm">Brak zapisanych.</li>
            ) : null}
          </ul>

          <div className="border-line-soft mt-4 flex flex-wrap items-center gap-4 border-t pt-3">
            {/* Zastępstwo wyznacza wyłącznie trener pierwotny. Zastępca, nawet
                po potwierdzeniu, nie przekazuje zajęć dalej. */}
            {otherTrainers.length > 0 && s.trainerId === trainer.id ? (
              <form action={assignSubstituteAction} className="flex items-center gap-2">
                <input type="hidden" name="sessionId" value={s.id} />
                <select
                  name="substituteTrainerId"
                  defaultValue={s.substituteTrainerId ?? ""}
                  className="border-line bg-surface-2 text-text rounded-md border px-2 py-1 text-sm"
                >
                  {/* Pusta wartość wycofuje zastępstwo - bez niej nie dałoby
                      się odwołać własnej prośby. */}
                  <option value="">Bez zastępstwa</option>
                  {otherTrainers.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.user.name}
                    </option>
                  ))}
                </select>
                <Button type="submit" variant="outline" size="sm">
                  Zapisz zastępstwo
                </Button>
              </form>
            ) : null}

            <form action={cancelSessionAction} className="flex items-center gap-2">
              <input type="hidden" name="sessionId" value={s.id} />
              <Input
                name="reason"
                placeholder="Powód odwołania"
                required
                className="border-line bg-surface-2 h-8 w-48 text-sm"
              />
              <Button type="submit" variant="destructive" size="sm">
                Odwołaj zajęcia
              </Button>
            </form>
          </div>
        </section>
      ))}
    </div>
  );
}
