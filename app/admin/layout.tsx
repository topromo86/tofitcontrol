import { prisma } from "@/lib/prisma";
import { requireRole } from "@/lib/auth/guard";
import { BrandHeaderLogo } from "../brand-header-logo";
import { HeaderNav, type HeaderNavGroup } from "../header-nav";
import { PAGE_SHELL } from "../shell";
import { SignedInAs } from "../signed-in-as";
import { ThemeToggle } from "../theme-toggle";
import { LogoutButton } from "../logout-button";
import { PanelFooter } from "../site-footer";
import { AccountViewSwitch } from "../account-view-switch";
import { ConnectionBadge } from "../connection-badge";
import { OfflineBar } from "../offline-bar";

// Pogrupowane tematycznie - płaska lista urosła do kilkunastu pozycji i
// przestawała się mieścić w nagłówku. Każdy ekran jest najwyżej dwa
// kliknięcia od startu (grupa → pozycja).
const NAV_GROUPS: HeaderNavGroup[] = [
  { label: "Pulpit", items: [{ href: "/admin/pulpit", label: "Pulpit" }] },
  {
    label: "Klienci",
    items: [
      // "Klubowicze", nie "Karnety": to jest kartoteka ludzi, a nazwa myliła
      // się z cennikiem karnetów w grupie Pieniądze.
      { href: "/admin", label: "Klubowicze" },
      { href: "/admin/klienci/nowy", label: "Dodaj klienta" },
      { href: "/admin/zatwierdzenia", label: "Zatwierdzenia" },
    ],
  },
  {
    label: "Grafik",
    items: [
      { href: "/admin/zajecia", label: "Zajęcia" },
      { href: "/admin/zastepstwa", label: "Zastępstwa" },
      { href: "/admin/oblozenie", label: "Obłożenie sal" },
    ],
  },
  {
    label: "Pieniądze",
    items: [
      { href: "/admin/wplaty", label: "Wpłaty" },
      { href: "/admin/karnety", label: "Rodzaje karnetów" },
      { href: "/admin/kasa", label: "Kasa" },
      { href: "/admin/finanse", label: "Finanse" },
      { href: "/admin/promocje", label: "Rabaty i karty" },
      { href: "/admin/wynagrodzenia", label: "Wynagrodzenia" },
    ],
  },
  {
    label: "Zespół",
    items: [
      { href: "/admin/trenerzy", label: "Trenerzy" },
      { href: "/admin/ranking", label: "Ranking" },
      { href: "/admin/opinie", label: "Opinie" },
    ],
  },
  {
    label: "Retencja",
    items: [
      { href: "/admin/retencja", label: "Przegląd" },
      { href: "/admin/powody-odejsc", label: "Powody odejść" },
      { href: "/admin/audyt-notatek", label: "Audyt notatek" },
    ],
  },
  { label: "Leady", items: [{ href: "/leady", label: "Leady" }] },
  { label: "Aktywność", items: [{ href: "/admin/aktywnosc", label: "Aktywność" }] },
  {
    label: "Ustawienia",
    items: [
      { href: "/admin/ustawienia/email", label: "Poczta e-mail" },
      { href: "/admin/ustawienia/wyglad", label: "Wygląd" },
      { href: "/admin/ustawienia/sala", label: "Sala (odbicia)" },
      { href: "/kod-zajec", label: "Kod na zajęcia" },
      { href: "/skaner", label: "Stacja skanera" },
    ],
  },
];

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await requireRole("ADMIN");

  // Licznik przy "Zastępstwa" to powiadomienie właściciela wewnątrz systemu:
  // push może nie dojść (brak zgody w przeglądarce, brak kluczy VAPID), a to
  // widać zawsze. Liczymy niepotwierdzone i odrzucone - jedne i drugie
  // wymagają jego uwagi.
  const substituteAlerts = await prisma.session.count({
    where: {
      substituteStatus: { in: ["PENDING", "DECLINED"] },
      startsAt: { gte: new Date() },
      status: "SCHEDULED",
    },
  });

  // Właściciel-trener (ADMIN z własnym rekordem trenera) dostaje przełącznik
  // widoku admin/trener. Zwykły admin bez rekordu trenera - nie.
  const ownTrainer = await prisma.trainer.findUnique({
    where: { userId: session.user.id },
    select: { id: true },
  });

  const navGroups: HeaderNavGroup[] = NAV_GROUPS.map((group) =>
    group.label === "Grafik"
      ? {
          ...group,
          items: group.items.map((item) =>
            item.href === "/admin/zastepstwa"
              ? { ...item, badge: substituteAlerts || undefined }
              : item,
          ),
        }
      : group,
  );

  return (
    <div className="flex min-h-full flex-1 flex-col">
      <header className="border-line bg-surface border-b py-3">
        <div className={`${PAGE_SHELL} flex items-center justify-between gap-4`}>
          <div className="flex shrink-0 items-center gap-3">
            <BrandHeaderLogo />
            <SignedInAs role="Admin" name={session.user.name} />
          </div>
          <div className="flex min-w-0 items-center gap-4">
            <HeaderNav groups={navGroups} />
            <ConnectionBadge />
            {ownTrainer ? <AccountViewSwitch current="admin" /> : null}
            <ThemeToggle />
            <LogoutButton />
          </div>
        </div>
      </header>
      {/* Stan bazy nad treścią, a nie w ustawieniach: kto pracuje bez łącza,
          ma to widzieć zanim zacznie ufać liczbom na ekranie. */}
      <OfflineBar />
      <main className={`${PAGE_SHELL} flex-1 py-4`}>{children}</main>
      <PanelFooter />
    </div>
  );
}
