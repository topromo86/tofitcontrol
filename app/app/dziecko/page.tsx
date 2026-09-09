import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/auth/guard";
import { DodajDziecko } from "./dodaj-dziecko";
import { formatDate } from "@/lib/format";
import Link from "next/link";

// "Moje dziecko" (SPEC.md sekcja 3, rola GUARDIAN): ostatnia obecność,
// trener, kontakt. Wyłącznie do odczytu - dane zmienia trener/admin,
// a ustawienia powiadomień mieszkają w /app/powiadomienia.
export default async function MyChildPage({
  searchParams,
}: {
  searchParams: Promise<{ dodano?: string }>;
}) {
  // Bez sprawdzania roli: aplikacja nigdy nie nadaje roli GUARDIAN (rejestracja
  // zawsze tworzy MEMBER), więc `requireRole("GUARDIAN")` chowało ten ekran
  // przed wszystkimi - łącznie z rodzicami, dla których powstał. O dostępie
  // decyduje POWIĄZANIE, tak jak wszędzie indziej w tym systemie.
  const session = await requireSession();
  const { dodano } = await searchParams;

  const children = await prisma.member.findMany({
    where: { guardianUserId: session.user.id },
    include: {
      ownerTrainer: { include: { user: true } },
      attendances: { orderBy: { checkedInAt: "desc" }, take: 1, include: { session: true } },
    },
    orderBy: { firstName: "asc" },
  });

  // Do formularza: sale i aktywni trenerzy, tak samo jak przy rejestracji.
  const [locations, trainers] = await Promise.all([
    prisma.location.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
    prisma.trainer.findMany({
      where: { active: true },
      select: { id: true, user: { select: { name: true } } },
      orderBy: { user: { name: "asc" } },
    }),
  ]);

  return (
    <div className="flex flex-col gap-8">
      <h1 className="font-display text-brand-red text-2xl tracking-wide">Moje dziecko</h1>

      {dodano ? (
        <p className="border-jade/40 bg-jade/10 text-text rounded-md border p-3 text-sm">
          Profil dziecka dodany. Klub go zatwierdzi - do tego czasu nie da się jeszcze zapisać go na
          zajęcia. Pamiętaj o zgodach w zakładce „Zgody”.
        </p>
      ) : null}

      {children.map((child) => {
        const lastAttendance = child.attendances[0];
        return (
          <section key={child.id} className="border-line bg-surface rounded-md border p-4">
            <p className="text-text font-medium">
              {child.firstName} {child.lastName}
            </p>
            <p className="text-muted-brand mt-1 text-sm">
              {lastAttendance
                ? `Ostatnia obecność: ${formatDate(lastAttendance.checkedInAt)} (${lastAttendance.session.name})`
                : "Brak zarejestrowanej obecności."}
            </p>
            <p className="text-muted-brand mt-1 text-sm">
              Trener-opiekun: {child.ownerTrainer.user.name}
              {child.ownerTrainer.user.phone ? ` · ${child.ownerTrainer.user.phone}` : ""}
              {child.ownerTrainer.user.email ? ` · ${child.ownerTrainer.user.email}` : ""}
            </p>
          </section>
        );
      })}
      {children.length === 0 ? (
        <p className="text-muted-brand text-sm">
          Nie masz jeszcze dziecka w systemie. Dodaj jego profil niżej - konto dla osoby
          niepełnoletniej zakłada rodzic, a dziecko nie loguje się osobno.
        </p>
      ) : null}

      <DodajDziecko
        locations={locations}
        trainers={trainers.map((t) => ({ id: t.id, name: t.user.name }))}
      />

      <section className="border-line bg-surface rounded-md border p-4">
        <h2 className="text-muted-brand font-mono text-xs tracking-widest uppercase">
          Powiadomienia
        </h2>
        <p className="text-muted-brand mt-1 text-sm">
          Powiadomienie o wejściu dziecka na salę oraz pozostałe ustawienia znajdziesz w jednym
          miejscu:{" "}
          <Link href="/app/powiadomienia" className="text-brand-red underline">
            Powiadomienia
          </Link>
          .
        </p>
      </section>
    </div>
  );
}
