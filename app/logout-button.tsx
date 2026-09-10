import { LogOut } from "lucide-react";
import { signOut } from "@/auth";

// Na telefonie zostaje sama ikona, od `sm` wraca napis.
//
// Powod jest zmierzony, nie estetyczny: napis "WYLOGUJ" ma 66 px, a caly
// naglowek panelu nie schodzil ponizej 440 px przy ekranie 375 px - czyli
// KAZDY ekran admina przewijal sie w bok na telefonie. Gesta lista przewijana
// w bok jest gorsza niz rzadka, ktora stoi w miejscu.
//
// `aria-label` zostaje zawsze, wiec dla czytnika ekranu nic sie nie zmienia.
export function LogoutButton() {
  return (
    <form
      action={async () => {
        "use server";
        await signOut({ redirectTo: "/login" });
      }}
    >
      <button
        type="submit"
        aria-label="Wyloguj"
        title="Wyloguj"
        className="text-muted-brand hover:text-brand-red flex items-center font-mono text-xs tracking-widest uppercase"
      >
        <LogOut className="size-4 sm:hidden" aria-hidden />
        <span className="hidden sm:inline">Wyloguj</span>
      </button>
    </form>
  );
}
