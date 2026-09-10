import Link from "next/link";
import { Info } from "lucide-react";
import { prisma } from "@/lib/prisma";
import { requireRole } from "@/lib/auth/guard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { formatDate } from "@/lib/format";
import { createTrainerAction } from "./actions";
import { TrainerAvatar } from "./trainer-avatar";

const selectClass =
  "border-line bg-surface-2 text-text w-full rounded-md border px-2 py-2 text-base md:text-sm";

export default async function AdminTrainersPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  await requireRole("ADMIN");
  const { error } = await searchParams;

  const [locations, trainers] = await Promise.all([
    prisma.location.findMany({ orderBy: { name: "asc" } }),
    prisma.trainer.findMany({
      include: {
        user: true,
        location: true,
        locations: { orderBy: { name: "asc" } },
        _count: { select: { ownedMembers: true } },
      },
      orderBy: [{ active: "desc" }, { user: { name: "asc" } }],
    }),
  ]);

  // Wszystkie lokalizacje trenera (M2M zawiera domyślną). Fallback na domyślną,
  // gdyby zestaw był pusty.
  const locationLabel = (t: (typeof trainers)[number]): string =>
    t.locations.length > 0 ? t.locations.map((l) => l.name).join(", ") : t.location.name;

  const activeTrainers = trainers.filter((t) => t.active);
  const mutedTrainers = trainers.filter((t) => !t.active);

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="font-display text-brand-red text-2xl tracking-wide">Trenerzy</h1>
        <p className="text-muted-brand mt-1 text-sm">
          Kadra klubu, wizytówki widoczne dla klientów i wyciszanie bez utraty historii.
        </p>
      </div>

      {error ? (
        <p role="alert" className="border-red/40 bg-red/5 text-red rounded-md border p-3 text-sm">
          {error}
        </p>
      ) : null}

      <section>
        <h2 className="text-muted-brand font-mono text-xs tracking-widest uppercase">
          Aktywni ({activeTrainers.length})
        </h2>
        <ul className="mt-2 flex flex-col gap-2">
          {activeTrainers.map((trainer) => (
            <li key={trainer.id} className="border-line bg-surface rounded-md border p-3">
              <div className="flex items-center gap-3">
                <TrainerAvatar
                  trainerId={trainer.id}
                  name={trainer.user.name}
                  hasPhoto={trainer.photoMimeType != null}
                  size={44}
                />
                <div className="min-w-0 flex-1">
                  <p className="text-text font-medium">{trainer.user.name}</p>
                  <p className="text-muted-brand mt-0.5 font-mono text-xs">
                    {locationLabel(trainer)} · {trainer._count.ownedMembers} podopiecznych · od{" "}
                    {formatDate(trainer.hiredAt)}
                  </p>
                </div>
                <Link
                  href={`/admin/trenerzy/${trainer.id}`}
                  className="border-line bg-surface-2 text-text hover:text-brand-red shrink-0 rounded-md border px-3 py-1.5 font-mono text-xs uppercase"
                >
                  Otwórz
                </Link>
              </div>
            </li>
          ))}
          {activeTrainers.length === 0 ? (
            <li className="text-muted-brand text-sm">Brak aktywnych trenerów.</li>
          ) : null}
        </ul>
      </section>

      {mutedTrainers.length > 0 ? (
        <details className="group">
          {/* Domyślnie zwinięci - widać tylko liczbę. Natywne <details>, więc
              rozwijanie działa bez JS. */}
          <summary className="text-muted-brand hover:text-brand-red flex cursor-pointer list-none items-center gap-2 font-mono text-xs tracking-widest uppercase [&::-webkit-details-marker]:hidden">
            <span className="inline-block text-[10px] transition-transform group-open:rotate-90">
              ▶
            </span>
            Wyciszeni ({mutedTrainers.length})
          </summary>
          <ul className="mt-2 flex flex-col gap-2">
            {mutedTrainers.map((trainer) => (
              <li
                key={trainer.id}
                className="border-line bg-surface-2 flex items-center gap-3 rounded-md border p-3 opacity-70"
              >
                <TrainerAvatar
                  trainerId={trainer.id}
                  name={trainer.user.name}
                  hasPhoto={trainer.photoMimeType != null}
                  size={44}
                />
                <div className="min-w-0 flex-1">
                  <p className="text-text font-medium">
                    {trainer.user.name}
                    <span className="bg-amber/10 text-amber ml-2 rounded-full px-2 py-0.5 font-mono text-xs uppercase">
                      Wyciszony
                    </span>
                  </p>
                  <p className="text-muted-brand mt-0.5 font-mono text-xs">
                    {locationLabel(trainer)}
                    {trainer.deactivatedAt ? ` · od ${formatDate(trainer.deactivatedAt)}` : ""}
                  </p>
                </div>
                <Link
                  href={`/admin/trenerzy/${trainer.id}`}
                  className="border-line bg-surface text-text hover:text-brand-red shrink-0 rounded-md border px-3 py-1.5 font-mono text-xs uppercase"
                >
                  Otwórz
                </Link>
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      <section>
        <h2 className="text-muted-brand font-mono text-xs tracking-widest uppercase">
          Dodaj trenera
        </h2>
        <form
          action={createTrainerAction}
          className="border-line bg-surface mt-2 flex flex-col gap-4 rounded-md border p-4"
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="name">Imię i nazwisko</Label>
              <Input
                id="name"
                name="name"
                required
                minLength={3}
                className="border-line bg-surface-2"
              />
            </div>
            <div>
              <Label htmlFor="email">E-mail (login)</Label>
              <Input
                id="email"
                name="email"
                type="email"
                required
                className="border-line bg-surface-2"
              />
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <Label htmlFor="phone">Telefon</Label>
              <Input id="phone" name="phone" className="border-line bg-surface-2" />
            </div>
            <div>
              <Label htmlFor="locationId">Lokalizacja domyślna</Label>
              <select id="locationId" name="locationId" required className={selectClass}>
                <option value="">Wybierz...</option>
                {locations.map((location) => (
                  <option key={location.id} value={location.id}>
                    {location.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label htmlFor="hiredAt">Zatrudniony od</Label>
              <Input id="hiredAt" name="hiredAt" type="date" className="border-line bg-surface-2" />
            </div>
          </div>

          {locations.length > 1 ? (
            <div>
              <Label>Pracuje także w (opcjonalnie)</Label>
              <div className="mt-1 flex flex-wrap gap-4">
                {locations.map((location) => (
                  <label key={location.id} className="flex items-center gap-2 text-sm">
                    <input type="checkbox" name="workLocations" value={location.id} />
                    {location.name}
                  </label>
                ))}
              </div>
              <p className="text-muted-brand mt-1 text-xs">
                Zaznacz wszystkie sale, w których trener prowadzi zajęcia. Lokalizacja domyślna jest
                zawsze wliczona.
              </p>
            </div>
          ) : null}

          <div>
            <Label htmlFor="password">Hasło startowe</Label>
            <Input
              id="password"
              name="password"
              type="text"
              required
              minLength={8}
              placeholder="min. 8 znaków - przekaż je trenerowi"
              className="border-line bg-surface-2"
            />
            <p className="text-muted-brand mt-1 text-xs">
              Widoczne celowo, żebyś mógł je przekazać trenerowi. ❗️ W systemie nie ma jeszcze
              ekranu zmiany własnego hasła - trener będzie logował się tym, co tu ustawisz.
            </p>
          </div>

          <div>
            <Label htmlFor="bio">Opis (widoczny dla klientów)</Label>
            <Textarea
              id="bio"
              name="bio"
              rows={3}
              placeholder="Doświadczenie, specjalizacja, osiągnięcia..."
              className="border-line bg-surface-2"
            />
          </div>

          <div>
            <Label htmlFor="photo">Zdjęcie (widoczne dla klientów)</Label>
            <Input
              id="photo"
              name="photo"
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className="border-line bg-surface-2"
            />
            <p className="text-muted-brand mt-1 text-xs">JPG, PNG albo WEBP, maksymalnie 800 kB.</p>
          </div>

          <Button type="submit" className="self-start">
            Dodaj trenera
          </Button>
        </form>
      </section>

      <details className="border-line bg-surface rounded-md border">
        <summary className="text-text flex cursor-pointer list-none items-center gap-2 p-4 font-mono text-xs tracking-widest uppercase [&::-webkit-details-marker]:hidden">
          <Info className="text-brand-red size-4" />
          Wyciszenie a usunięcie
        </summary>
        <div className="border-line text-muted-brand flex max-w-[72ch] flex-col gap-5 border-t p-4 text-sm">
          <div>
            <p className="text-text mb-1 font-mono text-xs tracking-widest uppercase">
              Wyciszenie - domyślna droga
            </p>
            <p>
              Trener znika z list wyboru, z grafiku i z widoku klientów, ale cała historia zostaje:
              obecności, oceny, wyniki, rozliczenia. Przed wyciszeniem system pokazuje wszystko, co
              ta osoba prowadzi, i <b>wymaga wskazania następcy dla każdej pozycji</b> - można
              przepisać wszystko na jednego trenera albo rozdzielić po kawałku. Bez kompletu wskazań
              wyciszenie się nie wykona.
            </p>
            <p className="mt-2">
              Wyciszenie można cofnąć jednym kliknięciem. Okna treningów indywidualnych są wyłączane
              (nie da się przekazać czyjejś dyspozycyjności) - po powrocie trener ustawia je na
              nowo.
            </p>
          </div>

          <div>
            <p className="text-text mb-1 font-mono text-xs tracking-widest uppercase">
              Usunięcie - tylko pomyłki
            </p>
            <p>
              Trwałe usunięcie działa <b>wyłącznie dla konta bez żadnej historii</b> - czyli w
              praktyce takiego, które właśnie założyłeś przez pomyłkę. Jeśli trener poprowadził
              choćby jedne zajęcia, baza go nie puści i słusznie: skasowanie pociągnęłoby za sobą
              obecności, oceny i kontekst rozliczeń, które muszą zostać. W takiej sytuacji właściwą
              operacją jest wyciszenie.
            </p>
          </div>
        </div>
      </details>
    </div>
  );
}
