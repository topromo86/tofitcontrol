import { prisma } from "@/lib/prisma";
import { formatDate } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { answerChurnSurveyAction } from "./actions";

// "Powody odejść" (SPEC.md sekcja 3, ekran właściciela): ankieta wyjścia,
// podział "trener" / "klub". Wysyłka mailem nie istnieje (brak dostawcy
// poczty) - admin/trener wpisuje odpowiedź ręcznie po rozmowie z klientem.
export default async function ChurnReasonsPage() {
  const [pending, answered, reasons] = await Promise.all([
    prisma.churnSurvey.findMany({
      where: { answeredAt: null },
      include: { member: true },
      orderBy: { sentAt: "desc" },
    }),
    prisma.churnSurvey.findMany({
      where: { answeredAt: { not: null } },
      include: { member: true, reason: true },
      orderBy: { answeredAt: "desc" },
    }),
    prisma.churnReason.findMany({ orderBy: { label: "asc" } }),
  ]);

  const trainerControllable = answered.filter((s) => s.reason?.trainerControllable);
  const clubLevel = answered.filter((s) => s.reason && !s.reason.trainerControllable);
  const noReason = answered.filter((s) => !s.reason);

  return (
    <div className="flex flex-col gap-8">
      <h1 className="font-display text-brand-red text-2xl tracking-wide">Powody odejść</h1>

      <section>
        <h2 className="text-muted-brand font-mono text-xs tracking-widest uppercase">
          Do wypełnienia ({pending.length})
        </h2>
        <ul className="mt-2 flex flex-col gap-3">
          {pending.map((survey) => (
            <li key={survey.id} className="border-line bg-surface rounded-md border p-3">
              <p className="text-text font-medium">
                {survey.member.firstName} {survey.member.lastName}
              </p>
              <p className="text-muted-brand font-mono text-xs">
                Ankieta wysłana {formatDate(survey.sentAt)}
              </p>
              <form action={answerChurnSurveyAction} className="mt-2 flex flex-col gap-2">
                <input type="hidden" name="churnSurveyId" value={survey.id} />
                <select
                  name="reasonId"
                  className="border-line bg-surface-2 text-text rounded-md border px-2 py-1 text-base md:text-sm"
                >
                  <option value="">Bez podanego powodu</option>
                  {reasons.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.label} {r.trainerControllable ? "(trener)" : "(klub)"}
                    </option>
                  ))}
                </select>
                <Textarea
                  name="comment"
                  placeholder="Komentarz (opcjonalnie)"
                  className="border-line bg-surface-2"
                />
                <Button type="submit" size="sm" className="self-start">
                  Zapisz odpowiedź
                </Button>
              </form>
            </li>
          ))}
          {pending.length === 0 ? (
            <li className="text-muted-brand text-sm">Brak oczekujących ankiet.</li>
          ) : null}
        </ul>
      </section>

      <section>
        <h2 className="text-muted-brand font-mono text-xs tracking-widest uppercase">
          Powody zależne od trenera ({trainerControllable.length})
        </h2>
        <ul className="mt-2 flex flex-col gap-2">
          {trainerControllable.map((s) => (
            <li key={s.id} className="border-red/30 bg-red/5 rounded-md border p-3">
              <p className="text-text font-medium">
                {s.member.firstName} {s.member.lastName}{" "}
                <span className="text-muted-brand font-mono text-xs">- {s.reason?.label}</span>
              </p>
              {s.comment ? <p className="text-text mt-1 text-sm">{s.comment}</p> : null}
            </li>
          ))}
          {trainerControllable.length === 0 ? (
            <li className="text-muted-brand text-sm">Brak.</li>
          ) : null}
        </ul>
      </section>

      <section>
        <h2 className="text-muted-brand font-mono text-xs tracking-widest uppercase">
          Powody na poziomie klubu ({clubLevel.length})
        </h2>
        <ul className="mt-2 flex flex-col gap-2">
          {clubLevel.map((s) => (
            <li key={s.id} className="border-line bg-surface rounded-md border p-3">
              <p className="text-text font-medium">
                {s.member.firstName} {s.member.lastName}{" "}
                <span className="text-muted-brand font-mono text-xs">- {s.reason?.label}</span>
              </p>
              {s.comment ? <p className="text-text mt-1 text-sm">{s.comment}</p> : null}
            </li>
          ))}
          {clubLevel.length === 0 ? <li className="text-muted-brand text-sm">Brak.</li> : null}
        </ul>
      </section>

      {noReason.length > 0 ? (
        <section>
          <h2 className="text-muted-brand font-mono text-xs tracking-widest uppercase">
            Bez podanego powodu ({noReason.length})
          </h2>
          <ul className="mt-2 flex flex-col gap-2">
            {noReason.map((s) => (
              <li key={s.id} className="border-line bg-surface rounded-md border p-3">
                <p className="text-text font-medium">
                  {s.member.firstName} {s.member.lastName}
                </p>
                {s.comment ? <p className="text-text mt-1 text-sm">{s.comment}</p> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
