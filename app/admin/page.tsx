import { Fragment } from "react";
import Link from "next/link";
import { Backpack, MoreHorizontal } from "lucide-react";
import type { Prisma } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { requireRole } from "@/lib/auth/guard";
import { MAX_FROZEN_DAYS, pilnosc, type Pilnosc } from "@/lib/domain/pass";
import { formatPhone } from "@/lib/domain/phone";
import { daysSince } from "@/lib/domain/retention";
import { resolveClassName } from "@/lib/domain/class-template";
import { WEEKDAY_LABELS } from "@/lib/domain/availability";
import {
  compareByClassThenName,
  groupAttendedClasses,
  mainClassName,
  type AttendedClass,
} from "@/lib/domain/member-classes";
import { formatDate } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SubmitButton } from "@/app/submit-button";
import { freezePassAction, unfreezePassAction } from "./actions";

type AdminSearchParams = {
  q?: string;
  sex?: string;
  minors?: string;
  zajecia?: string;
  sort?: string;
};

// Ile klientów pokazujemy naraz. Przy grupowaniu po zajęciach bierzemy więcej,
// bo grupa rozbita na dwie strony przestaje być grupą.
const LIST_LIMIT = 50;
const GROUPED_LIMIT = 300;

// Kolumny definiowane RAZ - i razem z odstępem oraz paddingiem, bo to one
// przesuwają oś. Nagłówek kolumn i wiersz biorą ten sam łańcuch; dwa osobne
// rozjadą się przy pierwszej zmianie szerokości, a wyrównanie kolumn jest
// całym powodem tego układu: data z trzeciego wiersza ma stać dokładnie pod
// datą z czterdziestego, inaczej listy nie da się przelecieć wzrokiem.
//
// Łańcucha nie wolno sklejać z fragmentów - Tailwind skanuje źródła
// statycznie (ta sama zasada co w lib/domain/class-color.ts).
//
// Siatka włącza się dopiero od lg: przy 768 px na nazwisko zostałyby 44 px.
const GRID_COLS = "gap-x-3 px-3 lg:grid-cols-[minmax(0,1fr)_11rem_10rem_4.5rem_10.5rem]";

// Kropka zapala się WYŁĄCZNIE przy problemie.
//
// Gdyby aktywny karnet świecił na zielono, kolor miałoby 80% wierszy i sygnałem
// stałby się jego BRAK - oko musiałoby łapać dziurę zamiast plamy. Cisza dotyczy
// jednak samego KOLORU: data końca stoi w kolumnie tekstem zawsze.
const KROPKA: Record<Pilnosc, string> = {
  BRAK: "bg-red",
  KONCZY_SIE: "bg-amber",
  ZAMROZONY: "bg-transparent",
  OK: "bg-transparent",
};

// Ton tekstu bierze się z tej samej klasyfikacji co kropka, więc nie ma jak się
// z nią rozjechać. Zamrożony jest stonowany, nie czerwony - to opłacony karnet.
const TON: Record<Pilnosc, string> = {
  BRAK: "text-red",
  KONCZY_SIE: "text-amber",
  ZAMROZONY: "text-muted-brand",
  OK: "text-muted-brand",
};

// Pozycja menu wiersza - ten sam łańcuch co menu kafelka w grafiku
// (app/admin/zajecia/tydzien/week-grid.tsx).
const menuItem =
  "text-text hover:text-brand-red hover:bg-surface-2 block w-full rounded px-2 py-1.5 text-left text-xs";

const selectClass =
  "border-line bg-surface-2 text-text h-11 w-full min-w-0 rounded-md border px-2 text-base sm:h-8 md:text-sm";

// Filtr zajęć w adresie: "k:<id>" to rodzaj (Kids Boxing), "t:<id>" konkretne
// zajęcia cykliczne (Kids Boxing, wtorek 17:00, Tychy).
function parseClassFilter(raw: string | undefined): { kind: "k" | "t"; id: string } | null {
  if (!raw) return null;
  const [kind, ...rest] = raw.split(":");
  const id = rest.join(":");
  return (kind === "k" || kind === "t") && id ? { kind, id } : null;
}

function buildHref(current: AdminSearchParams, overrides: Partial<AdminSearchParams>): string {
  const merged = { ...current, ...overrides };
  const params = new URLSearchParams();
  if (merged.q) params.set("q", merged.q);
  if (merged.sex) params.set("sex", merged.sex);
  if (merged.minors) params.set("minors", merged.minors);
  if (merged.zajecia) params.set("zajecia", merged.zajecia);
  if (merged.sort) params.set("sort", merged.sort);
  const query = params.toString();
  return query ? `/admin?${query}` : "/admin";
}

export default async function AdminMembersPage({
  searchParams,
}: {
  searchParams: Promise<AdminSearchParams>;
}) {
  // Strażnik na samej stronie, nie tylko w layoucie: layout nie przelicza się
  // przy nawigacji po stronie klienta, a to jest ekran z kartoteką klubu.
  await requireRole("ADMIN");

  const params = await searchParams;
  const { q, sex, minors, zajecia, sort } = params;

  const classFilter = parseClassFilter(zajecia);
  const groupByClass = sort === "zajecia";
  // Ile zawężeń schowanych pod "Filtry" jest czynnych. Bez tego licznika
  // zawężona lista wygląda dokładnie jak pełna kartoteka.
  const aktywnychFiltrow = [sex, minors, zajecia, sort].filter(Boolean).length;

  const where: Prisma.MemberWhereInput = {
    AND: [
      q
        ? {
            OR: [
              { firstName: { contains: q, mode: "insensitive" as const } },
              { lastName: { contains: q, mode: "insensitive" as const } },
              { user: { email: { contains: q, mode: "insensitive" as const } } },
            ],
          }
        : {},
      sex === "MALE" || sex === "FEMALE" ? { sex } : {},
      minors === "1" ? { isMinor: true } : {},
      // Chodzi na te zajęcia = ma na nie choć jeden nieodwołany zapis.
      classFilter
        ? {
            bookings: {
              some: {
                status: { not: "CANCELLED" as const },
                session:
                  classFilter.kind === "k"
                    ? { categoryId: classFilter.id }
                    : { templateId: classFilter.id },
              },
            },
          }
        : {},
    ],
  };

  const [members, total, categories, templates] = await Promise.all([
    prisma.member.findMany({
      where,
      include: {
        // endsAt rosnąco i DWA karnety, nie jeden malejąco: klub sprzedaje
        // osobno karnet grupowy i indywidualny, więc klient potrafi mieć oba
        // naraz. Branie tego z dalszą datą pokazywało spokojny wiersz, choć
        // grupowy wygasł wczoraj - i po cichu podstawiało JEGO plan pod
        // "Przedłuż".
        passes: {
          where: { status: { in: ["ACTIVE", "FROZEN"] } },
          orderBy: { endsAt: "asc" },
          take: 2,
        },
        // Numer telefonu żyje na koncie (User.phone) - kartoteka nie ma
        // własnego pola. Gdy klubowicz nie ma konta (dziecko, klient dopisany
        // ręcznie), kontaktem jest rodzic.
        user: { select: { phone: true } },
        guardianUser: { select: { phone: true } },
        attendances: { orderBy: { checkedInAt: "desc" }, take: 1, select: { checkedInAt: true } },
      },
      orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
      take: groupByClass ? GROUPED_LIMIT : LIST_LIMIT,
    }),
    prisma.member.count({ where }),
    prisma.classCategory.findMany({
      where: { active: true },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    }),
    prisma.classTemplate.findMany({
      where: { active: true },
      include: { category: true, location: true },
      orderBy: [{ weekday: "asc" }, { startTime: "asc" }],
    }),
  ]);

  // Zapisy ciągniemy WYŁĄCZNIE przy grupowaniu po zajęciach - tylko tam są do
  // czegoś potrzebne (nazwa grupy i kolejność). Wcześniej to zapytanie szło
  // przy każdym wejściu na kartotekę, po wszystkie nieodwołane zapisy
  // widocznych osób, żeby narysować odznaki, które sam kod nazywał ozdobnikiem.
  const visits =
    groupByClass && members.length > 0
      ? await prisma.booking.findMany({
          where: { memberId: { in: members.map((m) => m.id) }, status: { not: "CANCELLED" } },
          select: {
            memberId: true,
            session: { select: { name: true, category: { select: { name: true } } } },
          },
        })
      : [];

  const attended = groupAttendedClasses(
    visits.map((v) => ({
      memberId: v.memberId,
      // Rodzaj, nie nazwa pojedynczych zajęć: "Kids Boxing" w Tychach i w
      // Mikołowie to dla właściciela jedna grupa.
      className: v.session.category?.name ?? v.session.name,
    })),
  );

  const rows = members.map((m) => {
    const classes: AttendedClass[] = attended.get(m.id) ?? [];
    return { ...m, classes, mainClass: mainClassName(classes) };
  });
  if (groupByClass) rows.sort(compareByClassThenName);

  const now = new Date();
  // Adres bieżącej listy - wraca się na niego po zamrożeniu karnetu, zamiast
  // lądować na górze nieprzefiltrowanej kartoteki.
  const powrot = buildHref(params, {});

  return (
    <div className="flex flex-col gap-3">
      <h1 className="font-display text-brand-red text-xl tracking-wide sm:text-2xl">Kartoteka</h1>

      {/* JEDEN formularz zamiast dwóch. Wcześniej były dwa, z ośmioma ukrytymi
          polami przepisującymi sobie nawzajem stan, który i tak w całości
          siedzi w adresie, i z dwoma przyciskami wysyłki robiącymi to samo.
          Przyklejony u góry, bo przy pięćdziesięciu wierszach wyszukiwarka jest
          jedyną drogą do człowieka spoza pierwszej pięćdziesiątki - i nie może
          wymagać powrotu na samą górę. */}
      <form className="bg-ink sticky top-0 z-20 -mx-4 flex flex-col gap-2 px-4 py-2">
        <div className="flex gap-2">
          <Input
            name="q"
            defaultValue={q}
            placeholder="Szukaj: imię, nazwisko, e-mail…"
            className="border-line bg-surface-2 h-11 sm:h-8"
          />
          <Button type="submit" variant="outline" className="h-11 shrink-0 sm:h-8">
            Szukaj
          </Button>
        </div>

        {/* Zawężenia pod jednym rozwinięciem - wcześniej zajmowały osobny rząd
            czterech przycisków plus rząd z listą zajęć, czyli na telefonie
            ponad połowę pierwszego ekranu, zanim pokazał się pierwszy człowiek.
            `open` przy czynnym filtrze jest zabezpieczeniem, nie ozdobą:
            zawężona lista nie ma jak udawać pełnej kartoteki. */}
        <details open={aktywnychFiltrow > 0} className="border-line bg-surface rounded-md border">
          <summary className="text-text flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 px-3 font-mono text-xs tracking-widest uppercase [&::-webkit-details-marker]:hidden">
            <span>Filtry{aktywnychFiltrow > 0 ? ` (${aktywnychFiltrow})` : ""}</span>
            <span className="text-muted-brand tabular-nums">
              {rows.length === total ? total : `${rows.length} z ${total}`}
            </span>
          </summary>

          <div className="border-line-soft grid gap-2 border-t p-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1">
              <span className="text-muted-brand font-mono text-[10px] tracking-widest uppercase">
                Zajęcia
              </span>
              {/* w-full min-w-0 to naprawa, nie upiększenie: bez nich select
                  mierzy się najdłuższą opcją ("Gentleman Boxing · Poniedziałek
                  19:00 · Mikołów") i sam przewijał stronę w bok na telefonie.
                  text-base do md z tego samego powodu co w polu szukania:
                  poniżej 16 px Safari na iOS powiększa stronę przy dotknięciu. */}
              <select name="zajecia" defaultValue={zajecia ?? ""} className={selectClass}>
                <option value="">Wszystkie</option>
                <optgroup label="Rodzaj">
                  {categories.map((category) => (
                    <option key={category.id} value={`k:${category.id}`}>
                      {category.name}
                    </option>
                  ))}
                </optgroup>
                <optgroup label="Konkretne zajęcia">
                  {templates.map((template) => (
                    <option key={template.id} value={`t:${template.id}`}>
                      {resolveClassName(template.name, template.category?.name ?? "Zajęcia")} ·{" "}
                      {WEEKDAY_LABELS[template.weekday]} {template.startTime} ·{" "}
                      {template.location.name}
                    </option>
                  ))}
                </optgroup>
              </select>
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-muted-brand font-mono text-[10px] tracking-widest uppercase">
                Płeć
              </span>
              <select name="sex" defaultValue={sex ?? ""} className={selectClass}>
                <option value="">Wszyscy</option>
                <option value="FEMALE">Kobieta</option>
                <option value="MALE">Mężczyzna</option>
              </select>
            </label>

            <label className="text-text flex min-h-11 items-center gap-2 text-sm">
              <input
                type="checkbox"
                name="minors"
                value="1"
                defaultChecked={minors === "1"}
                className="accent-brand-red size-4"
              />
              Tylko nieletni
            </label>

            <label className="text-text flex min-h-11 items-center gap-2 text-sm">
              <input
                type="checkbox"
                name="sort"
                value="zajecia"
                defaultChecked={groupByClass}
                className="accent-brand-red size-4"
              />
              Grupuj po zajęciach
            </label>

            <div className="flex items-center gap-2 sm:col-span-2">
              <Button type="submit" className="h-11 flex-1 sm:h-8 sm:flex-none">
                Pokaż
              </Button>
              {/* Jedno wyjście z wszystkich zawężeń naraz. Wcześniej każdy
                  przełącznik gasiło się osobno, a pola szukania nie dało się
                  wyczyścić wcale. */}
              <Link
                href="/admin"
                className="text-muted-brand hover:text-brand-red flex h-11 items-center px-2 font-mono text-xs tracking-widest uppercase sm:h-8"
              >
                Wyczyść
              </Link>
            </div>
          </div>
        </details>
      </form>

      {/* Lista jest JEDNĄ kartą z separatorami, a nie pięćdziesięcioma kartami
          z ramkami. Wcześniej na każdego człowieka szło 34 px samego chromu
          (ramka + padding + odstęp) - przy pełnej stronie prawie 1700 px
          zjedzone przez obwódki.
          Bez overflow-hidden, choć zaokrąglenie o nie prosi: menu ostatniego
          wiersza musi mieć jak wyjść poza kartę. */}
      <div className="border-line bg-surface rounded-md border">
        {/* Nagłówek kolumn pozwala skrócić treść komórki do "do 21 lip 2026"
            bez utraty sensu - bez niego data musiałaby nieść własną etykietę
            w każdym wierszu, czyli powtarzać to samo słowo pięćdziesiąt razy.
            Poniżej lg nie ma go wcale, bo nie ma też kolumn. */}
        <div
          className={`text-muted-brand border-line-soft hidden border-b py-1.5 font-mono text-[10px] tracking-widest uppercase lg:grid lg:items-center ${GRID_COLS}`}
        >
          <span>Klubowicz</span>
          <span>Karnet</span>
          <span>Telefon</span>
          <span className="text-right">Ostatnio</span>
          <span>Akcje</span>
        </div>

        <ul className="divide-line-soft divide-y">
          {rows.map((m, index) => {
            const pass = m.passes[0] ?? null;
            const stan = pilnosc(m.passes, now);
            const startsGroup = groupByClass && rows[index - 1]?.mainClass !== m.mainClass;

            const telefonWlasny = m.user?.phone ?? null;
            const telefon = telefonWlasny ?? m.guardianUser?.phone ?? null;
            const dni = daysSince(m.attendances[0]?.checkedInAt ?? null, now);

            const tekstKarnetu =
              stan === "ZAMROZONY"
                ? `zamrożony do ${formatDate(pass!.endsAt)}`
                : pass
                  ? `do ${formatDate(pass.endsAt)}`
                  : "brak karnetu";

            return (
              <Fragment key={m.id}>
                {startsGroup ? (
                  // Nagłówek grupy jest osobnym elementem listy, a nie <p> we
                  // wnętrzu `li` z display:contents. Tamto gubiło semantykę
                  // listy i dawało podwójny odstęp, przez który nagłówek
                  // z odległości czytało się jak wiersz klienta.
                  <li className="bg-surface-2 text-muted-brand border-line-soft border-b px-3 py-1 font-mono text-[10px] tracking-widest uppercase">
                    {m.mainClass}
                  </li>
                ) : null}

                <li
                  className={`hover:bg-surface-2 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-y-0.5 py-1 transition-colors lg:min-h-9 lg:gap-y-0 ${GRID_COLS}`}
                >
                  {/* --- 1. KTO ------------------------------------------- */}
                  <div className="flex min-w-0 items-center gap-2">
                    {/* Kropka jest PIERWSZYM elementem wiersza, więc na obu
                        układach stoi w tej samej osi - z odległości widać
                        kolumnę czerwonych i bursztynowych znaczników bez
                        czytania liter. Świadomie kropka, a nie pasek 4 px
                        z lewej: ta forma znaczy w tej aplikacji "rodzaj zajęć"
                        (stripeClass) i nie wolno jej obciążać drugim sensem.
                        Kropka nigdy nie jest jedynym nośnikiem - obok stoi
                        tekst, bo w jasnej sali i przy daltonizmie sam kolor nie
                        mówi nic. */}
                    <span aria-hidden className={`size-2 shrink-0 rounded-full ${KROPKA[stan]}`} />

                    {/* Wejściem do karty jest całe wolne pole linii nazwiska,
                        a nie kwadrat ikony obok nieklikalnego napisu.
                        Bez ujemnych marginesów: wypchnęłyby pole dotyku poza
                        wiersz i kciuk otwierałby kartę sąsiada. */}
                    <Link
                      href={`/admin/klienci/${m.id}`}
                      aria-label={`Karta klienta: ${m.lastName} ${m.firstName}`}
                      className="text-text hover:text-brand-red flex min-h-11 min-w-0 flex-1 items-center gap-1.5 lg:min-h-0"
                    >
                      {/* Odznaka demo PRZED nazwiskiem: ucinanie działa od
                          końca, więc postawiona za nazwiskiem znikałaby
                          pierwsza - a to ona ma powstrzymać telefon do klienta,
                          którego nie ma. */}
                      {m.isDemo ? (
                        <span className="border-amber text-amber shrink-0 rounded border px-1 py-0.5 font-mono text-[10px] tracking-widest uppercase">
                          demo
                        </span>
                      ) : null}
                      {/* Nazwisko przed imieniem, bo lista jest po nazwisku -
                          dopiero wtedy alfabet stoi w jednej osi. */}
                      <span className="min-w-0 truncate font-medium">
                        {m.lastName} {m.firstName}
                      </span>
                      {/* Piktogram zamiast napisu "dziecko": czyta się jednym
                          spojrzeniem i nie zjada szerokości nazwiska, a to ono
                          jest na tej liście najważniejsze.
                          Barwa z palety RODZAJÓW ZAJĘĆ (cat-*), która celowo
                          nie niesie znaczenia statusu - czerwień, bursztyn
                          i jadeit są w tym wierszu zarezerwowane dla karnetu
                          i nie wolno ich użyć do czegokolwiek innego.
                          Ikona nigdy nie stoi sama: ma `aria-label` dla
                          czytnika ekranu i `title` z powodem, dla którego ten
                          znacznik w ogóle jest - do dziecka dzwoni się do
                          rodzica. */}
                      {m.isMinor ? (
                        <span
                          title="Dziecko - kontaktem jest rodzic"
                          className="text-cat-sky shrink-0"
                        >
                          <Backpack role="img" aria-label="Dziecko" className="size-4" />
                        </span>
                      ) : null}
                    </Link>
                  </div>

                  {/* --- 2-4. Na telefonie jedna linia pod nazwiskiem, od lg
                      trzy kolumny siatki. `lg:contents` rozpuszcza ten
                      pojemnik, więc te same dane stoją w kodzie RAZ i dwa
                      układy nie mają jak rozjechać się treścią.
                      Temu pojemnikowi nie wolno dać tła ani ramki - od lg
                      znikną bez śladu i bez błędu.
                      Kolejność sztywna i bez zawijania: zawinięcie podnosiłoby
                      wysokość wiersza zależnie od długości numeru, czyli
                      wracałby brak rytmu, po który ten układ powstał.
                      Na telefonie linia idzie pod SPODEM przycisków, przez całą
                      szerokość wiersza - przy połowie szerokości data karnetu
                      ucinała się akurat tam, gdzie tekst jest najdłuższy:
                      przy karnecie zamrożonym i przy dziecku z numerem rodzica,
                      czyli w wierszach, w których data znaczy najwięcej. */}
                  <div className="col-span-2 col-start-1 flex min-w-0 items-center gap-x-2 overflow-hidden lg:contents">
                    {/* Stan karnetu zawsze słowem i datą. To on się ucina na
                        wąskim ekranie, nie numer - ucięty numer jest
                        bezużyteczny, a ucięte "zamrożony do 21 li…" nadal
                        niesie słowo "zamrożony". */}
                    <p className={`min-w-0 truncate font-mono text-xs tabular-nums ${TON[stan]}`}>
                      {tekstKarnetu}
                    </p>

                    {/* Telefon jako odsyłacz `tel:` - drugi co do częstości
                        powód wejścia na ten ekran, a wcześniej nie było go
                        w wierszu wcale i numer trzeba było szukać w karcie. */}
                    <p className="text-muted-brand shrink-0 font-mono text-xs tabular-nums">
                      {telefon ? (
                        <a href={`tel:${telefon}`} className="hover:text-brand-red">
                          {formatPhone(telefon)}
                          {telefonWlasny ? "" : " (rodzic)"}
                        </a>
                      ) : (
                        "brak numeru"
                      )}
                    </p>

                    {/* Ostatnia obecność. Zawsze wyciszona, nigdy bursztynowa -
                        bursztyn w tym wierszu ma znaczyć dokładnie jedno:
                        karnet się kończy. Poniżej sm ukryta, bo trzy dane na
                        szerokości telefonu się nie mieszczą. */}
                    <p className="text-muted-brand hidden shrink-0 font-mono text-xs tabular-nums sm:block lg:text-right">
                      {dni === null
                        ? "—"
                        : dni === 0
                          ? "dziś"
                          : dni === 1
                            ? "wczoraj"
                            : `${dni} dni`}
                    </p>
                  </div>

                  {/* --- 5. AKCJE ---------------------------------------- */}
                  <div className="col-start-2 row-start-1 flex shrink-0 items-center justify-end gap-2 lg:col-auto lg:row-auto lg:justify-start">
                    {/* Jedyne wyjście na pieniądze prowadzi tam, gdzie żyją
                        reguły sprzedaży - do jedynego formularza, z ustawionym
                        klientem. Stylowany odsyłacz, nie przycisk w odsyłaczu.
                        "Przedłuż" i "Sprzedaj" mają po osiem znaków, więc
                        krawędź stoi w każdym wierszu w tym samym miejscu. */}
                    <Link
                      href={
                        pass
                          ? `/admin/wplaty?klient=${m.id}&plan=${pass.planId}`
                          : `/admin/wplaty?klient=${m.id}`
                      }
                      aria-label={`${pass ? "Przedłuż" : "Sprzedaj"} karnet: ${m.lastName} ${m.firstName}`}
                      className="border-line bg-surface-2 text-text hover:text-brand-red flex h-11 shrink-0 items-center rounded-md border px-3 font-mono text-xs whitespace-nowrap uppercase lg:h-7"
                    >
                      {pass ? "Przedłuż" : "Sprzedaj"}
                    </Link>

                    {/* Menu bez grama JS - ten sam wzorzec co menu kafelka
                        w grafiku. `name` zamyka poprzednio otwarte. */}
                    <details name="wiersz-klubowicza" className="relative shrink-0">
                      <summary
                        aria-label={`Więcej działań: ${m.lastName} ${m.firstName}`}
                        className="text-muted-brand hover:text-brand-red flex size-11 cursor-pointer list-none items-center justify-center rounded-md lg:size-7 [&::-webkit-details-marker]:hidden"
                      >
                        <MoreHorizontal className="size-4" />
                      </summary>

                      <div className="border-line bg-surface absolute top-full right-0 z-50 mt-1 flex w-52 flex-col gap-0.5 rounded-md border p-1 shadow-lg">
                        {/* Druga, jawna droga do karty - dla kogoś, kto nie
                            odgadnie, że nazwisko jest odsyłaczem. */}
                        <Link href={`/admin/klienci/${m.id}`} className={menuItem}>
                          Karta klienta
                        </Link>

                        {/* Wcześniej pełnowymiarowy przycisk obok "Przedłuż",
                            prowadzący pod dokładnie ten sam adres, tylko bez
                            podstawionego planu. */}
                        {pass ? (
                          <Link href={`/admin/wplaty?klient=${m.id}`} className={menuItem}>
                            Inny karnet
                          </Link>
                        ) : null}

                        {/* Zamrożenie schodzi z widocznego wiersza świadomie:
                            odmrożenie dopisuje co najmniej jeden dzień do
                            limitu trzydziestu i nie ma ekranu, który by to
                            cofnął. Wcześniej stało osiem pikseli od przycisku
                            od pieniędzy. */}
                        {pass && pass.status === "FROZEN" ? (
                          <form action={unfreezePassAction}>
                            <input type="hidden" name="passId" value={pass.id} />
                            {/* Bez tego akcja wracała twardo na "/admin"
                                i kasowała szukanie, filtry oraz pozycję
                                przewinięcia. */}
                            <input type="hidden" name="powrot" value={powrot} />
                            <SubmitButton
                              variant="ghost"
                              pendingLabel="Odmrażam…"
                              className="h-auto w-full justify-start rounded px-2 py-1.5 text-left text-xs font-normal"
                            >
                              Odmroź karnet
                            </SubmitButton>
                          </form>
                        ) : pass && pass.frozenDaysUsed < MAX_FROZEN_DAYS ? (
                          <form action={freezePassAction}>
                            <input type="hidden" name="passId" value={pass.id} />
                            <input type="hidden" name="powrot" value={powrot} />
                            {/* Licznik dni pojawia się w chwili decyzji,
                                zamiast wisieć w każdym wierszu listy. */}
                            <SubmitButton
                              variant="ghost"
                              pendingLabel="Zamrażam…"
                              className="h-auto w-full justify-start rounded px-2 py-1.5 text-left text-xs font-normal"
                            >
                              Zamroź karnet ({MAX_FROZEN_DAYS - pass.frozenDaysUsed} dni)
                            </SubmitButton>
                          </form>
                        ) : null}
                      </div>
                    </details>
                  </div>
                </li>
              </Fragment>
            );
          })}

          {rows.length === 0 ? (
            <li className="text-muted-brand p-3 text-sm">Brak wyników.</li>
          ) : null}
        </ul>
      </div>
    </div>
  );
}
