import type { Metadata } from "next";
import { isGoogleConfigured } from "@/auth";
import { ConnectionBadge } from "../connection-badge";
import { OfflineBar } from "../offline-bar";
import { ThemeToggle } from "../theme-toggle";
import { SiteFooter } from "../site-footer";
import { LoginForm } from "./login-form";

export const metadata: Metadata = {
  title: "Logowanie - toFitCONTROL",
};

const NOTICE: Record<string, string> = {
  zarejestrowano: "Konto założone. Zaloguj się swoim e-mailem i hasłem.",
  "haslo-zmienione": "Hasło zmienione. Zaloguj się nowym hasłem.",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ zarejestrowano?: string; "haslo-zmienione"?: string; powrot?: string }>;
}) {
  const params = await searchParams;
  const notice = params.zarejestrowano
    ? NOTICE.zarejestrowano
    : params["haslo-zmienione"]
      ? NOTICE["haslo-zmienione"]
      : undefined;

  return (
    <main className="relative flex min-h-full flex-1 flex-col items-center justify-center gap-4 p-4">
      {/* Przełącznik jest też tutaj - poza panelami nie ma nagłówka, a to
          pierwszy ekran, jaki widzi nowa osoba. */}
      {/* Stan bazy jest tu potrzebny najbardziej: gdy logowanie nie przechodzi,
          pierwsze pytanie brzmi "to ja czy system". Poza panelami nie ma
          nagłówka, więc wskaźnik siada obok przełącznika motywu. */}
      <div className="absolute top-4 right-4 flex items-center gap-2">
        <ConnectionBadge />
        <ThemeToggle />
      </div>
      <div className="w-full max-w-sm">
        <OfflineBar />
      </div>
      <LoginForm notice={notice} googleEnabled={isGoogleConfigured()} returnTo={params.powrot} />
      <SiteFooter />
    </main>
  );
}
