"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { countLabel, offlineSinceLabel, OP_LABEL } from "@/lib/domain/offline-queue";
import { checkNow } from "@/lib/offline/connection";
import { useConnection, useMinuteTick, useOfflineQueue } from "@/lib/offline/hooks";
import { applyOutcomes, discardAll, discardOne } from "@/lib/offline/queue";
import { Button } from "@/components/ui/button";
import { flushOfflineQueueAction } from "./offline-actions";

// Pas nad treścią. Ma dwa zadania i nigdy obu naraz:
//   brak łącza      → ostrzeżenie, że liczby na ekranie są sprzed zerwania,
//   łącze + kolejka → lista zapisów zrobionych bez sieci do zatwierdzenia.
//
// Lista, a nie automat. Zapisy dopisywane wstecz to godziny obecności, wejścia
// z karnetów i liczby, po których liczy się wynagrodzenie - ktoś ma je
// zobaczyć, zanim wejdą do rozliczeń. Ta sama decyzja co w toPROductive,
// z tego samego powodu.

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

export function OfflineBar() {
  const router = useRouter();
  const { mode, offlineSince } = useConnection();
  const entries = useOfflineQueue();
  const tick = useMinuteTick(mode === "offline");

  const [wysylka, setWysylka] = useState(false);
  const [podsumowanie, setPodsumowanie] = useState<string | null>(null);

  const offline = mode === "offline";
  const czeka = entries.length;

  if (!offline && czeka === 0) return null;

  async function dopisz() {
    setWysylka(true);
    setPodsumowanie(null);
    try {
      const wyniki = await flushOfflineQueueAction(entries);
      const zostaje = applyOutcomes(wyniki);
      const udane = wyniki.filter((w) => w.ok).length;
      setPodsumowanie(
        zostaje.length === 0
          ? `Dopisano do bazy: ${countLabel(udane)}.`
          : `Dopisano ${udane}, nie udało się ${zostaje.length} - zostają na liście z powodem odmowy.`,
      );
      router.refresh();
    } catch {
      // Najczęstszy powód: łącze padło w trakcie wysyłki. Kolejka zostaje
      // nietknięta, więc nic nie ginie - wystarczy spróbować ponownie.
      // Zapisy zostają na liście, cokolwiek się stało - to jest najważniejsze
      // zdanie tego komponentu. Powody bywają dwa (padło łącze albo wygasła
      // sesja) i człowiek na sali nie ma jak ich rozróżnić, więc mówimy o obu.
      setPodsumowanie(
        "Nie udało się wysłać - nic nie przepadło, zapisy zostają na liście. Sprawdź połączenie i zalogowanie, potem spróbuj ponownie.",
      );
      void checkNow();
    } finally {
      setWysylka(false);
    }
  }

  function odrzuc() {
    const zgoda = window.confirm(
      `Zapisy zrobione bez łącza (${countLabel(czeka)}) zostaną SKASOWANE i nie trafią do bazy klubu. ` +
        "Tego nie da się cofnąć. Na pewno?",
    );
    if (!zgoda) return;
    discardAll();
    setPodsumowanie(null);
  }

  return (
    <div
      role="status"
      className={`border-b ${offline ? "border-red bg-red/10" : "border-amber bg-amber/10"}`}
    >
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
              obecności możesz robić dalej: czekają na tym urządzeniu
              {czeka > 0 ? ` (już ${countLabel(czeka)})` : ""} i dopiszesz je po powrocie sieci.
            </p>
            <div>
              <Button type="button" size="sm" variant="outline" onClick={() => void checkNow()}>
                Spróbuj połączyć
              </Button>
            </div>
          </>
        ) : (
          <>
            <p className="text-text text-sm">
              {/* Dopóki ping nie wrócił, nie ogłaszamy powrotu łącza - przez tę
                  sekundę nie wiemy jeszcze, czy baza odpowiada. */}
              <b className="text-amber">
                {mode === "online"
                  ? `Połączenie wróciło. ${countLabel(czeka)} zrobiono bez łącza`
                  : `${countLabel(czeka)} czeka na dopisanie do bazy`}
              </b>{" "}
              - nie ma ich jeszcze w bazie klubu. Sprawdź listę i zdecyduj, czy dopisać.
            </p>
            <ul className="flex flex-col gap-1">
              {entries.map((entry) => (
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
                    {entry.error ? (
                      <span className="text-red"> — nie udało się: {entry.error}</span>
                    ) : null}
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
              <Button type="button" size="sm" onClick={() => void dopisz()} disabled={wysylka}>
                {wysylka ? "Dopisuję…" : "Dopisz do bazy"}
              </Button>
              <Button type="button" size="sm" variant="outline" onClick={odrzuc} disabled={wysylka}>
                Odrzuć wszystkie
              </Button>
            </div>
          </>
        )}

        {podsumowanie ? <p className="text-muted-brand text-sm">{podsumowanie}</p> : null}
      </div>
    </div>
  );
}
