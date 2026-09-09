import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { getAccessibleMembers } from "@/lib/auth/guard";
import { hasRequiredConsents, requiredConsentKeys } from "@/lib/domain/booking";
import { computeWeeklyStreak } from "@/lib/domain/progress";
import { MEMBER_LEVEL_LABEL } from "@/lib/domain/member-level";
import { todayInTimeZone } from "@/lib/domain/time";
import { formatDate, formatDayTime } from "@/lib/format";
import { EXAM_LABEL, EXAM_STYLE, examState } from "@/lib/domain/medical-exam";

const RATING_DELAY_MS = 3_600_000;

// Pulpit klubowicza - ekran startowy po zalogowaniu. Podsumowanie: karnet,
// najbliższe zajęcia, seria treningowa i lista rzeczy do ogarnięcia (zgody,
// oceny). Zapisy robi się w Grafiku - tu jest podgląd i szybkie przejścia.
export default async function ClientDashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ member?: string }>;
}) {
  const params = await searchParams;
  const members = await getAccessibleMembers();
  if (members.length === 0) return null; // layout pokazał już komunikat

  const activeMember = members.find((m) => m.id === params.member) ?? members[0];
  const now = new Date();
  const today = todayInTimeZone(now);
  const firstName = activeMember.firstName;

  const [currentPass, upcoming, attendances, consents, pendingRatings] = await Promise.all([
    prisma.pass.findFirst({
      where: { memberId: activeMember.id, status: { in: ["ACTIVE", "FROZEN"] } },
      orderBy: { endsAt: "desc" },
      include: { plan: true },
    }),
    prisma.booking.findMany({
      where: {
        memberId: activeMember.id,
        status: { in: ["BOOKED", "WAITLIST"] },
        session: { startsAt: { gte: now }, status: { not: "CANCELLED" } },
      },
      include: { session: { include: { trainer: { include: { user: true } } } } },
      orderBy: { session: { startsAt: "asc" } },
      take: 5,
    }),
    prisma.attendance.findMany({
      where: { memberId: activeMember.id },
      select: { checkedInAt: true },
    }),
    prisma.consent.findMany({
      where: { memberId: activeMember.id, revokedAt: null },
      include: { consentType: true },
    }),
    prisma.attendance.count({
      where: {
        memberId: activeMember.id,
        checkedInAt: { lte: new Date(now.getTime() - RATING_DELAY_MS) },
        session: { ratings: { none: { memberId: activeMember.id } } },
      },
    }),
  ]);

  const streak = computeWeeklyStreak(
    attendances.map((a) => todayInTimeZone(a.checkedInAt)),
    today,
  );
  const grantedKeys = new Set(consents.map((c) => c.consentType.key));
  const missingConsents = !hasRequiredConsents(
    grantedKeys,
    requiredConsentKeys(activeMember.isMinor),
  );

  const passValue = currentPass
    ? currentPass.entriesLeft == null
      ? "bez limitu"
      : `${currentPass.entriesLeft} wejść`
    : "brak";
  const passHint = currentPass
    ? `ważny do ${formatDate(currentPass.endsAt)}${currentPass.status === "FROZEN" ? " · zamrożony" : ""}`
    : "skontaktuj się z klubem";

  const kpis = [
    { label: "Mój karnet", value: passValue, hint: passHint },
    { label: "Najbliższe zajęcia", value: String(upcoming.length), hint: "zapisane terminy" },
    {
      label: "Seria treningowa",
      value: `${streak} ${streak === 1 ? "tydz." : "tyg."}`,
      hint: "tygodnie z rzędu",
    },
    {
      label: "Poziom",
      value: MEMBER_LEVEL_LABEL[activeMember.level] ?? activeMember.level,
      hint: "postępy w Postępach",
    },
  ];

  const todo: { label: string; href: string }[] = [];
  if (activeMember.approvalStatus === "PENDING")
    todo.push({ label: "Konto czeka na zatwierdzenie przez klub", href: "/app/pulpit" });
  if (missingConsents)
    todo.push({
      label: "Uzupełnij wymagane zgody",
      href: `/app/zgody?member=${activeMember.id}`,
    });
  if (activeMember.consentsDeliveredAt == null && !missingConsents)
    todo.push({
      label: "Dostarcz podpisane zgody trenerowi lub w recepcji",
      href: `/app/zgody?member=${activeMember.id}`,
    });
  if (pendingRatings > 0)
    todo.push({ label: `Oceń ostatnie zajęcia (${pendingRatings})`, href: "/app" });

  const stanBadan = examState(activeMember.medicalExamValidUntil, new Date());

  const shortcuts = [
    { label: "Zapisz się", href: "/app" },
    { label: "Mój karnet", href: "/app/karnet" },
    { label: "Postępy", href: "/app/postepy" },
    { label: "Zgody", href: "/app/zgody" },
    { label: "Powiadomienia", href: "/app/powiadomienia" },
    { label: "Trenerzy", href: "/app/trenerzy" },
  ];

  return (
    <div className="flex flex-col gap-8">
      {members.length > 1 ? (
        <div className="flex flex-wrap gap-2">
          {members.map((m) => (
            <Link
              key={m.id}
              href={`/app/pulpit?member=${m.id}`}
              className={`rounded-md border px-3 py-1.5 text-sm ${
                m.id === activeMember.id
                  ? "border-brand-red text-brand-red font-medium"
                  : "border-line bg-surface text-text"
              }`}
            >
              {m.firstName}
              {m.relation === "child" ? (
                <span className="text-muted-brand ml-1 text-xs">(dziecko)</span>
              ) : null}
            </Link>
          ))}
        </div>
      ) : null}

      <div>
        <h1 className="font-display text-brand-red text-2xl tracking-wide">Cześć, {firstName}</h1>
        <p className="text-muted-brand mt-1 text-sm">Miło Cię widzieć. Oto Twój dzień w skrócie.</p>
      </div>

      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {kpis.map((k) => (
          <div key={k.label} className="border-line bg-surface rounded-md border p-4">
            <p className="text-muted-brand font-mono text-[11px] tracking-widest uppercase">
              {k.label}
            </p>
            <p className="text-text font-display mt-2 text-xl">{k.value}</p>
            <p className="text-muted-brand mt-1 text-xs">{k.hint}</p>
          </div>
        ))}
      </section>

      {/* Badania zawodnika. Widzi je tylko ten, kto jest oznaczony jako
          zawodnik - reszcie nic to nie mówi. Termin ustala kadra; tutaj jest
          wyłącznie do odczytu, bo bierze się z zaświadczenia lekarskiego,
          które ktoś musiał zobaczyć. */}
      {activeMember.isCompetitor ? (
        <section
          className={`flex flex-col gap-1 rounded-md border p-4 ${
            stanBadan === "WYGASLO"
              ? "border-red/40 bg-red/5"
              : stanBadan === "KONCZY_SIE"
                ? "border-amber/50 bg-amber/10"
                : "border-line bg-surface"
          }`}
        >
          <h2 className="text-muted-brand font-mono text-xs tracking-widest uppercase">
            Badania lekarskie do zawodów
          </h2>
          <p className={`text-sm ${EXAM_STYLE[stanBadan]}`}>
            {EXAM_LABEL[stanBadan]}
            {activeMember.medicalExamValidUntil
              ? ` - ważne do ${formatDate(activeMember.medicalExamValidUntil)}`
              : ""}
          </p>
          <p className="text-muted-brand text-sm">
            {stanBadan === "WYGASLO"
              ? "Bez ważnych badań nie wystartujesz w zawodach. Umów wizytę i podaj nowy termin trenerowi."
              : stanBadan === "BRAK"
                ? "Klub nie ma wpisanego terminu Twoich badań. Pokaż zaświadczenie trenerowi."
                : "Nowy termin wpisuje trener po okazaniu zaświadczenia."}
          </p>
        </section>
      ) : null}

      {/* Jak odbić obecność. Krótko i na pulpicie, bo klubowicz nie ma już
          żadnego własnego kodu do pokazania - jedyna droga prowadzi przez kod
          z tabletu na sali, a bez tego zdania nie ma skąd o tym wiedzieć. */}
      <section className="border-line bg-surface flex flex-col gap-1 rounded-md border p-4">
        <h2 className="text-muted-brand font-mono text-xs tracking-widest uppercase">
          Jak odbić obecność
        </h2>
        <p className="text-text text-sm">
          Zeskanuj telefonem kod QR z tabletu na sali i potwierdź obecność na swoim ekranie. Kod
          pojawia się kilkanaście minut przed zajęciami i każde zajęcia mają własny.
        </p>
        <p className="text-muted-brand text-sm">
          Nie potrzebujesz żadnego kodu u siebie. Jeśli coś nie zadziała, powiedz trenerowi -
          zaznaczy Cię z listy.
        </p>
      </section>

      {todo.length > 0 ? (
        <section className="flex flex-col gap-3">
          <h2 className="text-muted-brand font-mono text-xs tracking-widest uppercase">
            Do zrobienia
          </h2>
          <ul className="flex flex-col gap-2">
            {todo.map((t) => (
              <li key={t.label}>
                <Link
                  href={t.href}
                  className="border-amber bg-amber/5 hover:bg-amber/10 text-text flex items-center justify-between gap-3 rounded-md border p-3 text-sm transition"
                >
                  {t.label}
                  <span className="text-amber shrink-0">→</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="text-muted-brand font-mono text-xs tracking-widest uppercase">
            Twoje najbliższe zajęcia ({upcoming.length})
          </h2>
          <Link href="/app" className="text-brand-red text-xs underline">
            Grafik →
          </Link>
        </div>
        {upcoming.length === 0 ? (
          <p className="text-muted-brand border-line bg-surface rounded-md border p-4 text-sm">
            Nie masz zapisanych zajęć. Wybierz termin w{" "}
            <Link href="/app" className="text-brand-red underline">
              Grafiku
            </Link>
            .
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {upcoming.map((b) => (
              <li
                key={b.id}
                className="border-line bg-surface flex flex-wrap items-center justify-between gap-2 rounded-md border p-3"
              >
                <div className="min-w-0">
                  <p className="text-text font-medium">{b.session.name}</p>
                  <p className="text-muted-brand mt-0.5 font-mono text-xs">
                    {formatDayTime(b.session.startsAt)} · {b.session.trainer.user.name}
                    {b.status === "WAITLIST" ? " · lista rezerwowa" : ""}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-muted-brand font-mono text-xs tracking-widest uppercase">
          Szybkie akcje
        </h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {shortcuts.map((s) => (
            <Link
              key={s.href}
              href={s.href}
              className="border-line bg-surface hover:border-brand-red hover:text-brand-red text-text flex items-center justify-center rounded-md border p-4 text-center text-sm font-medium transition"
            >
              {s.label}
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}
