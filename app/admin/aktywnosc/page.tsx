import { prisma } from "@/lib/prisma";
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
};

type SearchParams = { actorId?: string; sort?: string };

export default async function AdminActivityPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const { actorId, sort } = await searchParams;
  const sortDir = sort === "asc" ? "asc" : "desc";

  const staff = await prisma.user.findMany({
    where: { role: { in: ["ADMIN", "TRAINER"] } },
    orderBy: [{ role: "asc" }, { name: "asc" }],
  });

  const logs = await prisma.activityLog.findMany({
    where: actorId ? { actorUserId: actorId } : {},
    include: { actorUser: true, member: true },
    orderBy: { createdAt: sortDir },
    take: 200,
  });

  return (
    <div className="flex flex-col gap-4">
      <h1 className="font-display text-brand-red text-2xl tracking-wide">
        Aktywność ({logs.length})
      </h1>
      <p className="text-muted-brand text-sm">
        Wszystkie zmiany - Twoje i wszystkich trenerów. Przefiltruj po konkretnej osobie, żeby
        zobaczyć wyłącznie jej aktywność.
      </p>

      <form className="flex flex-wrap items-center gap-2">
        <select
          name="actorId"
          defaultValue={actorId ?? ""}
          className="border-line bg-surface-2 text-text rounded-md border px-2 py-1 text-sm"
        >
          <option value="">Wszyscy</option>
          {staff.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name} ({u.role === "ADMIN" ? "admin" : "trener"})
            </option>
          ))}
        </select>
        <select
          name="sort"
          defaultValue={sortDir}
          className="border-line bg-surface-2 text-text rounded-md border px-2 py-1 text-sm"
        >
          <option value="desc">Najnowsze pierwsze</option>
          <option value="asc">Najstarsze pierwsze</option>
        </select>
        <Button type="submit" variant="outline" size="sm">
          Filtruj
        </Button>
      </form>

      <ul className="flex flex-col gap-2">
        {logs.map((log) => (
          <li key={log.id} className="border-line bg-surface rounded-md border p-3">
            <div className="flex items-center justify-between">
              <span className="text-text font-medium">
                {log.actorUser.name}{" "}
                <span className="text-muted-brand font-mono text-xs uppercase">
                  ({log.actorUser.role === "ADMIN" ? "admin" : "trener"})
                </span>
              </span>
              <span className="text-muted-brand font-mono text-xs">
                {formatDate(log.createdAt)}
              </span>
            </div>
            <p className="text-text mt-1 text-sm">
              <span className="text-brand-red font-medium">
                {ACTION_LABEL[log.action] ?? log.action}
              </span>{" "}
              {log.summary}
            </p>
          </li>
        ))}
        {logs.length === 0 ? <li className="text-muted-brand text-sm">Brak aktywności.</li> : null}
      </ul>
    </div>
  );
}
