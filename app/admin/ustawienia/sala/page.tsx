import { requireRole } from "@/lib/auth/guard";
import { getClubSettings } from "@/lib/services/settings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { saveClassQrSettingsAction } from "./actions";

export default async function FloorSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ zapisanoQr?: string; bladQr?: string }>;
}) {
  await requireRole("ADMIN");
  const { zapisanoQr, bladQr } = await searchParams;
  const { qrOpensMinutesBefore, trainerCheckInMinutesBefore } = await getClubSettings();

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <div>
        <h1 className="font-display text-brand-red text-2xl tracking-wide">Sala · kod zajęć</h1>
        <p className="text-muted-brand mt-1 text-sm">
          Tablet na sali pokazuje kod najbliższych zajęć. Prowadzący i klubowicze skanują go własnym
          telefonem i potwierdzają obecność u siebie. Każde zajęcia mają własny kod, więc zdjęcie
          wczorajszego ekranu nikogo nie wpuści.
        </p>
        <p className="text-muted-brand mt-2 text-sm">
          To jedyna droga odbicia kodem. Gdy tablet nie działa, obecność wpisuje trener ze swojego
          panelu i zatwierdza liczbę osób na sali - działa to również bez łącza.
        </p>
      </div>

      {zapisanoQr ? (
        <p className="border-jade/40 bg-jade/10 text-jade rounded-md border p-3 text-sm">
          Zapisano. Nowe ustawienia obowiązują od kolejnych zajęć.
        </p>
      ) : null}
      {bladQr === "1" ? (
        <p className="border-red/40 bg-red/10 text-red rounded-md border p-3 text-sm">
          Kod może pojawiać się od 1 do 120 minut przed zajęciami.
        </p>
      ) : null}
      {bladQr === "2" ? (
        <p className="border-red/40 bg-red/10 text-red rounded-md border p-3 text-sm">
          Termin odbicia trenera musi mieścić się w oknie kodu - inaczej trener nie miałby czym
          odbić się na czas.
        </p>
      ) : null}

      <form
        action={saveClassQrSettingsAction}
        className="border-line bg-surface flex flex-col gap-4 rounded-md border p-4"
      >
        <div>
          <Label htmlFor="qrOpensMinutesBefore">Kod pojawia się przed zajęciami (minuty)</Label>
          <p className="text-muted-brand mt-0.5 text-sm">
            Wcześniej na ekranie nie ma czego skanować. Kod znika z końcem zajęć.
          </p>
          <div className="mt-2 flex items-center gap-2">
            <Input
              id="qrOpensMinutesBefore"
              name="qrOpensMinutesBefore"
              type="number"
              inputMode="numeric"
              min={1}
              max={120}
              step={1}
              required
              defaultValue={String(qrOpensMinutesBefore)}
              className="border-line bg-surface-2 max-w-28"
            />
            <span className="text-muted-brand font-mono text-xs tracking-widest uppercase">
              min
            </span>
          </div>
        </div>

        <div>
          <Label htmlFor="trainerCheckInMinutesBefore">
            Trener odbija się najpóźniej przed zajęciami (minuty)
          </Label>
          <p className="text-muted-brand mt-0.5 text-sm">
            Późniejsze odbicie nadal się zapisuje - inaczej zajęcia zostałyby bez śladu - ale jest
            oznaczone jako spóźnione. Brak odbicia po tym czasie trafia na Twój pulpit.
          </p>
          <div className="mt-2 flex items-center gap-2">
            <Input
              id="trainerCheckInMinutesBefore"
              name="trainerCheckInMinutesBefore"
              type="number"
              inputMode="numeric"
              min={0}
              max={60}
              step={1}
              required
              defaultValue={String(trainerCheckInMinutesBefore)}
              className="border-line bg-surface-2 max-w-28"
            />
            <span className="text-muted-brand font-mono text-xs tracking-widest uppercase">
              min
            </span>
          </div>
        </div>

        <p className="border-line bg-surface-2 text-muted-brand rounded-md border p-3 text-sm">
          Teraz obowiązuje: kod <b className="text-text">{qrOpensMinutesBefore} min</b> przed
          startem, trener najpóźniej <b className="text-text">{trainerCheckInMinutesBefore} min</b>{" "}
          przed.
        </p>

        <Button type="submit" className="self-start">
          Zapisz
        </Button>
      </form>
    </div>
  );
}
