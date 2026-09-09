import { prisma } from "@/lib/prisma";
import { requireRole } from "@/lib/auth/guard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PaymentsList } from "../../payments-list";

// Przyjmowanie wpłat po stronie właściciela. Ten sam mechanizm co w kasie
// trenera, ale dla WSZYSTKICH klientów klubu, nie tylko podopiecznych jednego
// trenera - właściciel przy biurku rozlicza każdego, kto podejdzie.
//
// Dostępne dla roli ADMIN, czyli i dla Daniela (który dodatkowo ma widok
// trenera), i dla superadmina, który rekordu trenera nie ma w ogóle i bez tego
// ekranu nie mógłby przyjąć żadnej wpłaty.
export default async function AdminWplatyPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; error?: string; ok?: string }>;
}) {
  await requireRole("ADMIN");
  const { q, error, ok } = await searchParams;

  const [plans, locations, members] = await Promise.all([
    prisma.plan.findMany({ where: { active: true } }),
    prisma.location.findMany({ orderBy: { name: "asc" } }),
    prisma.member.findMany({
      where: q
        ? {
            OR: [
              { firstName: { contains: q, mode: "insensitive" } },
              { lastName: { contains: q, mode: "insensitive" } },
            ],
          }
        : {},
      include: {
        passes: {
          where: { status: { in: ["ACTIVE", "FROZEN"] } },
          orderBy: { endsAt: "desc" },
          include: { plan: true, payments: { select: { amountGross: true } } },
        },
      },
      orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
      // Kartoteka klubu potrafi urosnąć - bez wyszukiwarki pokazujemy początek
      // listy, a nie wszystko naraz.
      take: q ? 100 : 50,
    }),
  ]);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="font-display text-brand-red text-2xl tracking-wide">Wpłaty</h1>
        <p className="text-muted-brand mt-1 text-sm">
          Sprzedaż karnetu i przyjmowanie wpłat od każdego klienta klubu. Widać tu status opłaty i
          ważność karnetów, a zaległość można wyrównać jednym kliknięciem.
        </p>
      </div>

      {error ? (
        <p role="alert" className="border-red/40 bg-red/5 text-red rounded-md border p-3 text-sm">
          {error}
        </p>
      ) : null}
      {ok ? (
        <p className="border-jade bg-surface text-text rounded-md border p-3 text-sm">
          Wpłata przyjęta.
        </p>
      ) : null}

      <form className="flex gap-2">
        <Input
          name="q"
          defaultValue={q}
          placeholder="Szukaj klienta..."
          className="border-line bg-surface-2"
        />
        <Button type="submit" variant="outline">
          Szukaj
        </Button>
      </form>

      <PaymentsList
        members={members}
        plans={plans}
        locations={locations}
        defaultLocationId={locations[0]?.id ?? ""}
        returnTo="/admin/wplaty"
        q={q ?? ""}
        now={new Date()}
        mozeWybracDate
      />
    </div>
  );
}
