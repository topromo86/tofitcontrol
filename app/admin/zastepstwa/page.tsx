import { Info } from "lucide-react";
import { prisma } from "@/lib/prisma";
import { requireRole } from "@/lib/auth/guard";
import { SUBSTITUTE_STATUS_LABEL } from "@/lib/domain/substitute";
import { formatDayTime } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { PROSE_WIDTH } from "../../shell";
import { adminAssignSubstituteAction } from "./actions";

const selectClass =
  "border-line bg-surface-2 text-text rounded-md border px-2 py-1 text-base md:text-sm";

export default async function AdminSubstitutesPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  await requireRole("ADMIN");
  const { error } = await searchParams;

  const now = new Date();

  const sessionInclude = {
    location: true,
    trainer: { include: { user: true } },
    substituteTrainer: { include: { user: true } },
  };

  // Zapytania sekwencyjnie, nie przez Promise.all: lokalna baza `prisma dev`
  // zrywa połączenia przy kilku równoległych zapytaniach z relacjami
  // (P1017 ConnectionClosed). Ten ekran nie jest gorącą ścieżką, więc
  // szeregowanie nic nie kosztuje.
  //
  // Wszystkie zastępstwa jednym zapytaniem - i tak dzielimy je po statusie
  // w pamięci, więc trzy osobne były zbędne.
  const withSubstitute = await prisma.session.findMany({
    where: {
      substituteStatus: { not: null },
      startsAt: { gte: now },
      status: "SCHEDULED",
    },
    include: sessionInclude,
    orderBy: { startsAt: "asc" },
  });

  const upcoming = await prisma.session.findMany({
    where: { startsAt: { gte: now }, status: "SCHEDULED", kind: "GROUP" },
    include: sessionInclude,
    orderBy: { startsAt: "asc" },
    take: 60,
  });

  const trainers = await prisma.trainer.findMany({
    where: { active: true },
    include: { user: true },
  });

  const pending = withSubstitute.filter((s) => s.substituteStatus === "PENDING");
  const declined = withSubstitute.filter((s) => s.substituteStatus === "DECLINED");
  const accepted = withSubstitute.filter((s) => s.substituteStatus === "ACCEPTED");

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-brand-red font-[family-name:var(--font-anton)] text-2xl uppercase">
          Zastępstwa
        </h1>
        <p className="text-muted-brand mt-1 text-sm">Kto kogo zastępuje i czy to potwierdził.</p>
      </div>

      {error ? (
        <p className="border-red bg-surface text-text rounded-md border p-3 text-sm">{error}</p>
      ) : null}

      <details className="border-line bg-surface rounded-md border p-3">
        <summary className="text-muted-brand hover:text-text cursor-pointer font-mono text-xs tracking-widest uppercase">
          <Info className="mr-1 inline size-3" />
          Jak to działa
        </summary>
        <div className={`${PROSE_WIDTH} text-muted-brand mt-3 flex flex-col gap-2 text-sm`}>
          <p>
            <b className="text-text">Zastępstwo obowiązuje dopiero po potwierdzeniu.</b> Dopóki
            czeka, zajęcia prowadzi trener pierwotny - dzięki temu niepotwierdzone zastępstwo nigdy
            nie zostawia zajęć bez nikogo odpowiedzialnego.
          </p>
          <p>
            Wynagrodzenie i ocena też idą za tym, kto realnie prowadził. Zastępca dostaje je
            wyłącznie za zajęcia, które potwierdził.
          </p>
          <p>
            <b className="text-text">Trener prosi, właściciel poleca.</b> Prośbę od kolegi zastępca
            może odrzucić. Zastępstwa wyznaczonego przez Ciebie nie odrzuci - może je tylko przyjąć
            do wiadomości, ale nadal musi to kliknąć, żeby było wiadomo, że wie.
          </p>
          <p>
            <b className="text-text">Odrzucone wymaga Twojej reakcji</b> - zajęcia wróciły do
            trenera pierwotnego, który już zgłaszał, że nie może.
          </p>
        </div>
      </details>

      <section>
        <h2 className="text-amber font-mono text-xs tracking-widest uppercase">
          Czeka na potwierdzenie ({pending.length})
        </h2>
        {pending.length === 0 ? (
          <p className="text-muted-brand mt-2 text-sm">Nic nie czeka.</p>
        ) : (
          <ul className="mt-2 flex flex-col gap-2">
            {pending.map((s) => (
              <li key={s.id} className="border-amber bg-surface rounded-md border p-3">
                <p className="text-text font-medium">{s.name}</p>
                <p className="text-muted-brand mt-0.5 font-mono text-xs">
                  {formatDayTime(s.startsAt)} · {s.location.name}
                </p>
                <p className="text-text mt-1 text-sm">
                  <b>{s.substituteTrainer?.user.name}</b> ma zastąpić <b>{s.trainer.user.name}</b>
                  {s.substituteByAdmin ? " (wyznaczone przez Ciebie)" : " (prośba trenera)"}
                </p>
                <p className="text-amber mt-1 font-mono text-xs tracking-widest uppercase">
                  Prowadzi na razie {s.trainer.user.name}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      {declined.length > 0 ? (
        <section>
          <h2 className="text-red font-mono text-xs tracking-widest uppercase">
            Odrzucone - wymaga reakcji ({declined.length})
          </h2>
          <ul className="mt-2 flex flex-col gap-2">
            {declined.map((s) => (
              <li key={s.id} className="border-red bg-surface rounded-md border p-3">
                <p className="text-text font-medium">{s.name}</p>
                <p className="text-muted-brand mt-0.5 font-mono text-xs">
                  {formatDayTime(s.startsAt)} · {s.location.name}
                </p>
                <p className="text-text mt-1 text-sm">
                  <b>{s.substituteTrainer?.user.name}</b> odmówił(a)
                  {s.substituteDeclineReason ? `: ${s.substituteDeclineReason}.` : "."} Zajęcia
                  wróciły do <b>{s.trainer.user.name}</b>.
                </p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section>
        <h2 className="text-jade font-mono text-xs tracking-widest uppercase">
          Potwierdzone ({accepted.length})
        </h2>
        {accepted.length === 0 ? (
          <p className="text-muted-brand mt-2 text-sm">Brak potwierdzonych zastępstw.</p>
        ) : (
          <ul className="mt-2 flex flex-col gap-2">
            {accepted.map((s) => (
              <li key={s.id} className="border-line bg-surface rounded-md border p-3">
                <p className="text-text font-medium">{s.name}</p>
                <p className="text-muted-brand mt-0.5 font-mono text-xs">
                  {formatDayTime(s.startsAt)} · {s.location.name}
                </p>
                <p className="text-text mt-1 text-sm">
                  Prowadzi <b className="text-jade">{s.substituteTrainer?.user.name}</b> zamiast{" "}
                  {s.trainer.user.name}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="text-muted-brand font-mono text-xs tracking-widest uppercase">
          Przydziel zastępstwo
        </h2>
        <p className="text-muted-brand mt-1 text-sm">
          Zastępca dostanie powiadomienie i musi przyjąć je do wiadomości.
        </p>
        <ul className="mt-2 flex flex-col gap-2">
          {upcoming.map((s) => (
            <li
              key={s.id}
              className="border-line bg-surface flex flex-wrap items-center justify-between gap-3 rounded-md border p-3"
            >
              <div className="min-w-0">
                <p className="text-text text-sm font-medium">{s.name}</p>
                <p className="text-muted-brand mt-0.5 font-mono text-xs">
                  {formatDayTime(s.startsAt)} · {s.location.name} · {s.trainer.user.name}
                  {s.substituteStatus
                    ? ` · ${SUBSTITUTE_STATUS_LABEL[s.substituteStatus]}: ${s.substituteTrainer?.user.name}`
                    : ""}
                </p>
              </div>

              <form action={adminAssignSubstituteAction} className="flex items-center gap-2">
                <input type="hidden" name="sessionId" value={s.id} />
                <select
                  name="substituteTrainerId"
                  defaultValue={s.substituteTrainerId ?? ""}
                  className={selectClass}
                >
                  <option value="">Bez zastępstwa</option>
                  {trainers
                    .filter((t) => t.id !== s.trainerId)
                    .map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.user.name}
                      </option>
                    ))}
                </select>
                <Button type="submit" variant="outline" size="sm">
                  Zapisz
                </Button>
              </form>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
