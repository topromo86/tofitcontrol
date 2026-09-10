import Link from "next/link";
import { Info } from "lucide-react";
import { prisma } from "@/lib/prisma";
import { formatDate } from "@/lib/format";
import { todayInTimeZone } from "@/lib/domain/time";
import { CHURN_THRESHOLD_DAYS, TASK_ESCALATION_THRESHOLD_DAYS } from "@/lib/domain/retention";

const TASK_LABEL: Record<string, string> = {
  INACTIVE_7: "Brak treningu od 7 dni",
  INACTIVE_14: "Brak treningu od 14 dni",
  RENEWAL: "Kończy się karnet",
};

function formatPercent(ratio: number): string {
  return new Intl.NumberFormat("pl-PL", { style: "percent", maximumFractionDigits: 0 }).format(
    ratio,
  );
}

function cohortKey(date: Date): string {
  const d = todayInTimeZone(date);
  return `${d.year}-${String(d.month).padStart(2, "0")}`;
}

export default async function RetencjaPage() {
  const now = new Date();
  const ninetyDaysAgo = new Date(now.getTime() - 90 * 86_400_000);

  const [totalActive, maturedMembers, atRiskMemberIds, escalations, joinedMembers] =
    await Promise.all([
      prisma.member.count({ where: { status: "ACTIVE", joinedAt: { not: null } } }),
      prisma.member.findMany({
        where: { joinedAt: { lte: ninetyDaysAgo } },
        select: { status: true },
      }),
      prisma.retentionTask.findMany({
        where: { closedAt: null },
        select: { memberId: true },
        distinct: ["memberId"],
      }),
      prisma.retentionTask.findMany({
        where: { closedAt: null, escalatedAt: { not: null } },
        include: { member: true, trainer: { include: { user: true } } },
        orderBy: { escalatedAt: "asc" },
      }),
      prisma.member.findMany({
        where: { joinedAt: { not: null } },
        select: { joinedAt: true, status: true },
      }),
    ]);

  const ret90 =
    maturedMembers.length > 0
      ? maturedMembers.filter((m) => m.status !== "CHURNED").length / maturedMembers.length
      : null;

  const cohorts = new Map<string, { total: number; churned: number; matured: boolean }>();
  for (const m of joinedMembers) {
    const key = cohortKey(m.joinedAt!);
    const entry = cohorts.get(key) ?? {
      total: 0,
      churned: 0,
      matured: m.joinedAt! <= ninetyDaysAgo,
    };
    entry.total += 1;
    if (m.status === "CHURNED") entry.churned += 1;
    cohorts.set(key, entry);
  }
  const cohortRows = [...cohorts.entries()].sort((a, b) => b[0].localeCompare(a[0]));

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="font-display text-brand-red text-2xl tracking-wide">Retencja</h1>
        <p className="text-muted-brand mt-1 text-sm">
          Ilu klientów zostaje w klubie, a nie tylko ilu do niego trafia. Liczby liczone na dziś, na
          żywo.
        </p>
      </div>

      {/* Na telefonie dwie kolumny zamiast trzech w rzedzie - przy 343 px
          etykiety nie mialy sie gdzie zmiescic. */}
      <section className="grid grid-cols-2 gap-4 sm:flex sm:gap-8">
        <div>
          <h2 className="text-muted-brand font-mono text-xs tracking-widest uppercase">Aktywni</h2>
          <p className="font-display text-3xl">{totalActive}</p>
        </div>
        <div>
          <h2 className="text-muted-brand font-mono text-xs tracking-widest uppercase">
            Retencja 90 dni (dojrzała kohorta, {maturedMembers.length})
          </h2>
          <p className="font-display text-3xl">
            {ret90 == null ? "za mało danych" : formatPercent(ret90)}
          </p>
        </div>
        <div>
          <h2 className="text-muted-brand font-mono text-xs tracking-widest uppercase">
            Zagrożeni
          </h2>
          <p className="font-display text-red text-3xl">{atRiskMemberIds.length}</p>
        </div>
      </section>

      <section>
        <h2 className="text-muted-brand font-mono text-xs tracking-widest uppercase">
          Eskalacje ({escalations.length})
        </h2>
        <ul className="mt-2 flex flex-col gap-2">
          {escalations.map((task) => (
            <li
              key={task.id}
              className="border-red/40 bg-red/5 flex items-center justify-between rounded-md border p-3"
            >
              <div>
                <p className="text-text font-medium">
                  {task.member.firstName} {task.member.lastName}
                </p>
                <p className="text-muted-brand font-mono text-xs">
                  {TASK_LABEL[task.type] ?? task.type} · opiekun: {task.trainer.user.name} ·
                  eskalowano {formatDate(task.escalatedAt!)}
                </p>
              </div>
            </li>
          ))}
          {escalations.length === 0 ? (
            <li className="text-muted-brand text-sm">Brak eskalacji.</li>
          ) : null}
        </ul>
      </section>

      <section>
        <h2 className="text-muted-brand font-mono text-xs tracking-widest uppercase">
          Tabela kohortowa (wg miesiąca dołączenia)
        </h2>
        <div className="overflow-x-auto">
          <table className="mt-2 w-full text-sm">
            <thead>
              <tr className="text-muted-brand border-line border-b text-left font-mono text-xs uppercase">
                <th className="py-2">Miesiąc</th>
                <th className="py-2">Klientów</th>
                <th className="py-2">Odeszło</th>
                <th className="py-2">Retencja</th>
              </tr>
            </thead>
            <tbody>
              {cohortRows.map(([key, row]) => (
                <tr key={key} className="border-line-soft border-b">
                  <td className="py-2">{key}</td>
                  <td className="py-2">{row.total}</td>
                  <td className="py-2">{row.churned}</td>
                  <td className="py-2">
                    {formatPercent((row.total - row.churned) / row.total)}
                    {!row.matured ? (
                      <span className="text-muted-brand ml-1 text-xs">(świeża kohorta)</span>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <details className="border-line bg-surface rounded-md border">
        <summary className="text-text flex cursor-pointer list-none items-center gap-2 p-4 font-mono text-xs tracking-widest uppercase [&::-webkit-details-marker]:hidden">
          <Info className="text-brand-red size-4" />
          Wyjaśnienie statystyk
        </summary>
        <div className="border-line text-muted-brand flex max-w-[72ch] flex-col gap-5 border-t p-4 text-sm">
          <div>
            <p className="text-text mb-1 font-mono text-xs tracking-widest uppercase">
              Po co jest ten ekran
            </p>
            <p>
              Pokazuje, ilu klientów <b>zostaje</b> w klubie, a nie tylko ilu się zapisało. Nowi
              klienci nie mają znaczenia, jeśli odchodzą po miesiącu - tutaj to widać. Wszystkie
              liczby są wyliczane na bieżąco, w chwili otwarcia strony.
            </p>
          </div>

          <div>
            <p className="text-text mb-1 font-mono text-xs tracking-widest uppercase">Aktywni</p>
            <p>
              Liczba klientów ze statusem aktywnym, którzy mają już datę dołączenia (czyli pierwszą
              płatność albo pierwszą obecność). Surowy rozmiar bazy - sam w sobie nie mówi nic o
              jakości, patrz na niego razem z retencją poniżej.
            </p>
          </div>

          <div>
            <p className="text-text mb-1 font-mono text-xs tracking-widest uppercase">
              Retencja 90 dni · wyżej = lepiej
            </p>
            <p>
              Odsetek klientów, którzy dołączyli <b>co najmniej 90 dni temu</b> i do dziś nie
              zostali oznaczeni jako odeszli. Liczba w nawiasie to wielkość tej grupy („dojrzała
              kohorta”) - im większa, tym pewniejszy wynik. Nie ma jednej „dobrej” wartości;
              najbardziej użyteczny jest <b>trend miesiąc do miesiąca</b>, nie pojedynczy odczyt.
            </p>
            <p className="mt-2">
              Status „odszedł” nadaje system automatycznie po {CHURN_THRESHOLD_DAYS} dniach bez
              treningu - i liczy do tego <b>wyłącznie obecności zeskanowane kodem QR</b> na sali.
              Ręczne odznaczenie obecności przez trenera tego licznika nie zeruje. To celowe: nikt
              nie powinien móc podbić własnego wyniku wpisami z palca.
            </p>
          </div>

          <div>
            <p className="text-text mb-1 font-mono text-xs tracking-widest uppercase">
              Zagrożeni · niżej = lepiej
            </p>
            <p>
              Ilu klientów ma <b>w tej chwili</b> otwarte przynajmniej jedno zadanie retencyjne u
              trenera (brak treningu od 7 lub 14 dni, albo kończący się karnet). To nie statystyka
              historyczna, tylko lista „do zrobienia dziś” - zmienia się codziennie.
            </p>
          </div>

          <div>
            <p className="text-text mb-1 font-mono text-xs tracking-widest uppercase">
              Eskalacje · 0 = stan pożądany
            </p>
            <p>
              <b>
                „Eskalowano” znaczy: zadanie przeleżało u trenera ponad{" "}
                {TASK_ESCALATION_THRESHOLD_DAYS} dni bez zamknięcia i system sam oznaczył je jako
                zaniedbane.
              </b>{" "}
              Data przy wpisie to dzień, w którym to nastąpiło. Zadanie zamyka się wyłącznie notatką
              z kontaktu (min. 30 znaków) - samo kliknięcie „zrobione” nie istnieje, więc każda
              pozycja tutaj oznacza klienta, do którego przez ponad tydzień nikt się nie odezwał.
            </p>
            <p className="mt-2">
              Pusta lista jest dobra. Rosnąca lista to sygnał, że trener ma za dużo zadań albo je
              ignoruje - jedno i drugie warto sprawdzić w rozmowie, nie tylko w tabelce.
            </p>
          </div>

          <div>
            <p className="text-text mb-1 font-mono text-xs tracking-widest uppercase">
              Tabela kohortowa · wyżej = lepiej
            </p>
            <p>
              To samo pytanie co „Retencja 90 dni”, tylko rozbite na miesiące dołączenia. Pozwala
              zobaczyć, czy klienci z konkretnego miesiąca (np. po promocji albo po zmianie grafiku)
              zostają dłużej niż z innych. Wiersz oznaczony jako <b>(świeża kohorta)</b> ma jeszcze
              mniej niż 90 dni - jego wynik się zmieni, nie wyciągaj z niego wniosków.
            </p>
          </div>

          <div>
            <p className="text-text mb-1 font-mono text-xs tracking-widest uppercase">
              Uwaga na ekran „Ranking trenerów”
            </p>
            <p>
              Tam też jest kolumna „Retencja”, ale to <b>inna liczba</b> - względna, podzielona
              przez średnią klubową w segmencie danego trenera. Nie porównuj jej wprost z procentem
              z tego ekranu.{" "}
              <Link href="/admin/ranking" className="text-brand-red underline">
                Przejdź do Rankingu
              </Link>
            </p>
          </div>
        </div>
      </details>
    </div>
  );
}
