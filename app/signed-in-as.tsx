// Kto jest teraz zalogowany - imię w kolorze marki, w tym samym miejscu
// nagłówka co etykieta panelu. Na sali i przy kasie z jednego urządzenia
// korzysta kilka osób, więc "kto to klika" musi być widoczne bez wchodzenia
// w ustawienia.
export function SignedInAs({ name, role }: { name?: string | null; role?: string }) {
  // Samo imię, nie pełne dane: w nagłówku liczy się rozpoznanie w ułamku
  // sekundy, a nazwisko tylko wydłuża pasek na telefonie.
  const firstName = name?.trim().split(/\s+/)[0] ?? null;

  return (
    // `min-w-0` i `truncate`: odkąd lewy blok nagłówka może się zwężać, to imię
    // ma ustąpić pierwsze - logo i kontrolki po prawej są ważniejsze niż pełne
    // brzmienie imienia, a i tak zwykle jest krótkie.
    <span className="flex min-w-0 items-baseline gap-2 font-mono text-xs tracking-widest uppercase">
      {role ? <span className="text-muted-brand hidden shrink-0 sm:inline">{role}</span> : null}
      {firstName ? (
        <span className="text-brand-red min-w-0 truncate font-bold">{firstName}</span>
      ) : null}
    </span>
  );
}
