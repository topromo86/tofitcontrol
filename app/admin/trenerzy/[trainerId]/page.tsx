import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireRole } from "@/lib/auth/guard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { canHardDelete, describeDeletionBlockers } from "@/lib/domain/trainer-handover";
import { formatDate } from "@/lib/format";
import {
  deleteTrainerAction,
  reactivateTrainerAction,
  toggleLeadAccessAction,
  updateTrainerProfileAction,
  saveTrainerCompetitorAction,
} from "../actions";
import { TrainerAvatar } from "../trainer-avatar";
import {
  EXAM_LABEL,
  EXAM_STYLE,
  MEDICAL_EXAM_REMINDER_DAYS,
  examState,
} from "@/lib/domain/medical-exam";

const selectClass = "border-line bg-surface-2 text-text w-full rounded-md border px-2 py-2 text-sm";

export default async function TrainerDetailPage({
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
    include: { user: true, location: true, locations: { orderBy: { name: "asc" } } },
  });
  if (!trainer) notFound();

  const stanBadan = examState(trainer.medicalExamValidUntil, new Date());

  const [locations, sessions, members, templates, tasks] = await Promise.all([
    prisma.location.findMany({ orderBy: { name: "asc" } }),
    prisma.session.count({ where: { trainerId } }),
    prisma.member.count({ where: { ownerTrainerId: trainerId } }),
    prisma.classTemplate.count({ where: { trainerId } }),
    prisma.retentionTask.count({ where: { trainerId } }),
  ]);

  const blockers = { sessions, members, templates, tasks };
  const deletable = canHardDelete(blockers);

  return (
    <div className="flex flex-col gap-8">
      <div>
        <Link href="/admin/trenerzy" className="text-muted-brand font-mono text-xs underline">
          ← Wszyscy trenerzy
        </Link>
        <div className="mt-3 flex items-center gap-4">
          <TrainerAvatar
            trainerId={trainer.id}
            name={trainer.user.name}
            hasPhoto={trainer.photoMimeType != null}
            size={72}
          />
          <div>
            <h1 className="font-display text-brand-red text-2xl tracking-wide">
              {trainer.user.name}
            </h1>
            <p className="text-muted-brand mt-1 font-mono text-xs tracking-widest uppercase">
              {trainer.locations.length > 0
                ? trainer.locations.map((l) => l.name).join(", ")
                : trainer.location.name}{" "}
              · {trainer.user.email}
              {trainer.active ? "" : " · wyciszony"}
            </p>
          </div>
        </div>
      </div>

      {error ? (
        <p role="alert" className="border-red/40 bg-red/5 text-red rounded-md border p-3 text-sm">
          {error}
        </p>
      ) : null}

      {!trainer.active ? (
        <section className="border-amber/40 bg-amber/5 rounded-md border p-4">
          <p className="text-text font-medium">
            Ten trener jest wyciszony
            {trainer.deactivatedAt ? ` od ${formatDate(trainer.deactivatedAt)}` : ""}.
          </p>
          <p className="text-muted-brand mt-1 text-sm">
            Nie pojawia się w grafiku ani u klientów. Historia została nietknięta. Okna treningów
            indywidualnych są wyłączone - po przywróceniu trzeba ustawić je na nowo.
          </p>
          <form action={reactivateTrainerAction} className="mt-3">
            <input type="hidden" name="trainerId" value={trainer.id} />
            <Button type="submit">Przywróć trenera</Button>
          </form>
        </section>
      ) : null}

      <section>
        <h2 className="text-muted-brand font-mono text-xs tracking-widest uppercase">
          Wizytówka (widoczna dla klientów)
        </h2>
        <form
          action={updateTrainerProfileAction}
          className="border-line bg-surface mt-2 flex flex-col gap-4 rounded-md border p-4"
        >
          <input type="hidden" name="trainerId" value={trainer.id} />

          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <Label htmlFor="name">Imię i nazwisko</Label>
              <Input
                id="name"
                name="name"
                required
                minLength={3}
                defaultValue={trainer.user.name}
                className="border-line bg-surface-2"
              />
            </div>
            <div>
              <Label htmlFor="phone">Telefon</Label>
              <Input
                id="phone"
                name="phone"
                defaultValue={trainer.user.phone ?? ""}
                className="border-line bg-surface-2"
              />
            </div>
            <div>
              <Label htmlFor="locationId">Lokalizacja domyślna</Label>
              <select
                id="locationId"
                name="locationId"
                required
                defaultValue={trainer.locationId}
                className={selectClass}
              >
                {locations.map((location) => (
                  <option key={location.id} value={location.id}>
                    {location.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {locations.length > 1 ? (
            <div>
              <Label>Pracuje także w</Label>
              <div className="mt-1 flex flex-wrap gap-4">
                {locations.map((location) => (
                  <label key={location.id} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      name="workLocations"
                      value={location.id}
                      defaultChecked={trainer.locations.some((l) => l.id === location.id)}
                    />
                    {location.name}
                  </label>
                ))}
              </div>
              <p className="text-muted-brand mt-1 text-xs">
                Wszystkie sale, w których trener prowadzi zajęcia. Domyślna jest zawsze wliczona.
              </p>
            </div>
          ) : null}

          <div>
            <Label htmlFor="bio">Opis</Label>
            <Textarea
              id="bio"
              name="bio"
              rows={4}
              defaultValue={trainer.bio ?? ""}
              placeholder="Doświadczenie, specjalizacja, osiągnięcia..."
              className="border-line bg-surface-2"
            />
          </div>

          <div>
            <Label htmlFor="photo">
              {trainer.photoMimeType ? "Zmień zdjęcie" : "Wgraj zdjęcie"}
            </Label>
            <Input
              id="photo"
              name="photo"
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className="border-line bg-surface-2"
            />
            <p className="text-muted-brand mt-1 text-xs">JPG, PNG albo WEBP, maksymalnie 800 kB.</p>
            {trainer.photoMimeType ? (
              <label className="text-muted-brand mt-2 flex items-center gap-2 text-sm">
                <input type="checkbox" name="removePhoto" className="size-4" />
                Usuń obecne zdjęcie
              </label>
            ) : null}
          </div>

          <Button type="submit" className="self-start">
            Zapisz wizytówkę
          </Button>
        </form>
      </section>

      {/* Zawodnik i badania - kadra tez startuje w zawodach. */}
      <section className="border-line bg-surface flex flex-col gap-3 rounded-md border p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-muted-brand font-mono text-xs tracking-widest uppercase">
            Zawodnik i badania
          </h2>
          {trainer.isCompetitor ? (
            <span className={`font-mono text-xs ${EXAM_STYLE[stanBadan]}`}>
              {EXAM_LABEL[stanBadan]}
              {trainer.medicalExamValidUntil
                ? ` · do ${formatDate(trainer.medicalExamValidUntil)}`
                : ""}
            </span>
          ) : null}
        </div>
        <form action={saveTrainerCompetitorAction} className="flex flex-wrap items-end gap-3">
          <input type="hidden" name="trainerId" value={trainer.id} />
          <label className="text-text flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              name="isCompetitor"
              value="tak"
              defaultChecked={trainer.isCompetitor}
              className="accent-brand-red size-4"
            />
            Zawodnik
          </label>
          <div className="flex flex-col gap-1">
            <Label htmlFor="medicalExamValidUntil">Badania ważne do</Label>
            <Input
              id="medicalExamValidUntil"
              name="medicalExamValidUntil"
              type="date"
              defaultValue={
                trainer.medicalExamValidUntil
                  ? trainer.medicalExamValidUntil.toISOString().slice(0, 10)
                  : ""
              }
              className="border-line bg-surface-2 w-44"
            />
          </div>
          <Button type="submit" size="sm">
            Zapisz
          </Button>
        </form>
        <p className="text-muted-brand text-xs">
          Puste pole znaczy „brak badań”. Na {MEDICAL_EXAM_REMINDER_DAYS} dni przed końcem system
          przypomni zawodnikowi i właścicielowi.
        </p>
      </section>

      <section>
        <h2 className="text-muted-brand font-mono text-xs tracking-widest uppercase">
          Dostęp do leadów (CRM)
        </h2>
        <div className="border-line bg-surface mt-2 flex flex-wrap items-center justify-between gap-3 rounded-md border p-4">
          <p className="text-muted-brand text-sm">
            {trainer.user.canAccessLeads
              ? "Ten trener widzi i obsługuje leady z reklam (Facebook / Instagram)."
              : "Ten trener nie ma dostępu do leadów z reklam."}
          </p>
          <form action={toggleLeadAccessAction}>
            <input type="hidden" name="trainerId" value={trainer.id} />
            <Button type="submit" size="sm" variant="outline">
              {trainer.user.canAccessLeads ? "Odbierz dostęp" : "Nadaj dostęp"}
            </Button>
          </form>
        </div>
      </section>

      {trainer.active ? (
        <section>
          <h2 className="text-muted-brand font-mono text-xs tracking-widest uppercase">
            Wyciszenie
          </h2>
          <div className="border-line bg-surface mt-2 rounded-md border p-4">
            <p className="text-muted-brand text-sm">
              Trener zniknie z grafiku i z widoku klientów, ale cała historia zostanie. Na następnym
              ekranie wskażesz, kto przejmuje jego podopiecznych, zajęcia i zadania - nic nie
              zostanie bez opiekuna.
            </p>
            <Link
              href={`/admin/trenerzy/${trainer.id}/wyciszenie`}
              className="bg-brand-red mt-3 inline-block rounded-md px-4 py-2 text-sm font-medium text-white"
            >
              Przejdź do wyciszenia
            </Link>
          </div>
        </section>
      ) : null}

      <section>
        <h2 className="text-muted-brand font-mono text-xs tracking-widest uppercase">
          Trwałe usunięcie
        </h2>
        <div className="border-line bg-surface mt-2 rounded-md border p-4">
          {deletable ? (
            <>
              <p className="text-muted-brand text-sm">
                To konto nie ma żadnej historii, więc można je usunąć na stałe razem z kontem
                logowania. Operacja jest nieodwracalna.
              </p>
              <form action={deleteTrainerAction} className="mt-3">
                <input type="hidden" name="trainerId" value={trainer.id} />
                <Button type="submit" variant="outline">
                  Usuń trwale
                </Button>
              </form>
            </>
          ) : (
            <p className="text-muted-brand text-sm">
              Nie można usunąć - z tym trenerem powiązane są:{" "}
              <b>{describeDeletionBlockers(blockers).join(", ")}</b>. To historia klubu (obecności,
              oceny, rozliczenia) i nie wolno jej skasować. Jeśli trener odchodzi, użyj wyciszenia -
              efekt dla grafiku i klientów jest ten sam, a dane zostają.
            </p>
          )}
        </div>
      </section>
    </div>
  );
}
