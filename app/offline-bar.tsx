"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  autoSendable,
  countLabel,
  offlineSinceLabel,
  OP_LABEL,
  rejectedEntries,
} from "@/lib/domain/offline-queue";
import { checkNow } from "@/lib/offline/connection";
import { useConnection, useMinuteTick, useOfflineQueue } from "@/lib/offline/hooks";
import { applyOutcomes, discardOne, getEntries } from "@/lib/offline/queue";
import { Button } from "@/components/ui/button";
import { flushOfflineQueueAction } from "./offline-actions";

// Pas nad treścią. Ma trzy zadania i nigdy dwóch naraz:
//   brak łącza        → ostrzeżenie, że liczby na ekranie są sprzed zerwania,
//   łącze wróciło     → "wysyłam" i po chwili ile poszło,
//   baza odmówiła     → lista tego, co NIE weszło, z powodem i decyzją.
//
// Wysyłka rusza SAMA po powrocie łącza - taka jest decyzja klubu. Na sali nikt
// nie ma rąk do klikania w pasek, a odbicie, które czeka na czyjąś zgodę, jest
// w praktyce odbiciem, o którym się zapomina.
//
// To, co z tego zostaje jako zabezpieczenie: pozycja, której baza nie przyjęła,
// NIGDY nie znika po cichu. Zostaje na ekranie z powodem odmowy i czeka na
// człowieka. Automat jej nie ponawia - odmowa zwykle nie jest chwilowa, więc
// ponawianie oznaczałoby ten sam odrzucany zapis przy każdym pingu.

// Chwila zwłoki po powrocie łącza. Wifi klubu potrafi wrócić na sekundę i znów
// paść; bez tego wysyłka startowałaby w trakcie takiego migotania.
const OPOZNIENIE_MS = 1200;

// Odstępy po nieudanej próbie. Bez nich automat ponawiałby wysyłkę co 1,2 s
// w kółko: nieudany STRZAŁ (padło łącze, wygasła sesja) nie oznacza pozycji
// jako odrzuconych, więc dla automatu wciąż są do wysłania. Rosnące odstępy
// zamieniają to w kilka prób na minutę, a nie kilkadziesiąt.
const PONOWIENIA_MS = [5_000, 15_000, 60_000];

function odstepPo(nieudane: number): number {
  if (nieudane === 0) return OPOZNIENIE_MS;
  return PONOWIENIA_MS[Math.min(nieudane, PONOWIENIA_MS.length) - 1];
}

// Potwierdzenie udanej wysyłki gaśnie samo - nie jest nic warte po minucie,
// a pas nad treścią zabiera miejsce na ekranie tabletu.
const PODSUMOWANIE_MS = 12_000;

// Wysyłka jest jedna na przeglądarkę, choćby pas wisiał na dwóch ekranach
// naraz (panel i stacja w dwóch kartach). Bez tego ten sam zapis poszedłby
// dwa razy.
let wLocie = false;

const czasFormatter = new Intl.DateTimeFormat("pl-PL", {
  timeZone: "Europe/Warsaw",
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});

function czas(iso: string): string {
  const data = new Date(iso);
  return Number.isNaN(data.getTime()) ? "?" : czasFormatter.format(data);
}

type Podsumowanie = { ton: "ok" | "blad"; tekst: string };

export function OfflineBar() {
  const router = useRouter();
  const { mode, offlineSince } = useConnection();
  const entries = useOfflineQueue();
  const tick = useMinuteTick(mode === "offline");

  const [wysylka, setWysylka] = useState(false);
  const [podsumowanie, setPodsumowanie] = useState<Podsumowanie | null>(null);
  const zamontowany = useRef(true);
  // Nieudane próby z rzędu - sterują odstępem przed kolejną.
  const nieudanePodrzad = useRef(0);

  useEffect(() => {
    zamontowany.current = true;
    return () => {
      zamontowany.current = false;
    };
  }, []);

  const offline = mode === "offline";
  const doWyslania = autoSendable(entries);
  const odrzucone = rejectedEntries(entries);

  const wyslij = useCallback(
    async (zakres: "auto" | "wszystko") => {
      if (wLocie) return;
      wLocie = true;
      setWysylka(true);
      setPodsumowanie(null);

      // Kolejkę czytamy tuż przed wysyłką, a nie z migawki renderu: między
      // zaplanowaniem a startem mogło dojść kolejne odbicie z sali.
      const teraz = getEntries();
      const paczka = zakres === "auto" ? autoSendable(teraz) : teraz;

      if (paczka.length === 0) {
        wLocie = false;
        setWysylka(false);
        return;
      }

      try {
        const wyniki = await flushOfflineQueueAction(paczka);
        const zostaje = applyOutcomes(wyniki);
        const udane = wyniki.filter((w) => w.ok).length;
        const nieudane = wyniki.length - udane;

        if (zamontowany.current) {
          setPodsumowanie(
            nieudane === 0
              ? { ton: "ok", tekst: `Dopisano do bazy: ${countLabel(udane)}.` }
              : {
                  ton: "blad",
                  tekst:
                    `Dopisano ${udane}, baza nie przyjęła ${nieudane}. ` +
                    `Odrzucone zostają poniżej z powodem - zdecyduj, co z nimi.`,
                },
          );
        }
        nieudanePodrzad.current = 0;
        // Odświeżamy dopiero po naniesieniu wyników - ekran ma pokazać stan
        // po dopisaniu, nie sprzed niego.
        if (zostaje.length !== teraz.length) router.refresh();
      } catch {
        nieudanePodrzad.current += 1;
        // Najczęstszy powód: łącze padło w trakcie wysyłki. Kolejka zostaje
        // nietknięta, więc nic nie ginie. Drugi powód to wygasła sesja
        // i człowiek na sali nie ma jak ich rozróżnić - mówimy o obu.
        if (zamontowany.current) {
          setPodsumowanie({
            ton: "blad",
            tekst:
              "Nie udało się wysłać - nic nie przepadło, zapisy czekają dalej. " +
              "Sprawdź połączenie i zalogowanie; spróbuję ponownie po powrocie łącza.",
          });
        }
        void checkNow();
      } finally {
        wLocie = false;
        if (zamontowany.current) setWysylka(false);
      }
    },
    [router],
  );

  // Sedno tej zmiany: po powrocie łącza wysyłka rusza sama.
  //
  // Warunkiem jest potwierdzone `online` (czyli odpowiedź z /api/zdrowie),
  // a nie samo zdarzenie przeglądarki - wifi klubu bywa "jest", ale nie
  // przepuszcza ruchu, a wysyłka w taką dziurę tylko naliczyłaby odmowy.
  useEffect(() => {
    if (mode !== "online") {
      // Zerwane łącze zaczyna liczenie od nowa: po powrocie pierwsza próba ma
      // pójść od razu, a nie po minucie odstępu z poprzedniej awarii.
      nieudanePodrzad.current = 0;
      return;
    }
    if (doWyslania.length === 0 || wysylka) return;
    const id = window.setTimeout(() => void wyslij("auto"), odstepPo(nieudanePodrzad.current));
    return () => window.clearTimeout(id);
  }, [mode, doWyslania.length, wysylka, wyslij]);

  // Potwierdzenie udanej wysyłki znika samo; komunikat o odmowie zostaje,
  // dopóki człowiek nie ruszy odrzuconych pozycji.
  useEffect(() => {
    if (podsumowanie?.ton !== "ok") return;
    const id = window.setTimeout(() => setPodsumowanie(null), PODSUMOWANIE_MS);
    return () => window.clearTimeout(id);
  }, [podsumowanie]);

  function odrzuc() {
    const zgoda = window.confirm(
      `Zapisy odrzucone przez bazę (${countLabel(odrzucone.length)}) zostaną SKASOWANE ` +
        "i nie trafią do kartoteki. Tego nie da się cofnąć. Na pewno?",
    );
    if (!zgoda) return;
    for (const entry of odrzucone) discardOne(entry.id);
    setPodsumowanie(null);
  }

  if (!offline && entries.length === 0 && !podsumowanie) return null;

  // Kolor pasa idzie za tym, co wymaga uwagi: czerwony przy braku łącza
  // i przy odmowie bazy, zielony przy samym potwierdzeniu, bursztyn gdy
  // zapisy są w drodze.
  const ton =
    offline || odrzucone.length > 0 || podsumowanie?.ton === "blad"
      ? "red"
      : podsumowanie?.ton === "ok" && entries.length === 0
        ? "jade"
        : "amber";
  const ramka =
    ton === "red"
      ? "border-red bg-red/10"
      : ton === "jade"
        ? "border-jade bg-jade/10"
        : "border-amber bg-amber/10";

  return (
    <div role="status" aria-live="polite" className={`border-b ${ramka}`}>
      <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-2 px-4 py-2">
        {offline ? (
          <>
            <p className="text-text text-sm">
              <b className="text-red">
                Brak połączenia z bazą klubu
                {offlineSinceLabel(offlineSince, tick)
                  ? ` (${offlineSinceLabel(offlineSince, tick)})`
                  : ""}
                .
              </b>{" "}
              Ekran pokazuje dane sprzed zerwania łącza -{" "}
              <b>zapisy, karnety i grafik mogą się różnić</b> od tego, co jest w bazie. Odbicia i
              obecności rób dalej: czekają na tym urządzeniu
              {entries.length > 0 ? ` (już ${countLabel(entries.length)})` : ""} i{" "}
              <b>pójdą do bazy same</b>, gdy wróci sieć.
            </p>
            <div>
              <Button type="button" size="sm" variant="outline" onClick={() => void checkNow()}>
                Spróbuj połączyć
              </Button>
            </div>
          </>
        ) : (
          <>
            {doWyslania.length > 0 && (wysylka || podsumowanie?.ton !== "blad") ? (
              <p className="text-text text-sm">
                <b className="text-amber">
                  {wysylka
                    ? `Dopisuję do bazy: ${countLabel(doWyslania.length)}…`
                    : `Połączenie wróciło. Wysyłam ${countLabel(doWyslania.length)} zrobione bez łącza…`}
                </b>{" "}
                Nie musisz nic klikać.
              </p>
            ) : null}

            {odrzucone.length > 0 ? (
              <>
                <p className="text-text text-sm">
                  <b className="text-red">
                    Baza nie przyjęła {countLabel(odrzucone.length)} zrobionych bez łącza.
                  </b>{" "}
                  Nie ma ich w kartotece i same tam nie wejdą - zdecyduj, co dalej.
                </p>
                <ul className="flex flex-col gap-1">
                  {odrzucone.map((entry) => (
                    <li
                      key={entry.id}
                      className="border-line bg-surface flex flex-wrap items-center justify-between gap-2 rounded-md border px-2.5 py-1.5"
                    >
                      <span className="text-text min-w-0 text-sm">
                        <span className="text-muted-brand font-mono text-xs">
                          {czas(entry.recordedAtIso)}
                        </span>{" "}
                        · {OP_LABEL[entry.op]}
                        {entry.detail ? ` · ${entry.detail}` : ""}
                        <span className="text-red"> — {entry.error}</span>
                      </span>
                      <button
                        type="button"
                        onClick={() => discardOne(entry.id)}
                        className="text-muted-brand hover:text-red font-mono text-[10px] tracking-widest uppercase"
                      >
                        Odrzuć
                      </button>
                    </li>
                  ))}
                </ul>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => void wyslij("wszystko")}
                    disabled={wysylka}
                  >
                    {wysylka ? "Próbuję…" : "Spróbuj jeszcze raz"}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={odrzuc}
                    disabled={wysylka}
                  >
                    Odrzuć odrzucone
                  </Button>
                </div>
              </>
            ) : null}
          </>
        )}

        {podsumowanie ? (
          <p className={`text-sm ${podsumowanie.ton === "ok" ? "text-jade" : "text-text"}`}>
            {podsumowanie.tekst}
          </p>
        ) : null}
      </div>
    </div>
  );
}
