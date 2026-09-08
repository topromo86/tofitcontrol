import "server-only";

// Autoryzacja zadań cyklicznych (Vercel Cron) - jedno miejsce dla wszystkich
// endpointów w app/api/cron/.
//
// Osobny plik nie dla porządku, tylko dlatego, że powtórzony warunek miał
// wadę. Każdy endpoint sprawdzał to sam:
//
//     if (authHeader !== `Bearer ${process.env.CRON_SECRET}`)
//
// Gdy zmienna nie jest ustawiona, `${undefined}` daje napis "undefined", więc
// warunek przepuszcza nagłówek `Bearer undefined` - napis, który każdy może
// wysłać. Jednocześnie prawdziwe wywołanie z Vercela (z sekretem) dostaje 401.
// To dokładna odwrotność tego, co ta linia ma robić: obcy wchodzi, właściciel
// nie - i to po cichu, bo zadania po prostu przestają się wykonywać.
//
// Zadania nie są niewinne: generują grafik, zamykają dzień kasowy, wysyłają
// przypomnienia do wszystkich klubowiczów i przeliczają wyniki trenerów, od
// których zależy premia. Dlatego brak sekretu oznacza odmowę dla wszystkich.

export function cronRequestAuthorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return request.headers.get("authorization") === `Bearer ${secret}`;
}
