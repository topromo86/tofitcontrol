import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireRole } from "@/lib/auth/guard";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  HANDOVER_KIND_LABEL,
  handoverFieldName,
  type HandoverItem,
  type HandoverItemKind,
} from "@/lib/domain/trainer-handover";
import { collectHandoverItems, eligibleHandoverTrainers } from "@/lib/services/trainer";
import { deactivateTrainerAction } from "../../actions";

const selectClass =
  "border-line bg-surface-2 text-text rounded-md border px-2 py-1.5 text-base md:text-sm";

const KIND_ORDER: HandoverItemKind[] = ["MEMBER", "SESSION", "TEMPLATE", "TASK"];

export default async function TrainerHandoverPage({
  params,
  searchParams,
}: {
  params: Promise<{ trainerId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  await requireRole("ADMIN");
  const { trainerId } = await params;
  const { error } = await searchParams;

  const trainer = await prisma.trainer.findUnique({
    where: { id: trainerId },
    include: { user: true, location: true },
  });
  if (!trainer) notFound();
  if (!trainer.active) redirect(`/admin/trenerzy/${trainerId}`);

  const [items, eligible, windowCount] = await Promise.all([
    collectHandoverItems(trainerId),
    eligibleHandoverTrainers(trainerId),
    prisma.availabilityWindow.count({ where: { trainerId, active: true } }),
  ]);

  const grouped = new Map<HandoverItemKind, HandoverItem[]>();
  for (const item of items) {
    const bucket = grouped.get(item.kind);
    if (bucket) bucket.push(item);
    else grouped.set(item.kind, [item]);
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link
          href={`/admin/trenerzy/${trainerId}`}
          className="text-muted-brand font-mono text-xs underline"
        >
          ← Wróć do karty trenera
        </Link>
        <h1 className="font-display text-brand-red mt-3 text-2xl tracking-wide">
          Wyciszenie: {trainer.user.name}
        </h1>
        <p className="text-muted-brand mt-1 text-sm">
          Zanim trener zniknie z grafiku, wskaż kto przejmuje jego obowiązki. Nic nie może zostać
          bez opiekuna.
        </p>
      </div>

      {error ? (
        <p role="alert" className="border-red/40 bg-red/5 text-red rounded-md border p-3 text-sm">
          {error}
        </p>
      ) : null}

      {eligible.length === 0 ? (
        <div className="border-red/40 bg-red/5 rounded-md border p-4">
          <p className="text-text font-medium">Nie ma komu przekazać obowiązków</p>
          <p className="text-muted-brand mt-1 text-sm">
            To jedyny aktywny trener w klubie. Najpierw dodaj kogoś, kto przejmie podopiecznych i
            zajęcia.
          </p>
          <Link
            href="/admin/trenerzy"
            className="text-brand-red mt-2 inline-block text-sm underline"
          >
            Dodaj trenera
          </Link>
        </div>
      ) : (
        <form action={deactivateTrainerAction} className="flex flex-col gap-6">
          <input type="hidden" name="trainerId" value={trainer.id} />

          {items.length === 0 ? (
            <div className="border-jade/40 bg-jade/5 rounded-md border p-4">
              <p className="text-text font-medium">Nie ma czego przepisywać</p>
              <p className="text-muted-brand mt-1 text-sm">
                Ten trener nie ma podopiecznych, zaplanowanych zajęć, powtarzalnych planów ani
                otwartych zadań. Można go wyciszyć od razu.
              </p>
            </div>
          ) : (
            <>
              <section className="border-line bg-surface rounded-md border p-4">
                <Label htmlFor="bulkTarget">Przepisz wszystko na jednego trenera</Label>
                <select id="bulkTarget" name="bulkTarget" className={`${selectClass} mt-1 w-full`}>
                  <option value="">Nie wybieraj hurtem - ustawię każdą pozycję osobno</option>
                  {eligible.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.user.name} ({t.location.name})
                    </option>
                  ))}
                </select>
                <p className="text-muted-brand mt-2 text-xs">
                  To wybór domyślny dla wszystkich pozycji poniżej. Każdą z nich możesz nadpisać
                  osobno - wybór przy pozycji zawsze wygrywa.
                </p>
              </section>

              {KIND_ORDER.filter((kind) => grouped.has(kind)).map((kind) => {
                const kindItems = grouped.get(kind)!;
                return (
                  <section key={kind}>
                    <h2 className="text-muted-brand font-mono text-xs tracking-widest uppercase">
                      {HANDOVER_KIND_LABEL[kind]} ({kindItems.length})
                    </h2>
                    <ul className="mt-2 flex flex-col gap-2">
                      {kindItems.map((item) => (
                        <li
                          key={`${item.kind}-${item.id}`}
                          className="border-line bg-surface flex flex-wrap items-center justify-between gap-3 rounded-md border p-3"
                        >
                          <div className="min-w-0">
                            <p className="text-text text-sm font-medium">{item.label}</p>
                            {item.detail ? (
                              <p className="text-muted-brand mt-0.5 font-mono text-xs">
                                {item.detail}
                              </p>
                            ) : null}
                          </div>
                          <select
                            name={handoverFieldName(item)}
                            defaultValue=""
                            aria-label={`Przekaż: ${item.label}`}
                            className={selectClass}
                          >
                            <option value="">jak wybór zbiorczy</option>
                            {eligible.map((t) => (
                              <option key={t.id} value={t.id}>
                                {t.user.name}
                              </option>
                            ))}
                          </select>
                        </li>
                      ))}
                    </ul>
                  </section>
                );
              })}
            </>
          )}

          {windowCount > 0 ? (
            <p className="border-line bg-surface-2 text-muted-brand rounded-md border p-3 text-sm">
              <b className="text-text">Okna treningów indywidualnych ({windowCount})</b> zostaną
              wyłączone, a nie przepisane - dyspozycyjności jednej osoby nie da się przekazać
              drugiej. Już umówione treningi indywidualne są na liście wyżej i wymagają wskazania
              następcy.
            </p>
          ) : null}

          <div className="flex items-center gap-3">
            <Button type="submit">Wycisz trenera</Button>
            <Link
              href={`/admin/trenerzy/${trainerId}`}
              className="text-muted-brand text-sm underline"
            >
              Anuluj
            </Link>
          </div>
        </form>
      )}
    </div>
  );
}
