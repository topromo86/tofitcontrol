const CACHE_NAME = "klub-bokserski-v2";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  );
});

// Czego NIGDY nie podajemy z cache'a.
//
// /api/zdrowie to pytanie "czy widzisz bazę" - odpowiedź z cache'a znaczyłaby
// wskaźnik ONLINE przy wyciągniętym kablu, czyli dokładnie to kłamstwo, przed
// którym cały ten mechanizm ma chronić. Reszta /api i logowanie z tego samego
// powodu: to są odpowiedzi ważne w chwili zapytania, nie wczoraj.
function alwaysFresh(url) {
  return url.pathname.startsWith("/api/") || url.pathname.startsWith("/login");
}

const OFFLINE_PAGE = `<!doctype html>
<html lang="pl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Brak połączenia - toFitCONTROL</title>
<style>
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         background:#15171a; color:#f4f5f6; font-family:system-ui,sans-serif; padding:1.5rem; }
  main { max-width:26rem; text-align:center; }
  h1 { color:#ff4d52; font-size:1.25rem; margin:0 0 .75rem; }
  p { line-height:1.5; margin:0 0 1rem; color:#b9bcc2; }
  button { background:#ee1d23; color:#fff; border:0; border-radius:.375rem;
           padding:.65rem 1.25rem; font-size:1rem; cursor:pointer; }
</style>
</head>
<body>
<main>
  <h1>Brak połączenia z bazą klubu</h1>
  <p>Tego ekranu nie ma jeszcze w pamięci urządzenia, więc bez sieci nie da się go pokazać.
     Ekrany otwierane wcześniej działają dalej, a odbicia zrobione bez łącza czekają na
     dopisanie do bazy.</p>
  <button type="button" onclick="location.reload()">Spróbuj ponownie</button>
</main>
</body>
</html>`;

// Sieć w pierwszej kolejności, cache jako zapas offline. Tylko GET - mutacje
// (Server Actions, POST) nigdy nie są cache'owane ani przechwytywane, bo zapis
// podany z cache'a byłby zapisem, którego nie ma w bazie. Zapisy bez łącza
// obsługuje kolejka w aplikacji (lib/offline/queue.ts), a nie ten plik.
self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (alwaysFresh(url)) return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        // Cache'ujemy wyłącznie udane odpowiedzi. Zapisana "502" wracałaby
        // potem przy każdym braku sieci jako rzekomo aktualna strona.
        if (response.ok && response.type === "basic") {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(request);
        if (cached) return cached;

        // Nawigacja na ekran, którego nikt jeszcze nie otworzył. Zamiast
        // dinozaura przeglądarki mówimy, co się dzieje i co z tym zrobić -
        // na sali to jest różnica między "system padł" a "nie ma wifi".
        if (request.mode === "navigate") {
          return new Response(OFFLINE_PAGE, {
            status: 503,
            headers: { "Content-Type": "text/html; charset=utf-8" },
          });
        }
        return Response.error();
      }),
  );
});

// Powiadomienie "dziecko weszło na salę" (SPEC.md sekcja 3, PLAN.md Faza 4).
// Payload to zawsze JSON { title, body } - patrz lib/services/notify.ts.
self.addEventListener("push", (event) => {
  let data = { title: "Czapla Boxing", body: "Masz nowe powiadomienie." };
  if (event.data) {
    try {
      data = event.data.json();
    } catch {
      data.body = event.data.text();
    }
  }

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: "/icon-192.png",
      badge: "/icon-192.png",
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window" }).then((clients) => {
      for (const client of clients) {
        if ("focus" in client) return client.focus();
      }
      return self.clients.openWindow("/app");
    }),
  );
});
