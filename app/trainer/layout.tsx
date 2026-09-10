import { prisma } from "@/lib/prisma";
import { requireTrainerSelf } from "@/lib/auth/guard";
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

export default async function TrainerLayout({ children }: { children: React.ReactNode }) {
  const { session, trainer } = await requireTrainerSelf();
  const [openAlertsCount, pendingSubstitutes, leadUser] = await Promise.all([
    prisma.retentionTask.count({ where: { trainerId: trainer.id, closedAt: null } }),
    // Zastępstwa czekające na jego decyzję. Licznik przy "Dziś", bo tam jest
    // sekcja z potwierdzeniem - push może nie dojść, to widać zawsze.
    prisma.session.count({
      where: {
        substituteTrainerId: trainer.id,
        substituteStatus: "PENDING",
        status: "SCHEDULED",
        startsAt: { gte: new Date() },
      },
    }),
    prisma.user.findUnique({
      where: { id: session.user.id },
      select: { canAccessLeads: true },
    }),
  ]);

  // "Dziś", "Kasa" i "Alerty" zostają na jedno kliknięcie: pierwsze dwa to
  // ekrany używane na sali w biegu, a Alerty niosą licznik, który ma być
  // widoczny bez rozwijania czegokolwiek.
  const navGroups: HeaderNavGroup[] = [
    { label: "Pulpit", items: [{ href: "/trainer/pulpit", label: "Pulpit" }] },
    {
      label: "Dziś",
      items: [{ href: "/trainer", label: "Dziś", badge: pendingSubstitutes || undefined }],
    },
    { label: "Kasa", items: [{ href: "/trainer/kasa", label: "Kasa" }] },
    {
      label: "Alerty",
      items: [{ href: "/trainer/alerty", label: "Alerty", badge: openAlertsCount || undefined }],
    },
    {
      label: "Klienci",
      items: [
        { href: "/trainer/podopieczni", label: "Podopieczni" },
        { href: "/trainer/sparingi", label: "Sparingi" },
      ],
    },
    ...(leadUser?.canAccessLeads
      ? [{ label: "Leady", items: [{ href: "/leady", label: "Leady" }] }]
      : []),
    {
      label: "Moje",
      items: [
        { href: "/trainer/terminy", label: "Terminy indywidualne" },
        { href: "/trainer/karta", label: "Moja karta" },
        { href: "/trainer/wynagrodzenie", label: "Wynagrodzenie" },
        { href: "/trainer/aktywnosc", label: "Aktywność" },
      ],
    },
    {
      label: "Stacja",
      items: [{ href: "/kod-zajec", label: "Kod na zajęcia" }],
    },
    // Przejscie do panelu wlasciciela. Przelacznik Admin/Trener w naglowku
    // chowa sie ponizej `md`, wiec bez tej pozycji Daniel zostalby na
    // telefonie zamkniety w jednym panelu, bez drogi powrotnej.
    ...(session.user.role === "ADMIN"
      ? [
          {
            label: "Widok",
            items: [{ href: "/admin", label: "Panel właściciela" }],
            mobileOnly: true,
          },
        ]
      : []),
  ];

  return (
    <div className="flex min-h-full flex-1 flex-col">
      <header className="border-line bg-surface border-b py-3">
        {/* Odstepy mniejsze na telefonie, a lewy blok MOZE sie zwezic. Przy
            375 px na tresc zostaje 343 px, a logo z imieniem i prawa grupa
            kontrolek nie miescily sie w tym razem - strona jechala w bok na
            KAZDYM ekranie tego panelu. */}
        <div className={`${PAGE_SHELL} flex items-center justify-between gap-2 sm:gap-4`}>
          <div className="flex min-w-0 shrink items-center gap-2 sm:gap-3">
            <BrandHeaderLogo />
            <SignedInAs role="Trener" name={session.user.name} />
          </div>
          <div className="flex shrink-0 items-center gap-2 sm:gap-4">
            <HeaderNav groups={navGroups} />
            <ConnectionBadge />
            {session.user.role === "ADMIN" ? <AccountViewSwitch current="trainer" /> : null}
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
