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

  return (
    <button
      type="button"
      onClick={() => void checkNow()}
      title={title}
      aria-live="polite"
      className={cn(
        "flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-1.5 font-mono text-[10px] tracking-widest whitespace-nowrap uppercase",
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
        <CloudOff className="size-3.5" />
      ) : mode === "online" ? (
        <Cloud className="size-3.5" />
      ) : (
        <RefreshCw className="size-3.5" />
      )}
      {/* Na telefonie sama ikona - dopóki wszystko działa. Gdy łącze padnie
          albo coś czeka w kolejce, napis wchodzi na każdej szerokości: to jest
          dokładnie ta chwila, w której nikt nie będzie się domyślał z ikonki. */}
      <span className={offline || czeka > 0 ? "inline" : "hidden sm:inline"}>{label}</span>
    </button>
  );
}
