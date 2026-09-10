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
        // Napis wchodzi dopiero od `md`, a nie od razu przy awarii.
        // Na telefonie rozdmuchiwal naglowek z 36 px do ponad 200 px
        // i wypychal strone w bok DOKLADNIE w chwili, gdy padlo wifi -
        // czyli wtedy, gdy panel jest najbardziej potrzebny.
        // Nic przez to nie ginie: pelny komunikat ("Brak polaczenia z baza
        // klubu", czas od zerwania, kolejka) stoi w pasie OfflineBar tuz nad
        // trescia, a przycisk niesie go w `aria-label` i `title`.
        // Prog to `md`, nie `sm`: przy 640 px naglowek z napisem nadal
        // wypycha strone.
        zNapisem
          ? "size-9 md:h-auto md:w-auto md:gap-1.5 md:px-2 md:py-1.5 lg:size-9 lg:gap-0 lg:p-0 2xl:h-auto 2xl:w-auto 2xl:gap-1.5 2xl:px-2 2xl:py-1.5"
          : "size-9",
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
        <CloudOff className={zNapisem ? "size-4 md:size-3.5 lg:size-4 2xl:size-3.5" : "size-4"} />
      ) : mode === "online" ? (
        <Cloud className={zNapisem ? "size-4 md:size-3.5 lg:size-4 2xl:size-3.5" : "size-4"} />
      ) : (
        <RefreshCw className={zNapisem ? "size-4 md:size-3.5 lg:size-4 2xl:size-3.5" : "size-4"} />
      )}
      {/* Napis pojawia sie TAM, GDZIE JEST NA NIEGO MIEJSCE, a nie wszedzie
          powyzej jednego progu. Miedzy `lg` a `xl` naglowek rozwija poziome
          menu na cala szerokosc i wtedy napis znow wypychal strone (zmierzone:
          1299 px przy oknie 1280 px). Wraca dopiero od `2xl`, gdzie mieszcza sie
          oba. Ponizej `md` nie ma go z tego samego powodu co na telefonie:
          pelny komunikat i tak stoi w pasie OfflineBar nad trescia. */}
      {zNapisem ? <span className="hidden md:inline lg:hidden 2xl:inline">{label}</span> : null}
    </button>
  );
}
