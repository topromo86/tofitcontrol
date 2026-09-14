import { Backpack } from "lucide-react";
import { cn } from "@/lib/utils";

// Znacznik "to dotyczy dziecka" - JEDEN na cały system.
//
// Ten sam fakt był wcześniej pokazywany na cztery sposoby naraz: ikoną plecaka
// w kartotece, dopiskiem "(dziecko)" przy nazwisku w czterech innych miejscach,
// dopiskiem "(dzieci)" przy rodzaju karnetu i bursztynową pigułką "Dzieci"
// przy grupie zajęć. Człowiek, który nauczył się jednego, i tak musiał czytać
// pozostałe trzy.
//
// Bursztynowa pigułka była przy tym wprost sprzeczna z paletą tego systemu:
// bursztyn znaczy "karnet kończy się wkrótce", a nie "grupa dziecięca".
// Barwa znacznika jest z palety RODZAJÓW ZAJĘĆ (`cat-*`), która celowo nie
// niesie znaczenia statusu - czerwień, bursztyn i jadeit są zarezerwowane dla
// karnetu i nie wolno ich użyć do czegokolwiek innego.
//
// Piktogram zamiast napisu, bo czyta się jednym spojrzeniem i nie zjada
// szerokości nazwiska - a na liście to nazwisko jest najważniejsze. Na telefonie
// każdy zaoszczędzony znak ma znaczenie (patrz sekcja o telefonie w AGENTS.md).
//
// Ikona NIGDY nie stoi sama: niesie `aria-label` dla czytnika ekranu i `title`
// z powodem, dla którego ten znacznik w ogóle istnieje. Sam obrazek nic nie mówi
// komuś, kto widzi go pierwszy raz.

// Czego dotyczy znacznik. Trzy przypadki, bo trzy różne fakty w bazie -
// `Member.isMinor`, `Plan.forMinors` i `ClassTemplate.isKids` - i każdy znaczy
// dla czytającego co innego. Opisy są tutaj, a nie u wołającego: gdyby każdy
// ekran pisał własny, po pół roku byłoby ich osiem różnych.
export type ChildMarkSubject = "member" | "plan" | "class";

const OPIS: Record<ChildMarkSubject, { label: string; title: string }> = {
  member: {
    label: "Dziecko",
    title: "Dziecko - kontaktem jest rodzic",
  },
  plan: {
    label: "Karnet dla dzieci",
    title: "Karnet dla dzieci - kasa podpowiada go wyłącznie niepełnoletnim",
  },
  class: {
    label: "Grupa dziecięca",
    title: "Grupa dziecięca - w grafiku widzą ją tylko niepełnoletni",
  },
};

export function ChildMark({
  subject = "member",
  className,
}: {
  subject?: ChildMarkSubject;
  className?: string;
}) {
  const { label, title } = OPIS[subject];
  return (
    <span
      title={title}
      // `inline-flex` z `align-middle` siada równo zarówno w akapicie obok
      // nazwiska, jak i w wierszu flexa; `shrink-0`, żeby przy wąskim ekranie
      // ścisnęło się nazwisko, a nie znacznik.
      className={cn("text-cat-sky inline-flex shrink-0 align-middle", className)}
    >
      <Backpack role="img" aria-label={label} className="size-4" />
    </span>
  );
}
