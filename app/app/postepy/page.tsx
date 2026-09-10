import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { getAccessibleMembers } from "@/lib/auth/guard";
import { computeWeeklyStreak, weeklyAttendanceCounts } from "@/lib/domain/progress";
import { MEMBER_LEVEL_LABEL } from "@/lib/domain/member-level";
import { todayInTimeZone } from "@/lib/domain/time";
import { formatDate } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { LevelLegend } from "../../level-legend";

const WEEKS_BACK = 12;
const MAX_BAR_HEIGHT_PX = 64;

function formatWeekLabel(month: number, day: number): string {
  return `${String(day).padStart(2, "0")}.${String(month).padStart(2, "0")}`;
}

// "Postępy" (SPEC.md sekcja 3): pomiary, testy na poziom, wykres frekwencji,
// seria. Poziom i pomiary aktualizuje trener (karta klienta) - tu wyłącznie
// podgląd. Historia zmian poziomu nie jest osobno logowana (tylko stan
// bieżący `Member.level`) - to świadome uproszczenie, patrz PLAN.md Faza 6.
export default async function ProgressPage({
  searchParams,
}: {
  searchParams: Promise<{ member?: string }>;
}) {
  const params = await searchParams;
  const members = await getAccessibleMembers();
  if (members.length === 0) return null;

  const activeMember = members.find((m) => m.id === params.member) ?? members[0];
  const now = new Date();
  const today = todayInTimeZone(now);

  const [attendances, measurements] = await Promise.all([
    prisma.attendance.findMany({
      where: { memberId: activeMember.id },
      select: { checkedInAt: true },
    }),
    prisma.measurement.findMany({
      where: { memberId: activeMember.id },
      orderBy: { recordedAt: "desc" },
      take: 10,
    }),
  ]);

  const attendanceDates = attendances.map((a) => todayInTimeZone(a.checkedInAt));
  const buckets = weeklyAttendanceCounts(attendanceDates, today, WEEKS_BACK);
  const streak = computeWeeklyStreak(attendanceDates, today);
  const maxCount = Math.max(1, ...buckets.map((b) => b.count));

  return (
    <div className="flex flex-col gap-8">
      {members.length > 1 ? (
        <div className="flex gap-2">
          {members.map((m) => (
            <Link key={m.id} href={`/app/postepy?member=${m.id}`}>
              <Button
                type="button"
                variant={m.id === activeMember.id ? "default" : "outline"}
                size="sm"
              >
                {m.firstName}
              </Button>
            </Link>
          ))}
        </div>
      ) : null}

      <h1 className="font-display text-brand-red text-2xl tracking-wide">Postępy</h1>

      <section className="flex gap-4">
        <div className="border-line bg-surface flex-1 rounded-md border p-4 text-center">
          <p className="text-muted-brand font-mono text-xs tracking-widest uppercase">Poziom</p>
          <p className="text-brand-red font-display mt-1 text-2xl">
            {MEMBER_LEVEL_LABEL[activeMember.level] ?? activeMember.level}
          </p>
        </div>
        <div className="border-line bg-surface flex-1 rounded-md border p-4 text-center">
          <p className="text-muted-brand font-mono text-xs tracking-widest uppercase">Seria</p>
          <p className="text-brand-red font-display mt-1 text-2xl">
            {streak} {streak === 1 ? "tydzień" : "tygodni"}
          </p>
        </div>
      </section>

      <section>
        <h2 className="text-muted-brand font-mono text-xs tracking-widest uppercase">
          Poziomy w klubie
        </h2>
        <div className="mt-2">
          <LevelLegend current={activeMember.level} />
        </div>
      </section>

      <section>
        <h2 className="text-muted-brand font-mono text-xs tracking-widest uppercase">
          Frekwencja (ostatnie {WEEKS_BACK} tygodni)
        </h2>
        <div className="border-line bg-surface mt-2 flex items-end gap-1 overflow-x-auto rounded-md border p-4">
          {buckets.map((b) => (
            <div
              key={`${b.weekStart.year}-${b.weekStart.month}-${b.weekStart.day}`}
              className="flex flex-1 flex-col items-center gap-1"
              title={`${formatWeekLabel(b.weekStart.month, b.weekStart.day)}: ${b.count}`}
            >
              <div
                className="bg-brand-red w-full rounded-sm"
                style={{
                  height: `${Math.max(2, (b.count / maxCount) * MAX_BAR_HEIGHT_PX)}px`,
                }}
              />
              <span className="text-muted-brand font-mono text-[10px]">
                {formatWeekLabel(b.weekStart.month, b.weekStart.day)}
              </span>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h2 className="text-muted-brand font-mono text-xs tracking-widest uppercase">
          Pomiary wagi
        </h2>
        <ul className="mt-2 flex flex-col gap-2">
          {measurements.map((m) => (
            <li
              key={m.id}
              className="border-line bg-surface flex items-center justify-between rounded-md border p-3"
            >
              <span className="text-text font-medium">{m.weightKg} kg</span>
              <span className="text-muted-brand font-mono text-xs">{formatDate(m.recordedAt)}</span>
            </li>
          ))}
          {measurements.length === 0 ? (
            <li className="text-muted-brand text-sm">
              Brak jeszcze zapisanych pomiarów - trener dodaje je na karcie klienta.
            </li>
          ) : null}
        </ul>
      </section>
    </div>
  );
}
