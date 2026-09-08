import type { Metadata, Viewport } from "next";
import { Anton, Archivo, IBM_Plex_Mono, Inter, Oswald, Playfair_Display } from "next/font/google";
import Script from "next/script";
import "./globals.css";
import { getClubSettings } from "@/lib/services/settings";
import { DEFAULT_FONT_THEME } from "@/lib/domain/font-themes";
import { RegisterServiceWorker } from "./register-service-worker";
import { getAccountTheme } from "@/lib/services/theme";
import { themeInitScript } from "./theme-init";

// Wszystkie rodziny ładujemy zawsze (każda pod swoją zmienną CSS). O tym, KTÓRA
// jest aktywna, decyduje atrybut data-font na <html> (patrz globals.css) -
// ustawiany z ustawień klubu, więc admin przełącza zestaw dla wszystkich.
const anton = Anton({ variable: "--font-anton", subsets: ["latin", "latin-ext"], weight: "400" });
const archivo = Archivo({ variable: "--font-archivo", subsets: ["latin", "latin-ext"] });
const ibmPlexMono = IBM_Plex_Mono({
  variable: "--font-ibm-plex-mono",
  subsets: ["latin", "latin-ext"],
  weight: ["400", "500", "600"],
});
const oswald = Oswald({ variable: "--font-oswald", subsets: ["latin", "latin-ext"] });
const inter = Inter({ variable: "--font-inter", subsets: ["latin", "latin-ext"] });
const playfair = Playfair_Display({ variable: "--font-playfair", subsets: ["latin", "latin-ext"] });

const FONT_VARS = [
  anton.variable,
  archivo.variable,
  ibmPlexMono.variable,
  oswald.variable,
  inter.variable,
  playfair.variable,
].join(" ");

export const metadata: Metadata = {
  title: "toFitCONTROL",
  description: "toFitCONTROL - system zarządzania klubem sportowym",
  appleWebApp: {
    capable: true,
    title: "toFitCONTROL",
    statusBarStyle: "default",
  },
};

export const viewport: Viewport = {
  // Kolor paska przeglądarki/systemu. Idzie za ustawieniem systemu, a nie za
  // naszym przełącznikiem - przeglądarka czyta to z metatagu przy ładowaniu.
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f4f5f6" },
    { media: "(prefers-color-scheme: dark)", color: "#15171a" },
  ],
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Zestaw czcionek z ustawień klubu - deterministyczny (z bazy), więc SSR i
  // klient zgadzają się co do data-font, bez migotania.
  //
  // Błąd bazy tłumimy tu tak samo jak w getAccountTheme i z tego samego powodu:
  // ten layout opakowuje KAŻDY ekran, łącznie z logowaniem. Gdyby chwilowa
  // niedostępność bazy wywróciła to jedno zapytanie, klub nie zobaczyłby nawet
  // ekranu logowania - a jedyne, co stąd bierzemy, to nazwa zestawu czcionek.
  const [ustawienia, accountTheme] = await Promise.all([
    getClubSettings().catch(() => null),
    getAccountTheme(),
  ]);
  const fontTheme = ustawienia?.fontTheme ?? DEFAULT_FONT_THEME;

  return (
    <html
      lang="pl"
      data-font={fontTheme}
      className={`${FONT_VARS} h-full antialiased${accountTheme === "dark" ? "dark" : ""}`}
      // Skrypt motywu dopisuje klasę `dark` do <html> przed hydratacją, więc
      // serwer i klient widzą tu różny className. To zamierzone.
      suppressHydrationWarning
    >
      <body className="flex min-h-full flex-col">
        {/* Motyw (klasa `dark`) ustawiany przed hydratacją, żeby nie migotało.
        next/script z beforeInteractive trafia do początkowego HTML i wykonuje się
        przed kodem Next - w przeciwieństwie do surowego <script> nie wywołuje
        ostrzeżenia React o skrypcie w drzewie komponentów. */}
        <Script id="theme-init" strategy="beforeInteractive">
          {themeInitScript(accountTheme)}
        </Script>
        {children}
        <RegisterServiceWorker />
      </body>
    </html>
  );
}
