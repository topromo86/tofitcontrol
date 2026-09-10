import Image from "next/image";

// Logo klienta to PNG z czarnym napisem "CZAPLA BOXING". Na ciemnym tle napis
// znikał, więc w motywie ciemnym kładziemy je na jasnej podkładce zamiast
// kombinować z filtrami CSS (te zepsułyby czerwień z logo).
//
// Padding jest w obu motywach, żeby przełączenie nie przesuwało nagłówka.
// `shrink-0` jest KONIECZNE, odkad lewy blok naglowka moze sie zwezac:
// Tailwind ustawia obrazkom `max-width: 100%`, wiec bez tego to LOGO
// scisnaloby sie do zera zamiast przyciac imie obok.
export function BrandHeaderLogo() {
  return (
    <span className="inline-flex shrink-0 rounded-md px-1.5 py-1 dark:bg-white">
      <Image src="/logo.png" alt="Czapla Boxing" width={100} height={55} priority />
    </span>
  );
}
