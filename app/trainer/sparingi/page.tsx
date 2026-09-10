import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { requireTrainerSelf } from "@/lib/auth/guard";
import { pairSparringCandidates } from "@/lib/domain/sparring";
import { Button } from "@/components/ui/button";
import { toggleSparringClearanceAction } from "./actions";

// Sparingi (SPEC.md sekcja 2): dopuszczenia, dobór par, lista bez pary - to
// zadania dla trenera, nie statystyka. Trener widzi wyłącznie własnych
// podopiecznych (SPEC.md: "Trener widzi wyłącznie swoich podopiecznych").
export default async function SparringPage() {
  const { trainer } = await requireTrainerSelf();

  const adults = await prisma.member.findMany({
    where: { ownerTrainerId: trainer.id, status: "ACTIVE", isMinor: false },
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
  });

  const cleared = adults.filter((m) => m.sparringClearedAt != null);
  const { pairs, unpaired } = pairSparringCandidates(cleared);

  return (
    <div className="flex flex-col gap-8">
      <h1 className="font-display text-brand-red text-2xl tracking-wide">Sparingi</h1>

      <section>
        <h2 className="text-muted-brand font-mono text-xs tracking-widest uppercase">
          Pary ({pairs.length})
        </h2>
        <ul className="mt-2 flex flex-col gap-2">
          {pairs.map(([a, b]) => (
            <li
              key={`${a.id}-${b.id}`}
              // Na telefonie para staje w kolumnie: dwa nazwiska z waga nie
              // miescily sie w jednym wierszu i wypychaly karte poza ekran.
              className="border-line bg-surface flex flex-col gap-1 rounded-md border p-3 sm:flex-row sm:items-center sm:justify-between sm:gap-3"
            >
              <span className="text-text min-w-0">
                {a.firstName} {a.lastName} ({a.weightKg} kg)
              </span>
              <span className="text-muted-brand shrink-0 font-mono text-xs">vs</span>
              <span className="text-text min-w-0">
                {b.firstName} {b.lastName} ({b.weightKg} kg)
              </span>
            </li>
          ))}
          {pairs.length === 0 ? (
            <li className="text-muted-brand text-sm">Brak par - za mało dopuszczonych osób.</li>
          ) : null}
        </ul>
      </section>

      {unpaired.length > 0 ? (
        <section>
          <h2 className="text-muted-brand font-mono text-xs tracking-widest uppercase">
            Bez pary ({unpaired.length}) - zadanie dla trenera
          </h2>
          <ul className="mt-2 flex flex-col gap-2">
            {unpaired.map((m) => (
              <li key={m.id} className="border-red/30 bg-red/5 rounded-md border p-3">
                <Link
                  href={`/trainer/podopieczni/${m.id}`}
                  className="text-text hover:text-brand-red font-medium"
                >
                  {m.firstName} {m.lastName}
                </Link>
                <span className="text-muted-brand ml-2 font-mono text-xs">
                  {m.weightKg != null ? `${m.weightKg} kg · ${m.level}` : "brak wpisanej wagi"}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section>
        <h2 className="text-muted-brand font-mono text-xs tracking-widest uppercase">
          Dopuszczenia ({adults.length} dorosłych podopiecznych)
        </h2>
        <ul className="mt-2 flex flex-col gap-2">
          {adults.map((m) => (
            <li
              key={m.id}
              className="border-line bg-surface flex items-center justify-between rounded-md border p-3"
            >
              <div>
                <p className="text-text font-medium">
                  {m.firstName} {m.lastName}
                </p>
                <p className="text-muted-brand font-mono text-xs">
                  {m.weightKg != null ? `${m.weightKg} kg` : "brak wagi"} · {m.level}
                </p>
              </div>
              <form action={toggleSparringClearanceAction}>
                <input type="hidden" name="memberId" value={m.id} />
                <Button
                  type="submit"
                  size="sm"
                  variant={m.sparringClearedAt ? "outline" : "default"}
                >
                  {m.sparringClearedAt ? "Cofnij dopuszczenie" : "Dopuść do sparingu"}
                </Button>
              </form>
            </li>
          ))}
          {adults.length === 0 ? (
            <li className="text-muted-brand text-sm">Brak dorosłych podopiecznych.</li>
          ) : null}
        </ul>
      </section>
    </div>
  );
}
