import Link from "next/link";

// Adres, którego nie ma. Bez tego pliku Next pokazuje własny ekran po
// angielsku ("404 - This page could not be found") - w systemie, który w
// całości mówi po polsku, i najczęściej człowiekowi, który trafił tu ze
// starego kodu QR albo z odsyłacza sprzed zmiany grafiku.
//
// Wołają to też strony kartotek (`notFound()` w /admin/klienci/[memberId],
// /trainer/podopieczni/[memberId], /leady/[leadId] i kilku innych), więc ten
// ekran ma mówić "nie ma czegoś takiego", a nie "coś się zepsuło".

export default function NotFound() {
  return (
    <main className="flex min-h-full flex-1 items-center justify-center p-6">
      <div className="border-line bg-surface flex max-w-md flex-col gap-3 rounded-md border p-6">
        <p className="text-muted-brand font-mono text-xs tracking-widest uppercase">Błąd 404</p>
        <h1 className="font-display text-brand-red text-2xl tracking-wide">Nie ma takiej strony</h1>
        <p className="text-muted-brand text-sm">
          Adres jest nieaktualny albo w nim literówka. Jeśli trafiłeś tu z kodu QR ze ściany, kod
          mógł zostać wymieniony - zeskanuj aktualny.
        </p>
        <div>
          <Link
            href="/"
            className="border-line text-text hover:bg-surface-soft inline-block rounded-md border px-3 py-1.5 font-mono text-xs tracking-widest uppercase"
          >
            Wróć na start
          </Link>
        </div>
      </div>
    </main>
  );
}
