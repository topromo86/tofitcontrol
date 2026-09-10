import Link from "next/link";
import { requireLeadAccess } from "@/lib/auth/guard";
import { BrandHeaderLogo } from "../brand-header-logo";
import { PAGE_SHELL } from "../shell";
import { ThemeToggle } from "../theme-toggle";
import { LogoutButton } from "../logout-button";
import { PanelFooter } from "../site-footer";

// Moduł leadów (CRM) - osobna sekcja wspólna dla admina i trenera z dostępem
// (requireLeadAccess), zamiast dublować ekrany pod /admin i /trainer.
export default async function LeadsLayout({ children }: { children: React.ReactNode }) {
  const session = await requireLeadAccess();
  const backHref = session.user.role === "ADMIN" ? "/admin/pulpit" : "/trainer/pulpit";

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
            <span className="text-muted-brand truncate font-mono text-xs tracking-widest uppercase">
              Leady · CRM
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-2 sm:gap-4">
            <Link
              href={backHref}
              className="text-muted-brand hover:text-brand-red font-mono text-xs tracking-widest whitespace-nowrap uppercase"
            >
              ← Panel
            </Link>
            <ThemeToggle />
            <LogoutButton />
          </div>
        </div>
      </header>
      <main className={`${PAGE_SHELL} flex-1 py-4`}>{children}</main>
      <PanelFooter />
    </div>
  );
}
