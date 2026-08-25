import { Suspense } from "react";
import { redirect } from "next/navigation";
import { getAccessibleMembers, requireSession } from "@/lib/auth/guard";
import { prisma } from "@/lib/prisma";
import { isEmailConfigured } from "@/lib/services/notify";
import { EmailVerificationBanner } from "./email-verification-banner";
import { BrandHeaderLogo } from "../brand-header-logo";
import { HeaderNav, type HeaderNavGroup } from "../header-nav";
import { PAGE_SHELL } from "../shell";
import { SignedInAs } from "../signed-in-as";
import { ThemeToggle } from "../theme-toggle";
import { LogoutButton } from "../logout-button";
import { PanelFooter } from "../site-footer";
import { ConnectionBadge } from "../connection-badge";
import { OfflineBar } from "../offline-bar";

export default async function ClientLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSession();

  // Konto MEMBER bez kartoteki to świeże logowanie Google przed dokończeniem
  // profilu - kierujemy tam, zamiast pokazywać pustą aplikację. Konta zakładane
  // formularzem albo przez klub zawsze mają kartotekę, więc ich to nie dotyczy.
  // Przy okazji sprawdzamy stan zatwierdzenia - nieletni po samodzielnej
  // rejestracji czeka na akceptację klubu i ma o tym wiedzieć na każdym ekranie.
  let ownApproval: "APPROVED" | "PENDING" | "REJECTED" | null = null;
  if (session.user.role === "MEMBER") {
    const ownMember = await prisma.member.findUnique({
      where: { userId: session.user.id },
      select: { approvalStatus: true },
    });
    if (!ownMember) redirect("/dokoncz-profil");
    ownApproval = ownMember.approvalStatus;
  }

  const members = await getAccessibleMembers();

  // Baner "potwierdź e-mail" tylko dla konta, które ma niepotwierdzony adres,
  // i tylko gdy poczta działa - inaczej "wyślij ponownie" nie miałoby jak
  // zadziałać. Konta z czasów bez SMTP są od razu weryfikowane, więc ich to
  // nie dotyczy.
  const account = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { email: true, emailVerifiedAt: true },
  });
  const showVerifyBanner =
    isEmailConfigured() &&
    account != null &&
    account.email != null &&
    account.emailVerifiedAt == null;

  // Zapisy zostają na jedno kliknięcie - to po nie klient wchodzi do apki.
  // Reszta schowana w dwóch grupach, więc nic nie jest dalej niż dwa kliknięcia.
  const navGroups: HeaderNavGroup[] = [
    { label: "Pulpit", items: [{ href: "/app/pulpit", label: "Pulpit" }] },
    { label: "Grafik", items: [{ href: "/app", label: "Grafik" }] },
    { label: "Indywidualne", items: [{ href: "/app/indywidualne", label: "Indywidualne" }] },
    {
      label: "Moje konto",
      items: [
        { href: "/kod", label: "Mój kod wejścia" },
        { href: "/app/karnet", label: "Mój karnet" },
        { href: "/app/postepy", label: "Postępy" },
        ...(session.user.role === "GUARDIAN"
          ? [{ href: "/app/dziecko", label: "Moje dziecko" }]
          : []),
        { href: "/app/konto", label: "Konto" },
        { href: "/app/powiadomienia", label: "Powiadomienia" },
        { href: "/app/zgody", label: "Zgody" },
      ],
    },
    {
      label: "Klub",
      items: [
        { href: "/app/trenerzy", label: "Trenerzy" },
        { href: "/app/polecenia", label: "Polecenia" },
      ],
    },
  ];

  return (
    <div className="flex min-h-full flex-1 flex-col">
      {ownApproval === "PENDING" ? (
        <div className="border-amber bg-amber/10 border-b">
          <div className="mx-auto w-full max-w-[1400px] px-4 py-2">
            <p className="text-text text-sm">
              <b>Konto oczekuje na zatwierdzenie przez klub.</b> Możesz się rozglądać, ale zapis na
              zajęcia będzie możliwy dopiero po akceptacji. Damy znać, gdy konto zostanie
              aktywowane.
            </p>
          </div>
        </div>
      ) : ownApproval === "REJECTED" ? (
        <div className="border-red bg-red/10 border-b">
          <div className="mx-auto w-full max-w-[1400px] px-4 py-2">
            <p className="text-text text-sm">
              <b>Konto nie zostało zatwierdzone.</b> Skontaktuj się z klubem, aby wyjaśnić sprawę.
            </p>
          </div>
        </div>
      ) : null}
      {showVerifyBanner && account?.email ? (
        <Suspense fallback={null}>
          <EmailVerificationBanner email={account.email} />
        </Suspense>
      ) : null}
      <header className="border-line bg-surface border-b py-3">
        <div className={`${PAGE_SHELL} flex items-center justify-between gap-4`}>
          <div className="flex shrink-0 items-center gap-3">
            <BrandHeaderLogo />
            <SignedInAs name={session.user.name} />
          </div>
          <div className="flex min-w-0 items-center gap-4">
            <HeaderNav groups={navGroups} />
            <ConnectionBadge />
            <ThemeToggle />
            <LogoutButton />
          </div>
        </div>
      </header>
      {/* Stan bazy nad treścią, a nie w ustawieniach: kto pracuje bez łącza,
          ma to widzieć zanim zacznie ufać liczbom na ekranie. */}
      <OfflineBar />
      {members.length === 0 ? (
        <main className={`${PAGE_SHELL} flex-1 py-4`}>
          <p className="text-muted-brand">
            To konto nie ma jeszcze przypisanego profilu klienta. Skontaktuj się z klubem.
          </p>
        </main>
      ) : (
        <main className={`${PAGE_SHELL} flex-1 py-4`}>{children}</main>
      )}
      <PanelFooter />
    </div>
  );
}
