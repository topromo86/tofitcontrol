import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireOwnsMember } from "@/lib/auth/guard";
import { calculateAge } from "@/lib/domain/booking";
import { daysSince } from "@/lib/domain/retention";
import { MEMBER_LEVEL_LABEL } from "@/lib/domain/member-level";
import { formatDate } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ABSENCE_REASON_LABEL } from "@/lib/domain/absence";
import { getClubSettings } from "@/lib/services/settings";
import {
  addMeasurementAction,
  addNoteAction,
  closeRetentionTaskAction,
  completeOnboardingStepAction,
  refundEntryAction,
  resolveAbsenceReportAction,
} from "../actions";

const RETENTION_TASK_LABEL: Record<string, string> = {
  INACTIVE_7: "Brak treningu od 7 dni",
  INACTIVE_14: "Brak treningu od 14 dni - eskalacja",
  RENEWAL: "Kończy się karnet",
};

const ONBOARDING_LABEL: Record<number, string> = {
  1: "Rozmowa wstępna (dzień 3)",
  2: "Kontakt kontrolny (dzień 14)",
  3: "Retest i rozmowa o postępach (dzień 84)",
};

function formatTenure(joinedAt: Date | null, now: Date): string {
  if (!joinedAt) return "Jeszcze nie dołączył(a) - brak pierwszej płatności lub obecności.";
  const days = daysSince(joinedAt, now)!;
  return `Od ${formatDate(joinedAt)} (${days} dni)`;
}

export default async function MemberCardPage({
  params,
}: {
  params: Promise<{ memberId: string }>;
}) {
  const { memberId } = await params;
  await requireOwnsMember(memberId);

  const settings = await getClubSettings();

  const member = await prisma.member.findUnique({
    where: { id: memberId },
    include: {
      ownerTrainer: { include: { user: true } },
      notes: { orderBy: { createdAt: "desc" }, include: { authorUser: true } },
      onboardingSteps: { orderBy: { step: "asc" } },
      retentionTasks: { where: { closedAt: null }, orderBy: { createdAt: "asc" } },
      attendances: { orderBy: { checkedInAt: "desc" }, take: 10, include: { session: true } },
      measurements: { orderBy: { recordedAt: "desc" }, take: 5 },
      absenceReports: { where: { resolvedAt: null }, orderBy: { reportedAt: "desc" } },
      bookings: {
        where: { absenceReason: { not: null } },
        include: { session: true },
        orderBy: { cancelledAt: "desc" },
        take: 15,
      },
    },
  });
  if (!member) notFound();

  const now = new Date();
  const age = calculateAge(member.birthDate, now);

  return (
    <div className="flex flex-col gap-8">
      <section>
        <h1 className="font-display text-brand-red text-2xl tracking-wide">
          {member.firstName} {member.lastName}
        </h1>
        <p className="text-muted-brand mt-1 font-mono text-xs tracking-widest uppercase">
          {age} lat ·{" "}
          {member.sex === "FEMALE" ? "Kobieta" : member.sex === "MALE" ? "Mężczyzna" : "?"}
          {member.isMinor ? " · Niepełnoletni" : ""} · Poziom {MEMBER_LEVEL_LABEL[member.level]} ·
          Status {member.status}
        </p>
        <p className="text-muted-brand mt-1 text-sm">Opiekun: {member.ownerTrainer.user.name}</p>
        <p className="mt-2 text-sm">
          <span className="text-muted-brand font-mono text-xs tracking-widest uppercase">
            Cel:{" "}
          </span>
          {member.goal ? member.goal : <span className="text-red">brak ustalonego celu</span>}
        </p>
        <p className="text-muted-brand mt-1 text-sm">{formatTenure(member.joinedAt, now)}</p>
      </section>

      {member.absenceReports.length > 0 ? (
        <section>
          <h2 className="text-muted-brand font-mono text-xs tracking-widest uppercase">
            Zgłoszona nieobecność ({member.absenceReports.length})
          </h2>
          <ul className="mt-2 flex flex-col gap-3">
            {member.absenceReports.map((report) => (
              <li key={report.id} className="border-amber/40 bg-amber/5 rounded-md border p-3">
                <p className="text-text font-medium">
                  {ABSENCE_REASON_LABEL[report.reason] ?? report.reason}
                </p>
                {report.note ? <p className="text-text mt-1 text-sm">{report.note}</p> : null}
                <p className="text-muted-brand mt-1 font-mono text-xs">
                  Zgłoszono {formatDate(report.reportedAt)}
                </p>
                <form action={resolveAbsenceReportAction} className="mt-2">
                  <input type="hidden" name="absenceReportId" value={report.id} />
                  <input type="hidden" name="memberId" value={member.id} />
                  <Button type="submit" size="sm" variant="outline">
                    Oznacz jako zakończone
                  </Button>
                </form>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {member.retentionTasks.length > 0 ? (
        <section>
          <h2 className="text-muted-brand font-mono text-xs tracking-widest uppercase">
            Otwarte zadania ({member.retentionTasks.length})
          </h2>
          <ul className="mt-2 flex flex-col gap-3">
            {member.retentionTasks.map((task) => (
              <li key={task.id} className="border-red/40 bg-red/5 rounded-md border p-3">
                <p className="text-text font-medium">
                  {RETENTION_TASK_LABEL[task.type] ?? task.type}
                  {task.escalatedAt ? (
                    <span className="text-red ml-2 font-mono text-xs uppercase">eskalowane</span>
                  ) : null}
                </p>
                <form action={closeRetentionTaskAction} className="mt-2 flex flex-col gap-2">
                  <input type="hidden" name="retentionTaskId" value={task.id} />
                  <input type="hidden" name="memberId" value={member.id} />
                  <Textarea
                    name="body"
                    placeholder="Notatka z kontaktu (min. 30 znaków) - wymagana do zamknięcia zadania"
                    required
                    minLength={30}
                    className="border-line bg-surface-2"
                  />
                  <Button type="submit" size="sm" className="self-start">
                    Zamknij zadanie
                  </Button>
                </form>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {member.bookings.length > 0 ? (
        <section>
          <h2 className="text-muted-brand font-mono text-xs tracking-widest uppercase">
            Zgłoszone nieobecności na zajęciach ({member.bookings.length})
          </h2>
          <ul className="mt-2 flex flex-col gap-2">
            {member.bookings.map((booking) => {
              const lostEntry = booking.status === "NO_SHOW" && booking.chargedPassId != null;
              return (
                <li key={booking.id} className="border-line bg-surface rounded-md border p-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <p className="text-text font-medium">
                        {booking.session.name}
                        <span className="text-muted-brand ml-2 font-mono text-xs">
                          {ABSENCE_REASON_LABEL[booking.absenceReason!] ?? booking.absenceReason}
                        </span>
                      </p>
                      <p className="text-muted-brand mt-0.5 font-mono text-xs">
                        {formatDate(booking.session.startsAt)}
                        {booking.status === "NO_SHOW"
                          ? " · odwołane po terminie"
                          : " · odwołane na czas"}
                      </p>
                      {booking.cancellationNote ? (
                        <p className="text-text mt-1 text-sm">{booking.cancellationNote}</p>
                      ) : null}
                    </div>

                    {lostEntry ? (
                      booking.entryRefundedAt ? (
                        <span className="text-jade font-mono text-xs tracking-widest uppercase">
                          Wejście zwrócone
                        </span>
                      ) : (
                        <form action={refundEntryAction} className="flex items-center gap-2">
                          <input type="hidden" name="bookingId" value={booking.id} />
                          <input type="hidden" name="memberId" value={member.id} />
                          <span className="text-amber font-mono text-xs">Wejście przepadło</span>
                          <Button type="submit" size="sm" variant="outline">
                            Zwróć wejście
                          </Button>
                        </form>
                      )
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
          <p className="text-muted-brand mt-2 text-xs">
            Odwołanie na mniej niż {settings.freeCancellationHours} godz. przed startem kosztuje
            wejście automatycznie. Jeśli uznasz, że w tej sytuacji się należy - zwróć je.
          </p>
        </section>
      ) : null}

      <section>
        <h2 className="text-muted-brand font-mono text-xs tracking-widest uppercase">Onboarding</h2>
        <ul className="mt-2 flex flex-col gap-3">
          {member.onboardingSteps.map((step) => (
            <li key={step.id} className="border-line bg-surface rounded-md border p-3">
              <div className="flex items-center justify-between">
                <span className="text-text font-medium">
                  {ONBOARDING_LABEL[step.step] ?? `Etap ${step.step}`}
                </span>
                <span className="text-muted-brand font-mono text-xs">
                  {step.completedAt
                    ? `Zrobione ${formatDate(step.completedAt)}`
                    : `Termin: ${formatDate(step.dueAt)}${step.dueAt < now ? " (po terminie)" : ""}`}
                </span>
              </div>
              {!step.completedAt ? (
                <form action={completeOnboardingStepAction} className="mt-2 flex flex-col gap-2">
                  <input type="hidden" name="onboardingStepId" value={step.id} />
                  <input type="hidden" name="memberId" value={member.id} />
                  <Textarea
                    name="body"
                    placeholder="Notatka z rozmowy (min. 30 znaków)"
                    required
                    minLength={30}
                    className="border-line bg-surface-2"
                  />
                  <Button type="submit" size="sm" variant="outline" className="self-start">
                    Oznacz etap jako zrobiony
                  </Button>
                </form>
              ) : null}
            </li>
          ))}
          {member.onboardingSteps.length === 0 ? (
            <li className="text-muted-brand text-sm">
              Etapy onboardingu pojawią się po pierwszej płatności lub obecności klienta.
            </li>
          ) : null}
        </ul>
      </section>

      <section>
        <h2 className="text-muted-brand font-mono text-xs tracking-widest uppercase">Pomiary</h2>
        <ul className="mt-2 flex flex-col gap-1">
          {member.measurements.map((m) => (
            <li key={m.id} className="text-text flex items-center justify-between text-sm">
              <span>{m.weightKg} kg</span>
              <span className="text-muted-brand font-mono text-xs">{formatDate(m.recordedAt)}</span>
            </li>
          ))}
          {member.measurements.length === 0 ? (
            <li className="text-muted-brand text-sm">Brak zapisanych pomiarów.</li>
          ) : null}
        </ul>
        <form action={addMeasurementAction} className="mt-2 flex items-center gap-2">
          <input type="hidden" name="memberId" value={member.id} />
          <Input
            name="weightKg"
            type="number"
            step="0.1"
            min="0"
            placeholder="Waga (kg)"
            required
            className="border-line bg-surface-2 w-32"
          />
          <Button type="submit" size="sm" variant="outline">
            Zapisz pomiar
          </Button>
        </form>
      </section>

      <section>
        <h2 className="text-muted-brand font-mono text-xs tracking-widest uppercase">
          Historia obecności (ostatnie 10)
        </h2>
        <ul className="mt-2 flex flex-col gap-1">
          {member.attendances.map((a) => (
            <li key={a.id} className="text-text flex items-center justify-between text-sm">
              <span>{a.session.name}</span>
              <span className="text-muted-brand font-mono text-xs">
                {formatDate(a.checkedInAt)} · {a.method === "QR" ? "QR" : "ręcznie"}
              </span>
            </li>
          ))}
          {member.attendances.length === 0 ? (
            <li className="text-muted-brand text-sm">Brak obecności.</li>
          ) : null}
        </ul>
      </section>

      <section>
        <h2 className="text-muted-brand font-mono text-xs tracking-widest uppercase">Notatki</h2>
        <form action={addNoteAction} className="mt-2 flex flex-col gap-2">
          <input type="hidden" name="memberId" value={member.id} />
          <select
            name="kind"
            defaultValue="GENERAL"
            className="border-line bg-surface-2 text-text w-40 rounded-md border px-2 py-1 text-base md:text-sm"
          >
            <option value="GENERAL">Ogólna</option>
            <option value="CONTACT">Kontakt</option>
            <option value="ONBOARDING">Onboarding</option>
          </select>
          <Textarea
            name="body"
            placeholder="Treść notatki (min. 30 znaków)"
            required
            minLength={30}
            className="border-line bg-surface-2"
          />
          <Button type="submit" size="sm" className="self-start">
            Dodaj notatkę
          </Button>
        </form>

        <ul className="mt-4 flex flex-col gap-2">
          {member.notes.map((note) => (
            <li key={note.id} className="border-line bg-surface rounded-md border p-3">
              <p className="text-muted-brand font-mono text-xs tracking-widest uppercase">
                {note.kind} · {note.authorUser.name} · {formatDate(note.createdAt)}
              </p>
              <p className="text-text mt-1 text-sm">{note.body}</p>
            </li>
          ))}
          {member.notes.length === 0 ? (
            <li className="text-muted-brand text-sm">Brak notatek.</li>
          ) : null}
        </ul>
      </section>
    </div>
  );
}
