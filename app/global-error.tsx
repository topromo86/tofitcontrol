"use client";

// Ostatnia siatka bezpieczeństwa: awaria w GŁÓWNYM layoucie, czyli zanim
// powstanie cokolwiek wspólnego dla ekranów. Ten plik zastępuje wtedy całe
// <html>, więc musi je narysować sam.
//
// Kiedy to się dzieje: layout odpytuje bazę o zestaw czcionek klubu. Zapytanie
// jest teraz opakowane (app/layout.tsx), ale gdyby kiedykolwiek doszło tam
// drugie - albo padło ładowanie czcionek - bez tego pliku cała aplikacja,
// łącznie z ekranem logowania, pokazywałaby surowy komunikat Next.js.
//
// Świadomie BEZ klas Tailwinda i bez importu globals.css: skoro layout się nie
// zbudował, nie zakładamy, że arkusz stylów dojechał. Dokładnie ta sama zasada,
// co przy ekranie offline w public/sw.js - i te same barwy, żeby człowiek
// widział, że to nadal ten sam system.

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="pl">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#15171a",
          color: "#f4f5f6",
          fontFamily: "system-ui, sans-serif",
          padding: "1.5rem",
        }}
      >
        <main style={{ maxWidth: "26rem", textAlign: "center" }}>
          <h1 style={{ color: "#ff4d52", fontSize: "1.25rem", margin: "0 0 .75rem" }}>
            System klubu chwilowo nie odpowiada
          </h1>
          <p style={{ lineHeight: 1.5, margin: "0 0 1rem", color: "#b9bcc2" }}>
            To nie jest wina Twojego urządzenia. Spróbuj ponownie za chwilę - jeśli to się powtarza,
            powiedz Danielowi.
          </p>
          <button
            type="button"
            onClick={reset}
            style={{
              background: "#ee1d23",
              color: "#fff",
              border: 0,
              borderRadius: ".375rem",
              padding: ".65rem 1.25rem",
              fontSize: "1rem",
              cursor: "pointer",
            }}
          >
            Spróbuj ponownie
          </button>
          {error.digest ? (
            <p style={{ marginTop: "1rem", color: "#b9bcc2", fontSize: ".75rem" }}>
              Numer zgłoszenia: {error.digest}
            </p>
          ) : null}
        </main>
      </body>
    </html>
  );
}
