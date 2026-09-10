import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { requireTrainerSelf } from "@/lib/auth/guard";
import { formatDate } from "@/lib/format";

export default async function PodopieczniPage() {
  const { trainer } = await requireTrainerSelf();

  const members = await prisma.member.findMany({
    where: { ownerTrainerId: trainer.id },
    include: {
      attendances: { orderBy: { checkedInAt: "desc" }, take: 1 },
      onboardingSteps: true,
    },
    orderBy: [{ status: "asc" }, { lastName: "asc" }],
  });

  return (
    <div className="flex flex-col gap-4">
      <h1 className="font-display text-brand-red text-2xl tracking-wide">
        Podopieczni ({members.length})
      </h1>
      <ul className="flex flex-col gap-2">
        {members.map((m) => {
          const lastAttendance = m.attendances[0]?.checkedInAt;
          const completedSteps = m.onboardingSteps.filter((s) => s.completedAt).length;
          const totalSteps = m.onboardingSteps.length;
          return (
            <li key={m.id}>
              <Link
                href={`/trainer/podopieczni/${m.id}`}
                className="border-line bg-surface hover:border-brand-red flex items-center justify-between gap-3 rounded-md border p-3"
              >
                <div className="min-w-0">
                  <p className="text-text font-medium">
                    {m.firstName} {m.lastName}
                    {m.isMinor ? " (dziecko)" : ""}
                  </p>
                  <p className="text-muted-brand font-mono text-xs">
                    Status {m.status} ·{" "}
                    {m.goal ? m.goal : <span className="text-red">brak celu</span>}
                  </p>
                </div>
                <div className="text-muted-brand shrink-0 text-right font-mono text-xs">
                  <p>
                    {lastAttendance ? `Ostatnio: ${formatDate(lastAttendance)}` : "Brak obecności"}
                  </p>
                  <p>Onboarding: {totalSteps > 0 ? `${completedSteps}/${totalSteps}` : "-"}</p>
                </div>
              </Link>
            </li>
          );
        })}
        {members.length === 0 ? (
          <li className="text-muted-brand text-sm">Brak podopiecznych.</li>
        ) : null}
      </ul>
    </div>
  );
}
