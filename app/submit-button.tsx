"use client";

import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";

// Przycisk, który mówi, że coś się dzieje - i blokuje się na czas wysyłki.
//
// Po co osobny komponent: akcje serwerowe wyglądają po kliknięciu dokładnie tak
// samo jak brak kliknięcia. Przy imporcie stu osiemdziesięciu leadów albo przy
// sprzedaży karnetu na wolnym wifi to trwa kilka sekund, w których człowiek nie
// wie, czy trafił w przycisk. Naturalna reakcja - kliknąć drugi raz - kosztuje
// drugi karnet i drugą wpłatę, bo sprzedaż nie ma idempotencji.
//
// `useFormStatus` musi siedzieć w komponencie DZIECKU formularza (nie w tym
// samym, co <form>), stąd osobny plik zamiast flagi w miejscu użycia.

export function SubmitButton({
  children,
  pendingLabel,
  className,
  size = "sm",
  variant,
}: {
  children: React.ReactNode;
  // Napis na czas wysyłki. Domyślny mówi tylko "czekaj"; przy dłuższych
  // operacjach warto podać własny, np. "Wgrywam plik...".
  pendingLabel?: string;
  className?: string;
  size?: "sm" | "default" | "lg" | "icon";
  variant?: "default" | "outline" | "ghost" | "destructive" | "secondary" | "link";
}) {
  const { pending } = useFormStatus();

  return (
    <Button
      type="submit"
      size={size}
      variant={variant}
      disabled={pending}
      aria-busy={pending}
      className={className}
    >
      {pending ? (
        <span className="flex items-center gap-2">
          {/* Kółko zamiast samego napisu: przy wolnym łączu tekst, który się nie
              rusza, wygląda jak zawieszony ekran. */}
          <span
            aria-hidden
            className="size-3 animate-spin rounded-full border-2 border-current border-t-transparent"
          />
          {pendingLabel ?? "Czekaj..."}
        </span>
      ) : (
        children
      )}
    </Button>
  );
}
