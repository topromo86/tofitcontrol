"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ChevronDown, Menu } from "lucide-react";
import { cn } from "@/lib/utils";

export type HeaderNavItem = { href: string; label: string; badge?: number };

// Grupa z jedną pozycją renderuje się jako zwykły link - najczęściej używane
// ekrany zostają na jedno kliknięcie, a nie chowają się pod rozwijaniem.
// `mobileOnly` wchodzi WYLACZNIE do menu pod hamburgerem, nie do poziomego
// rzedu. Sluzy pozycjom, ktore na szerokim ekranie sa juz dostepne inaczej -
// dzis jest to przejscie miedzy panelem wlasciciela a trenera, bo od `md` stoi
// na nie osobny przelacznik w naglowku. Bez tego rozroznienia ta sama droga
// zajmowalaby miejsce dwa razy, a poziomy rzad rosl az do wypchniecia strony
// w bok na laptopie (zmierzone: 1299 px przy oknie 1280 px).
export type HeaderNavGroup = { label: string; items: HeaderNavItem[]; mobileOnly?: boolean };

// Najbardziej dopasowany (najdłuższy) href spośród tych, które są prefiksem
// aktualnej ścieżki - unika sytuacji, w której dwa zagnieżdżone linki
// (np. "/admin" i "/admin/finanse") są podświetlone jednocześnie.
function findActiveHref(pathname: string, hrefs: string[]): string | undefined {
  const matches = hrefs.filter((href) => pathname === href || pathname.startsWith(`${href}/`));
  if (matches.length === 0) return undefined;
  return matches.reduce((longest, href) => (href.length > longest.length ? href : longest));
}

function groupBadge(group: HeaderNavGroup): number | undefined {
  const total = group.items.reduce((sum, item) => sum + (item.badge ?? 0), 0);
  return total > 0 ? total : undefined;
}

function Badge({ value }: { value: number }) {
  return <span className="bg-red ml-1 rounded-full px-1.5 py-0.5 text-white">{value}</span>;
}

// Nawigacja nagłówka pogrupowana tematycznie: maksymalnie dwa kliknięcia do
// dowolnego ekranu (grupa → pozycja), a na wąskich ekranach hamburger →
// pozycja. Grupowanie wzięło się stąd, że panel właściciela urósł do
// kilkunastu pozycji i płaski rząd przestawał się mieścić.
//
// Próg `lg` (a nie `xl` jak przy płaskiej liście): sześć grup zajmuje mniej
// więcej połowę tego, co zajmowało dwanaście osobnych linków, więc pełny rząd
// mieści się już na laptopie.
//
// Na wąskich ekranach panel pokazuje WSZYSTKIE grupy naraz jako sekcje z
// nagłówkami - świadomie bez zagnieżdżonych rozwijań, bo te robiłyby z tego
// trzy kliknięcia.
export function HeaderNav({ groups }: { groups: HeaderNavGroup[] }) {
  const pathname = usePathname();
  const allHrefs = groups.flatMap((group) => group.items.map((item) => item.href));
  const activeHref = findActiveHref(pathname, allHrefs);

  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const desktopNavRef = useRef<HTMLElement>(null);
  const mobileRef = useRef<HTMLDetailsElement>(null);

  // Nawigacja w Next.js jest po stronie klienta (layout zostaje zamontowany),
  // więc menu samo się nie zamknie - zamykamy je na zmianę ścieżki, inaczej
  // rozwinięta lista zasłania ekran aż do "odklikania".
  //
  // Reset rozwiniętej grupy robimy w trakcie renderu (wzorzec z docs Reacta),
  // a nie w efekcie - to nie wywołuje kaskadowych renderów.
  const [lastPathname, setLastPathname] = useState(pathname);
  if (pathname !== lastPathname) {
    setLastPathname(pathname);
    setOpenGroup(null);
  }

  // Zamknięcie mobilnego <details> to aktualizacja DOM (systemu zewnętrznego) -
  // to zostaje w efekcie i jest jedyną rzeczą, jaką on tu robi.
  useEffect(() => {
    if (mobileRef.current) mobileRef.current.open = false;
  }, [pathname]);

  // Kliknięcie poza menu i Escape zamykają rozwiniętą grupę - bez tego
  // dropdown zostaje otwarty i przykrywa treść.
  useEffect(() => {
    if (openGroup === null) return;

    function onPointerDown(event: MouseEvent) {
      if (!desktopNavRef.current?.contains(event.target as Node)) setOpenGroup(null);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpenGroup(null);
    }

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [openGroup]);

  return (
    <>
      <nav
        ref={desktopNavRef}
        className="hidden min-w-0 items-center gap-4 font-mono text-xs tracking-widest uppercase lg:flex"
      >
        {groups
          .filter((group) => !group.mobileOnly)
          .map((group) => {
            const single = group.items.length === 1 ? group.items[0] : null;
            const groupIsActive = group.items.some((item) => item.href === activeHref);
            const badge = groupBadge(group);

            if (single) {
              return (
                <Link
                  key={group.label}
                  href={single.href}
                  className={cn(
                    "text-text hover:text-brand-red shrink-0 whitespace-nowrap",
                    groupIsActive && "font-bold",
                  )}
                >
                  {single.label}
                  {single.badge ? <Badge value={single.badge} /> : null}
                </Link>
              );
            }

            const isOpen = openGroup === group.label;
            return (
              <div key={group.label} className="relative shrink-0">
                <button
                  type="button"
                  aria-expanded={isOpen}
                  onClick={() => setOpenGroup(isOpen ? null : group.label)}
                  className={cn(
                    "text-text hover:text-brand-red flex items-center gap-1 whitespace-nowrap uppercase",
                    groupIsActive && "font-bold",
                  )}
                >
                  {group.label}
                  {badge ? <Badge value={badge} /> : null}
                  <ChevronDown
                    className={cn("size-3 transition-transform", isOpen && "rotate-180")}
                  />
                </button>

                {isOpen ? (
                  <div className="border-line bg-surface absolute top-full left-0 z-50 mt-2 flex w-52 flex-col gap-1 rounded-md border p-2 shadow-lg">
                    {group.items.map((item) => (
                      <Link
                        key={item.href}
                        href={item.href}
                        className={cn(
                          "text-text hover:text-brand-red hover:bg-surface-2 rounded-md px-3 py-2",
                          item.href === activeHref && "font-bold",
                        )}
                      >
                        {item.label}
                        {item.badge ? <Badge value={item.badge} /> : null}
                      </Link>
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })}
      </nav>

      <details ref={mobileRef} className="relative lg:hidden">
        <summary
          aria-label="Menu"
          className="border-line bg-surface-2 flex size-11 cursor-pointer list-none items-center justify-center rounded-md border [&::-webkit-details-marker]:hidden"
        >
          <Menu className="size-5" />
        </summary>
        <nav className="border-line bg-surface absolute top-full right-0 z-50 mt-2 flex max-h-[70vh] w-64 flex-col gap-3 overflow-y-auto rounded-md border p-3 font-mono text-xs tracking-widest uppercase shadow-lg">
          {groups.map((group) => (
            <div key={group.label} className="flex flex-col gap-1">
              {group.items.length > 1 ? (
                <p className="text-muted-brand px-1 text-[10px]">{group.label}</p>
              ) : null}
              {group.items.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    "text-text hover:text-brand-red hover:bg-surface-2 rounded-md px-3 py-2.5",
                    item.href === activeHref && "font-bold",
                  )}
                >
                  {item.label}
                  {item.badge ? <Badge value={item.badge} /> : null}
                </Link>
              ))}
            </div>
          ))}
        </nav>
      </details>
    </>
  );
}
