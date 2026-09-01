import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { assignCategoryColors } from "@/lib/domain/class-color";
import { effectiveTrainerId } from "@/lib/domain/substitute";
import {
  publicScheduleDays,
  toPublicScheduleSession,
  type PublicScheduleSession,
} from "@/lib/domain/public-schedule";

// Harmonogram zajęć dla strony klubu (czaplaboxing.pl) - bez logowania.
//
//   GET /api/publiczny/harmonogram?dni=14
//
// Endpoint jest publiczny z założenia: to ta sama informacja, którą klub
// wywiesza na drzwiach. Dlatego nie ma tu żadnej autoryzacji, ale za to
// twardo ograniczony zakres danych - patrz lib/domain/public-schedule.ts,
// gdzie kształt odpowiedzi jest wypisany polem po polu.
//
// Nie wychodzi stąd nic o klientach: ani nazwiska, ani liczba zapisanych.
// Na zewnątrz idzie wyłącznie liczba WOLNYCH miejsc, bo bez niej odsyłacz
// "zapisz się" na komplet byłby ślepym zaułkiem.

// Odpowiedź czyta skrypt na cudzej domenie, więc bez CORS przeglądarka ją
// zablokuje. Gwiazdka, a nie lista domen: dane są publiczne, endpoint nie
// czyta ciasteczek ani nagłówka Authorization, więc nie ma czego chronić
// pochodzeniem żądania - a lista domen cicho psułaby się przy każdej zmianie
// adresu strony klubu.
const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-max-age": "86400",
} as const;

// Grafik zmienia się rzadko, liczba wolnych miejsc częściej. Pięć minut na
// brzegu Vercela to kompromis: strona klubu nie wali w bazę przy każdej
// odsłonie, a "zostały 2 miejsca" nie kłamie o godzinę.
const CACHE_HEADER = "public, s-maxage=300, stale-while-revalidate=600";

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const days = publicScheduleDays(url.searchParams.get("dni"));

  const now = new Date();
  const until = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

  const sessions = await prisma.session.findMany({
    where: {
      // Treningi indywidualne powstają dopiero w chwili zapisu konkretnej
      // osoby, więc pokazanie ich na stronie oznaczałoby wywieszenie czyjegoś
      // prywatnego terminu. Na zewnątrz idą tylko zajęcia grupowe.
      kind: "GROUP",
      status: "SCHEDULED",
      startsAt: { gte: now, lt: until },
      // Sala pokazowa nie istnieje, a ten adres czyta strona klubu bez
      // logowania. Zajęcia demonstracyjne na czaplaboxing.pl to zaproszenie
      // obcych ludzi na trening, którego nie ma - i zapis, który im się uda,
      // bo /zapis/[sessionId] jest publiczny.
      location: { isDemo: false },
    },
    orderBy: { startsAt: "asc" },
    include: {
      location: { select: { name: true } },
      category: { select: { name: true } },
      trainer: { select: { id: true, user: { select: { name: true } } } },
      substituteTrainer: { select: { id: true, user: { select: { name: true } } } },
      bookings: { select: { status: true } },
    },
  });

  // Kolory rodzajów liczone dla PEŁNEJ listy kategorii, dokładnie jak na
  // grafiku w panelu - inaczej ten sam rodzaj miałby na stronie inny kolor
  // niż w systemie, a to jest jeden klub i jeden grafik.
  const categories = await prisma.classCategory.findMany({
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
  });
  const categoryColors = assignCategoryColors(categories);

  const items: PublicScheduleSession[] = sessions.map((session) => {
    // Zastępstwo liczy się dopiero po akceptacji - jedyna definicja "kto
    // realnie prowadzi" siedzi w lib/domain/substitute.ts.
    const leadsSubstitute = effectiveTrainerId(session) === session.substituteTrainerId;
    const trainerName =
      (leadsSubstitute ? session.substituteTrainer?.user.name : session.trainer.user.name) ??
      session.trainer.user.name ??
      "";

    return toPublicScheduleSession({
      id: session.id,
      name: session.name,
      startsAt: session.startsAt,
      endsAt: session.endsAt,
      capacity: session.capacity,
      categoryName: session.category?.name ?? null,
      categoryColor: session.categoryId
        ? (categoryColors.get(session.categoryId)?.key ?? null)
        : null,
      locationName: session.location.name,
      trainerName,
      bookedCount: session.bookings.filter((b) => b.status === "BOOKED").length,
    });
  });

  // Lokalizacje oddajemy osobno, żeby strona klubu mogła zbudować filtr
  // "Mikołów / Tychy" nawet wtedy, gdy w danym oknie akurat nie ma zajęć
  // w jednej z sal.
  const locations = await prisma.location.findMany({
    orderBy: { name: "asc" },
    select: { name: true },
  });

  return NextResponse.json(
    {
      generatedAt: now.toISOString(),
      days,
      locations: locations.map((l) => l.name),
      sessions: items,
    },
    { headers: { ...CORS_HEADERS, "cache-control": CACHE_HEADER } },
  );
}
