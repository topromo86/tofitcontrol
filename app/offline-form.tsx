"use client";

import { useState } from "react";
import type { OfflineOp } from "@/lib/domain/offline-queue";
import { isNetworkError, isOffline, reportError, reportSuccess } from "@/lib/offline/connection";
import { enqueue } from "@/lib/offline/queue";

// Formularz, który przeżywa brak sieci.
//
// Zwykły `<form action={akcjaSerwerowa}>` bez łącza kończy się błędem fetcha
// i zapis przepada - a na sali to znaczy "obecność, której nikt nie zapisał".
// Ten komponent robi dokładnie jedną rzecz więcej: gdy strzał do serwera nie
// ma jak dojść, odkłada zapis w kolejce na urządzeniu i mówi o tym wprost.
//
// Kolejność jest ważna. NAJPIERW próbujemy zapisać normalnie (chyba że już
// wiemy, że łącza nie ma) - dzięki temu nieaktualny wskaźnik "online" nie
// wysyła zapisu w próżnię, a nieaktualny "offline" nie odkłada bez potrzeby
// czegoś, co poszłoby od razu. Do kolejki trafia wyłącznie błąd SIECI; odmowa
// serwera (brak uprawnień, zła liczba) leci dalej, bo to nie jest problem
// łącza i kolejka niczego by tu nie naprawiła.
export function OfflineForm({
  action,
  op,
  detail,
  fields,
  className,
  offlineLabel = "Zapisane na urządzeniu - pójdzie do bazy po powrocie sieci",
  children,
}: {
  action: (formData: FormData) => void | Promise<void>;
  op: OfflineOp;
  // Co ma zobaczyć człowiek na liście do zatwierdzenia, np. "Jan Kowalski".
  detail: string;
  // Pola formularza, które trafiają do kolejki. Wypisane jawnie, żeby do
  // localStorage nie wjechało przypadkiem nic poza tym, co potrzebne.
  fields: string[];
  className?: string;
  offlineLabel?: string;
  children: React.ReactNode;
}) {
  const [zakolejkowane, setZakolejkowane] = useState(false);

  function zakolejkuj(formData: FormData): void {
    const payload: Record<string, string> = {};
    for (const name of fields) payload[name] = String(formData.get(name) ?? "");
    // Czas zdarzenia to moment kliknięcia na sali, nie moment wysyłki.
    enqueue({ op, detail, payload });
    setZakolejkowane(true);
  }

  async function submit(formData: FormData): Promise<void> {
    if (isOffline()) {
      zakolejkuj(formData);
      return;
    }
    try {
      await action(formData);
      reportSuccess();
    } catch (blad) {
      if (!isNetworkError(blad)) throw blad;
      reportError(blad);
      zakolejkuj(formData);
    }
  }

  if (zakolejkowane) {
    return (
      <p className="text-amber font-mono text-[10px] tracking-widest uppercase">{offlineLabel}</p>
    );
  }

  return (
    <form action={submit} className={className}>
      {children}
    </form>
  );
}
