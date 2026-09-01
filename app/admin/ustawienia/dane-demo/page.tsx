import { requireRole } from "@/lib/auth/guard";
import { Button } from "@/components/ui/button";
import { formatDayTime } from "@/lib/format";
import { blockerMessage, recordCountLabel } from "@/lib/domain/demo-data";
import { demoBlockers, demoStatus } from "@/lib/services/demo-data";
import { loadDemoDataAction, removeDemoDataAction } from "./actions";

// Ekran wgrania i usunięcia danych demonstracyjnych.
//
// Zbudowany jak "próba na sucho" ze skryptów w prisma/ (reset-cennik.ts):
// najpierw WYPISUJE, co jest albo co powstanie, a dopiero pod tym pokazuje
// przycisk. Operacja dotyka bazy klubu hurtowo, więc człowiek ma zobaczyć
// liczby, zanim cokolwiek kliknie.

export default async function DemoDataPage({
  searchParams,
}: {
  searchParams: Promise<{ wgrano?: string; usunieto?: string; blad?: string }>;
}) {
  await requireRole("ADMIN");
  const { wgrano, usunieto, blad } = await searchParams;

  const stan = await demoStatus();
  const przeszkody = stan.present ? await demoBlockers() : [];

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <div>
        <h1 className="font-display text-brand-red text-2xl tracking-wide">Dane demonstracyjne</h1>
        <p className="text-muted-brand mt-1 text-sm">
          Wypełniają system tak, jak wygląda klub po roku pracy: sala pokazowa, trzech trenerów,
          kartoteka z historią obecności, karnety, wpłaty, oceny i alerty retencyjne. Wszystko po
          to, żeby dało się pokazać, co system potrafi, bez wpisywania czegokolwiek ręcznie.
        </p>
      </div>

      {wgrano ? (
        <p className="border-jade/40 bg-jade/10 text-text rounded-md border p-3 text-sm">
          Wgrano dane demonstracyjne: <b>{recordCountLabel(Number(wgrano))}</b>. Zajrzyj na pulpit,
          do kartoteki i na grafik - wszystko oznaczone jako <b>[DEMO]</b>.
        </p>
      ) : null}
      {usunieto ? (
        <p className="border-jade/40 bg-jade/10 text-text rounded-md border p-3 text-sm">
          Usunięto dane demonstracyjne: <b>{recordCountLabel(Number(usunieto))}</b>. Sprawdziłem po
          fakcie - w bazie nie został po nich żaden ślad.
        </p>
      ) : null}
      {blad ? (
        <p className="border-red/40 bg-red/10 text-red rounded-md border p-3 text-sm">{blad}</p>
      ) : null}

      <section className="border-line bg-surface flex flex-col gap-4 rounded-md border p-4">
        <h2 className="font-mono text-xs tracking-widest uppercase">Stan</h2>

        {stan.present ? (
          <>
            <p className="text-text text-sm">
              W bazie są dane demonstracyjne: <b>{recordCountLabel(stan.total)}</b>, wgrane{" "}
              {stan.loadedAt ? formatDayTime(stan.loadedAt) : "kiedyś"}.
            </p>
            <ul className="border-line-soft divide-line-soft divide-y rounded-md border">
              {stan.summary.map((linia) => (
                <li key={linia.model} className="flex justify-between gap-4 px-3 py-1.5 text-sm">
                  <span className="text-text">{linia.label}</span>
                  <span className="text-muted-brand font-mono tabular-nums">{linia.count}</span>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="text-text text-sm">
            W bazie nie ma danych demonstracyjnych. Klub widzi wyłącznie swoje dane.
          </p>
        )}
      </section>

      {stan.present ? (
        <section className="border-red/40 bg-red/5 flex flex-col gap-4 rounded-md border p-4">
          <h2 className="text-red font-mono text-xs tracking-widest uppercase">
            Usunięcie danych demonstracyjnych
          </h2>

          {przeszkody.length > 0 ? (
            <p className="border-red/40 bg-red/10 text-red rounded-md border p-3 text-sm">
              {blockerMessage(przeszkody)}
            </p>
          ) : (
            <p className="text-muted-brand text-sm">
              Zniknie dokładnie to, co jest na liście powyżej - usuwanie idzie po spisie
              identyfikatorów zapisanym przy wgrywaniu, a nie po nazwiskach czy datach. Danych klubu
              to nie dotyka. Sprawdziłem też, że nic prawdziwego nie doczepiło się do sali pokazowej
              ani do zajęć demonstracyjnych.
            </p>
          )}

          <form action={removeDemoDataAction} className="flex flex-col gap-3">
            <label className="text-text flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                name="potwierdzam"
                value="tak"
                required
                className="accent-brand-red mt-1 size-4"
              />
              <span>
                Rozumiem, że tych danych nie da się przywrócić. Po usunięciu trzeba je wgrać od
                nowa, a nowe będą wyglądały inaczej.
              </span>
            </label>
            <div>
              <Button type="submit" disabled={przeszkody.length > 0}>
                Usuń dane demonstracyjne
              </Button>
            </div>
          </form>
        </section>
      ) : (
        <section className="border-line bg-surface flex flex-col gap-4 rounded-md border p-4">
          <h2 className="font-mono text-xs tracking-widest uppercase">Wgranie</h2>

          <div className="text-muted-brand flex flex-col gap-2 text-sm">
            <p>Powstanie osobny, samodzielny klub pokazowy:</p>
            <ul className="ml-4 list-disc space-y-1">
              <li>
                <b className="text-text">własna sala</b> „[DEMO] Sala pokazowa” i własny cennik -
                nic nie dokleja się do Tychów ani Mikołowa,
              </li>
              <li>
                <b className="text-text">trzech trenerów demonstracyjnych</b> - konta bez hasła,
                więc nikt się nimi nie zaloguje; realnym trenerom nie podniesie to wypłaty ani
                wyniku,
              </li>
              <li>
                <b className="text-text">24 kartoteki</b> z historią: obecności, karnety, wpłaty
                (nigdy gotówką - kasa klubu zostaje nietknięta), oceny, notatki, alerty retencyjne i
                kilka odejść z ankietą.
              </li>
            </ul>
            <p>
              Zajęcia demonstracyjne <b className="text-text">nie trafią</b> na harmonogram na
              stronie klubu, a powiadomienia i nocne joby omijają konta demonstracyjne.
            </p>
          </div>

          <form action={loadDemoDataAction} className="flex flex-col gap-3">
            <label className="text-text flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                name="potwierdzam"
                value="tak"
                required
                className="accent-brand-red mt-1 size-4"
              />
              <span>
                Wiem, że dane demonstracyjne pojawią się na pulpicie, w kartotece i w statystykach
                klubu - do czasu, aż je usunę.
              </span>
            </label>
            <div>
              <Button type="submit">Wgraj dane demonstracyjne</Button>
            </div>
          </form>
        </section>
      )}
    </div>
  );
}
