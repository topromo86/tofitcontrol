"use client";

import { Cloud, CloudOff, RefreshCw } from "lucide-react";
import { countLabel, offlineSinceLabel } from "@/lib/domain/offline-queue";
import { checkNow } from "@/lib/offline/connection";
import { useConnection, useMinuteTick, useOfflineQueue } from "@/lib/offline/hooks";
import { cn } from "@/lib/utils";

// Wskaźnik połączenia z bazą - w pasku górnym, a nie w ustawieniach.
//
// Człowiek na sali ma widzieć BEZ KLIKANIA, czy to, co właśnie zapisał, poszło
// do bazy. Wskaźnik schowany w ustawieniach nie odpowiada na to pytanie, bo
// nikt tam nie zagląda w trakcie zajęć.
//
// Trzy stany, trzy kolory:
//   zielony  - baza odpowiada, zapisy idą od razu,
//   pomarańcz - baza odpowiada, a kolejka offline właśnie do niej jedzie,
//   czerwony - brak kontaktu z bazą, zapisy czekają na urządzeniu.
export function ConnectionBadge({ className }: { className?: string }) {
  const { mode, offlineSince } = useConnection();
  const entries = useOfflineQueue();
  const tick = useMinuteTick(mode === "offline");
  const czeka = entries.length;

  const offline = mode === "offline";
  const czekaOpis = czeka > 0 ? countLabel(czeka) : "";

  const label = offline
    ? ["OFFLINE", offlineSinceLabel(offlineSince, tick), czekaOpis].filter(Boolean).join(" · ")
    : mode === "online"
      ? czeka > 0
        ? `Online · ${czekaOpis} w kolejce`
        : "Online · baza"
      : "Sprawdzam łącze…";

  const title = offline
    ? "Brak kontaktu z bazą. Odbicia i obecności zapisują się na tym urządzeniu i pójdą do bazy same, gdy wróci sieć. Kliknij, żeby spróbować połączyć się ponownie."
    : mode === "online"
      ? czeka > 0
        ? "Baza odpowiada, a zapisy zrobione bez łącza właśnie do niej jadą. Szczegóły w pasku nad treścią."
        : "Zapisy idą prosto do bazy klubu. Kliknij, żeby sprawdzić połączenie."
      : "Sprawdzam, czy baza odpowiada.";

  // Napis wchodzi WYŁĄCZNIE wtedy, gdy coś jest nie tak: łącze padło albo
  // zapisy czekają w kolejce. Dopóki wszystko działa, zostaje sam kwadracik
  // z chmurką.
  //
  // Powód jest z laptopa właściciela: przy stanie "wszystko gra" napis
  // "Online · baza" zajmował około 90 px i poziome menu nagłówka nachodziło na
  // niego przy szerokościach laptopowych. Wskaźnik, na który wjeżdża menu,
  // przestaje być wskaźnikiem.
  //
  // Zielony kwadracik nie musi nic mówić: on informuje, że NIE MA problemu.
  // Odwrotnie jest przy awarii - tam sama ikonka byłaby zgadywanką, więc napis
  // wraca na każdej szerokości, razem z czasem od zerwania i liczbą zapisów
  // w kolejce.
  const zNapisem = offline || czeka > 0;

  return (
    <button
      type="button"
      onClick={() => void checkNow()}
      title={title}
      // Bez tego przycisk w stanie "wszystko gra" nie ma ŻADNEJ nazwy dla
      // czytnika ekranu: `display: none` na napisie zdejmuje go także z drzewa
      // dostępności, a `title` jest tylko podpowiedzią myszy.
      aria-label={label}
      aria-live="polite"
      className={cn(
        "flex shrink-0 items-center justify-center rounded-md border font-mono text-[10px] tracking-widest whitespace-nowrap uppercase",
        // Kwadrat równy przełącznikowi motywu obok - inaczej w nagłówku stoją
        // dwa prawie równe klocki i widać, że nie są równe.
        zNapisem ? "gap-1.5 px-2 py-1.5" : "size-9",
        offline
          ? "border-red text-red bg-red/10"
          : mode === "online"
            ? czeka > 0
              ? "border-amber text-amber bg-amber/10"
              : "border-jade/50 text-jade bg-jade/5"
            : "border-line text-muted-brand bg-surface-2",
        className,
      )}
    >
      {offline ? (
        <CloudOff className={zNapisem ? "size-3.5" : "size-4"} />
      ) : mode === "online" ? (
        <Cloud className={zNapisem ? "size-3.5" : "size-4"} />
      ) : (
        <RefreshCw className={zNapisem ? "size-3.5" : "size-4"} />
      )}
      {zNapisem ? <span>{label}</span> : null}
    </button>
  );
}
