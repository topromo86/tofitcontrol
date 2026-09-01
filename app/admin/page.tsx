import Link from "next/link";
import { Eye } from "lucide-react";
import type { Prisma } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { classifyPassStatus, MAX_FROZEN_DAYS } from "@/lib/domain/pass";
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

const selectClass = "border-line bg-surface-2 text-text rounded-md border px-2 py-2 text-sm";

export default async function AdminMembersPage({
  searchParams,
}: {
  searchParams: Promise<AdminSearchParams>;
}) {
  const params = await searchParams;
  const { q, sex, minors, zajecia, sort } = params;

  const classFilter = parseClassFilter(zajecia);
  const groupByClass = sort === "zajecia";

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
        passes: {
          where: { status: { in: ["ACTIVE", "FROZEN"] } },
          orderBy: { endsAt: "desc" },
          take: 1,
        },
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

  // Na jakie zajęcia chodzą ci konkretni klienci. Zliczamy tylko dla widocznej
  // strony - kartoteka klubu może urosnąć, a to i tak jest ozdobnik listy.
  const visits =
    members.length > 0
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
  const STATUS_STYLE: Record<string, string> = {
    NONE: "text-red",
    EXPIRING_SOON: "text-amber",
    ACTIVE: "text-jade",
  };

  return (
    <div className="flex flex-col gap-4">
      <form className="flex gap-2">
        {sex ? <input type="hidden" name="sex" value={sex} /> : null}
        {minors ? <input type="hidden" name="minors" value={minors} /> : null}
        {zajecia ? <input type="hidden" name="zajecia" value={zajecia} /> : null}
        {sort ? <input type="hidden" name="sort" value={sort} /> : null}
        <Input
          name="q"
          defaultValue={q}
          placeholder="Szukaj klienta po imieniu, nazwisku lub e-mailu..."
          className="border-line bg-surface-2"
        />
        <Button type="submit" variant="outline">
          Szukaj
        </Button>
      </form>

      {/* Zajęcia jako osobny formularz GET: wybór z listy od razu przeładowuje
          kartotekę, bez klikania "Szukaj". */}
      <form className="flex flex-wrap items-center gap-2">
        {q ? <input type="hidden" name="q" value={q} /> : null}
        {sex ? <input type="hidden" name="sex" value={sex} /> : null}
        {minors ? <input type="hidden" name="minors" value={minors} /> : null}
        {sort ? <input type="hidden" name="sort" value={sort} /> : null}

        <label htmlFor="zajecia" className="text-muted-brand font-mono text-xs uppercase">
          Zajęcia
        </label>
        <select id="zajecia" name="zajecia" defaultValue={zajecia ?? ""} className={selectClass}>
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
                {WEEKDAY_LABELS[template.weekday]} {template.startTime} · {template.location.name}
              </option>
            ))}
          </optgroup>
        </select>
        <Button type="submit" variant="outline" size="sm">
          Pokaż
        </Button>
      </form>

      <div className="flex flex-wrap gap-2">
        <Link href={buildHref(params, { sex: sex === "FEMALE" ? undefined : "FEMALE" })}>
          <Button type="button" variant={sex === "FEMALE" ? "default" : "outline"} size="sm">
            Kobieta
          </Button>
        </Link>
        <Link href={buildHref(params, { sex: sex === "MALE" ? undefined : "MALE" })}>
          <Button type="button" variant={sex === "MALE" ? "default" : "outline"} size="sm">
            Mężczyzna
          </Button>
        </Link>
        <Link href={buildHref(params, { minors: minors === "1" ? undefined : "1" })}>
          <Button type="button" variant={minors === "1" ? "default" : "outline"} size="sm">
            Nieletni
          </Button>
        </Link>
        <Link href={buildHref(params, { sort: groupByClass ? undefined : "zajecia" })}>
          <Button type="button" variant={groupByClass ? "default" : "outline"} size="sm">
            Grupuj po zajęciach
          </Button>
        </Link>
      </div>

      <p className="text-muted-brand text-xs">
        Sprzedaż karnetu wykonuje trener na ekranie Kasa - tutaj tylko podgląd, edycja i zamrożenie.
        {rows.length < total ? ` Pokazano ${rows.length} z ${total} klientów.` : ""}
      </p>

      <ul className="flex flex-col gap-2">
        {rows.map((m, index) => {
          const activePass = m.passes[0];
          const isFrozen = activePass?.status === "FROZEN";
          const badge = classifyPassStatus(!isFrozen ? (activePass ?? null) : null, now);
          const startsGroup = groupByClass && rows[index - 1]?.mainClass !== m.mainClass;

          return (
            <li key={m.id} className="contents">
              {startsGroup ? (
                <p className="text-brand-red mt-2 font-mono text-xs tracking-widest uppercase">
                  {m.mainClass}
                </p>
              ) : null}
              <div className="border-line bg-surface flex flex-wrap items-center justify-between gap-2 rounded-md border p-3">
                <div className="flex items-center gap-2">
                  <Link
                    href={`/admin/klienci/${m.id}`}
                    aria-label={`Podgląd karty klienta ${m.firstName} ${m.lastName}`}
                  >
                    <Button
                      type="button"
                      variant="outline"
                      size="icon-lg"
                      className="size-11 shrink-0"
                    >
                      <Eye className="size-5" />
                    </Button>
                  </Link>
                  <div>
                    <p className="text-text font-medium">
                      {m.firstName} {m.lastName}
                      {m.isMinor ? " (dziecko)" : ""}
                      {/* Kartoteka demonstracyjna ma być rozpoznawalna na liście,
                          a nie dopiero po wejściu w kartę - inaczej ktoś zadzwoni
                          do klienta, którego nie ma. */}
                      {m.isDemo ? (
                        <span className="border-amber text-amber ml-2 rounded border px-1.5 py-0.5 font-mono text-[10px] tracking-widest uppercase">
                          demo
                        </span>
                      ) : null}
                    </p>
                    {isFrozen ? (
                      <p className="text-muted-brand font-mono text-xs">
                        Zamrożony (do {formatDate(activePass!.endsAt)}, wykorzystano{" "}
                        {activePass!.frozenDaysUsed}/{MAX_FROZEN_DAYS} dni)
                      </p>
                    ) : (
                      <p className={`font-mono text-xs ${STATUS_STYLE[badge]}`}>
                        {activePass
                          ? `Aktywny karnet do ${formatDate(activePass.endsAt)}`
                          : "Brak aktywnego karnetu"}
                      </p>
                    )}
                    {/* Na co chodzi - od najczęstszych. Widać od razu, kto
                        trzyma się jednej grupy, a kto krąży po wszystkim. */}
                    {m.classes.length > 0 ? (
                      <p className="mt-1 flex flex-wrap gap-1">
                        {m.classes.slice(0, 3).map((c) => (
                          <span
                            key={c.name}
                            className="border-line-soft bg-surface-2 text-muted-brand rounded border px-1.5 py-0.5 font-mono text-[11px]"
                          >
                            {c.name} ×{c.visits}
                          </span>
                        ))}
                      </p>
                    ) : null}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {isFrozen ? (
                    <form action={unfreezePassAction}>
                      <input type="hidden" name="passId" value={activePass!.id} />
                      <Button type="submit" size="sm" variant="outline">
                        Odmroź
                      </Button>
                    </form>
                  ) : activePass && activePass.frozenDaysUsed < MAX_FROZEN_DAYS ? (
                    <form action={freezePassAction}>
                      <input type="hidden" name="passId" value={activePass.id} />
                      <Button type="submit" size="sm" variant="outline">
                        Zamroź
                      </Button>
                    </form>
                  ) : null}
                </div>
              </div>
            </li>
          );
        })}
        {rows.length === 0 ? <li className="text-muted-brand text-sm">Brak wyników.</li> : null}
      </ul>
    </div>
  );
}
