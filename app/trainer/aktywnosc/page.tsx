import { prisma } from "@/lib/prisma";
import { requireTrainerSelf } from "@/lib/auth/guard";
import { formatDate } from "@/lib/format";
import { Button } from "@/components/ui/button";

const ACTION_LABEL: Record<string, string> = {
  MEMBER_CREATED: "Dodano klienta",
  MEMBER_UPDATED: "Zaktualizowano dane klienta",
  PASS_SOLD: "Sprzedano karnet",
  PASS_FROZEN: "Zamrożono karnet",
  PASS_UNFROZEN: "Odmrożono karnet",
  PAYMENT_CORRECTED: "Korekta płatności",
  NOTE_ADDED: "Dodano notatkę",
  ONBOARDING_STEP_COMPLETED: "Zamknięto etap onboardingu",
  RETENTION_TASK_CLOSED: "Zamknięto zadanie retencyjne",
  TRAINER_CHECKIN_MISMATCH: "Odbicie trenera bez przypisania",
  DEMO_DATA_LOADED: "Wgrano dane demonstracyjne",
  DEMO_DATA_REMOVED: "Usunięto dane demonstracyjne",
};

type SearchParams = { sort?: string };

// Trener widzi wyłącznie swoją własną historię - w odróżnieniu od
// /admin/aktywnosc, tu nie ma filtra po innej osobie (lib/auth/guard.ts:
// requireTrainerSelf, bez wyjątku dla ADMIN).
export default async function TrainerActivityPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const { sort } = await searchParams;
  const sortDir = sort === "asc" ? "asc" : "desc";
  const { session } = await requireTrainerSelf();

  const logs = await prisma.activityLog.findMany({
    where: { actorUserId: session.user.id },
    include: { member: true },
    orderBy: { createdAt: sortDir },
    take: 200,
  });

  return (
    <div className="flex flex-col gap-4">
      <h1 className="font-display text-brand-red text-2xl tracking-wide">
        Moja aktywność ({logs.length})
      </h1>

      <form className="flex flex-wrap items-center gap-2">
        <select
          name="sort"
          defaultValue={sortDir}
          className="border-line bg-surface-2 text-text rounded-md border px-2 py-1 text-sm"
        >
          <option value="desc">Najnowsze pierwsze</option>
          <option value="asc">Najstarsze pierwsze</option>
        </select>
        <Button type="submit" variant="outline" size="sm">
          Sortuj
        </Button>
      </form>

      <ul className="flex flex-col gap-2">
        {logs.map((log) => (
          <li key={log.id} className="border-line bg-surface rounded-md border p-3">
            <div className="flex items-center justify-between">
              <span className="text-brand-red font-medium">
                {ACTION_LABEL[log.action] ?? log.action}
              </span>
              <span className="text-muted-brand font-mono text-xs">
                {formatDate(log.createdAt)}
              </span>
            </div>
            <p className="text-text mt-1 text-sm">{log.summary}</p>
          </li>
        ))}
        {logs.length === 0 ? <li className="text-muted-brand text-sm">Brak aktywności.</li> : null}
      </ul>
    </div>
  );
}
