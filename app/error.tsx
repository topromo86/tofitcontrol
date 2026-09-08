"use client";

import Link from "next/link";

// Awaria wewnątrz aplikacji: zapytanie do bazy, które nie przeszło, wyjątek
// ze strażnika (ForbiddenError), błąd akcji serwerowej.
//
// Bez tego pliku każda taka sytuacja kończyła się surowym ekranem Next.js
// ("Application error: a server-side exception has occurred") - po angielsku,
// bez wyjścia i bez śladu, że to normalna odmowa dostępu, a nie awaria.
// Najboleśniej na sali: trener z telefonem w ręku widział białą stronę
// i nie miał czego kliknąć.
//
// Treść jest celowo ogólna. Na produkcji Next nie przekazuje tutaj komunikatu
// błędu (zostaje sam `digest`), więc nie da się rozróżnić "nie masz dostępu"
// od "baza nie odpowiedziała" - a zgadywanie byłoby gorsze niż nie zgadywać.

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="flex min-h-full flex-1 items-center justify-center p-6">
      <div className="border-red/40 bg-red/5 flex max-w-md flex-col gap-3 rounded-md border p-6">
        <p className="text-red font-mono text-xs tracking-widest uppercase">Coś poszło nie tak</p>
        <h1 className="font-display text-brand-red text-2xl tracking-wide">
          Nie udało się otworzyć tego ekranu
        </h1>
        <p className="text-muted-brand text-sm">
          Albo baza klubu chwilowo nie odpowiada, albo to miejsce nie jest dostępne dla Twojego
          konta. Spróbuj jeszcze raz - jeśli to się powtarza, powiedz Danielowi.
        </p>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={reset}
            className="bg-brand-red rounded-md px-3 py-1.5 font-mono text-xs tracking-widest text-white uppercase"
          >
            Spróbuj ponownie
          </button>
          <Link
            href="/"
            className="border-line text-text hover:bg-surface-soft rounded-md border px-3 py-1.5 font-mono text-xs tracking-widest uppercase"
          >
            Wróć na start
          </Link>
        </div>
        {/* Numer zgłoszenia - jedyne, co Next wypuszcza na produkcji. Bez niego
            "coś nie działa" jest nie do odszukania w logach Vercela. */}
        {error.digest ? (
          <p className="text-muted-brand font-mono text-[0.65rem] tracking-widest uppercase">
            Numer zgłoszenia: {error.digest}
          </p>
        ) : null}
      </div>
    </main>
  );
}
