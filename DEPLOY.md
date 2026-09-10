# Wdrożenie na Vercel

Instrukcja dla toFitCONTROL. Krok 0 jest obowiązkowy — bez niego aplikacja
zbuduje się, ale nie ruszy.

## 0. Baza danych (NAJPIERW)

Projekt **nie używa baz lokalnych** — wszystko stoi na serwerze (patrz
`AGENTS.md`). Potrzebne są dwie bazy PostgreSQL u dostawcy:

| Baza | Do czego |
| --- | --- |
| **produkcyjna** | prawdziwi klienci, karnety, płatności — używa jej Vercel |
| **deweloperska** | praca nad kodem i testy — używa jej `npm run dev` |

Rozdzielenie jest po to, żeby pomyłka w skrypcie testowym nie tknęła danych
klubu. Adres produkcyjnej trafia do zmiennych w Vercelu, deweloperskiej — do
lokalnego `.env` (plik jest poza repo).

Obecny dostawca to **Prisma Postgres** (dodany przez panel Vercela:
Storage → Create Database). Alternatywy o tych samych możliwościach: Neon,
Supabase.

## 1. Kod na GitHub

Zdalny adres jest już ustawiony na `https://github.com/topromo86/czapla-system.git`
(konto **topromo86**). Repo na GitHubie ma być **prywatne** — to dane klubu.
Widoczność zmienia się w repo: **Settings → Danger Zone → Change repository
visibility**.

Wysłanie kodu:

```bash
git push -u origin main
```

Kolejne zmiany wypychasz już samym `git push`.

Plik `.env` jest w `.gitignore`, więc hasła i klucze **nie trafią** do repo —
wpisuje się je w panelu Vercel (krok 3).

## 2. Projekt w Vercel

1. [vercel.com/new](https://vercel.com/new) → **Import Git Repository** → wybierz repo.
2. Framework: Next.js (wykryje sam). Nie zmieniaj komend build.
3. **Nie klikaj jeszcze Deploy** — najpierw zmienne (krok 3).

## 3. Zmienne środowiskowe

W Vercel: **Settings → Environment Variables**.

> **`DATABASE_URL` ustaw osobno dla każdego środowiska.** Produkcyjny adres
> wyłącznie w **Production**; w **Preview** i **Development** wpisz adres bazy
> deweloperskiej. Zaznaczenie wszystkich środowisk naraz oznacza, że każde
> wdrożenie podglądowe — z gałęzi, z pull requesta, z cudzego forka — działa na
> żywej kartotece klubu: zapisuje obecności, sprzedaje karnety i wysyła
> powiadomienia do prawdziwych ludzi. Migracji podgląd nie wgra
> (`scripts/deploy-migrations.ts` rusza tylko przy `VERCEL_ENV=production`),
> ale dane zmieni.
>
> Pozostałe zmienne mogą być wspólne dla wszystkich środowisk.

Wymagane:

| Zmienna | Skąd wziąć |
| --- | --- |
| `DATABASE_URL` | connection string z kroku 0 — **Production osobno**, patrz wyżej |
| `AUTH_SECRET` | wygeneruj: `npx auth secret` albo `openssl rand -base64 32` |
| `CRON_SECRET` | dowolny długi losowy ciąg — chroni endpointy `/api/cron/*` |

Opcjonalne (funkcje działają dopiero po ich ustawieniu):

| Zmienna | Do czego |
| --- | --- |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM` | potwierdzenia zapisu i przypomnienia mailem |
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | powiadomienia push (klucze są już w Twoim lokalnym `.env`) |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | logowanie przez Google |
| `SMSAPI_TOKEN`, `SMSAPI_SENDER` | wiadomości SMS przez SMSAPI.pl (nadawca max 11 znaków, bez ogonków) |

`DATABASE_URL` musi być ustawiony **przed pierwszym buildem** — część stron
odpytuje bazę już na etapie budowania.

## 4. Migracje i dane startowe

Z lokalnego komputera, wskazując na bazę produkcyjną:

```bash
npx cross-env DATABASE_URL="<adres_bazy_produkcyjnej>" npx prisma migrate deploy
```

Następnie konfiguracja klubu — kadra, superadmin, kategorie i grafik:

```bash
npx cross-env DATABASE_URL="<adres_bazy_produkcyjnej>" npm run db:setup
```

> **`prisma db seed` NIE uruchamiaj na produkcji.** Ten skrypt oprócz
> lokalizacji, planów i zgód dokłada pełne dane demonstracyjne: kilkadziesiąt
> zmyślonych kartotek z polskimi nazwiskami, ich historię obecności, karnety
> i wpłaty. Nic tego nie oznacza jako fikcyjne i nie ma narzędzia, które by to
> usunęło — wsiąkają w kartotekę klubu na stałe i przez lata psują statystyki,
> retencję i wyniki trenerów. `db seed` służy wyłącznie bazie deweloperskiej
> (tak samo mówi AGENTS.md). Lokalizacje, plany i zgody zakłada się na
> produkcji ręcznie z panelu, a rodzaje karnetów skryptem
> `prisma/reset-cennik.ts`.
>
> Do pokazania systemu klubowi służy **Ustawienia → Dane demonstracyjne**:
> te dane są oznaczone, spisane co do rekordu i dają się usunąć jednym
> kliknięciem.

**Zmień hasła** kont — skrypty zakładają je z tymczasowym `test1234`:

```bash
npx tsx prisma/hasla-trenerow.ts --env .env.vercel --ustaw --takze-wlasciciele
```

Bez `--takze-wlasciciele` skrypt pomija konta ADMIN (właściciel i superadmin),
a to właśnie one zostają wtedy z hasłem z repozytorium. Samo
`prisma/wymus-zmiane-hasla.ts` tu nie wystarcza — zapala flagę, ale **nie
wymienia hasła**, więc kto zaloguje się jako pierwszy, ten ustawi nowe i
przejmie konto.

## 5. Deploy

Klik **Deploy** w Vercel (albo `git push` — każdy push na `main` wdraża się sam).

## Zadania cykliczne — uwaga o planie

`vercel.json` zawiera **10 zadań cron** (generowanie grafiku, przypomnienia,
zamknięcie kasy, retencja itd.).

Plan **Hobby (darmowy) pozwala tylko na 2 zadania i wyłącznie raz dziennie** —
przy 10 wdrożenie zostanie odrzucone. Masz dwa wyjścia:

- **Plan Pro** (~20 USD/mies.) — wszystkie zadania działają bez zmian, albo
- **zostaw 2 najważniejsze** w `vercel.json` (`generate-sessions` i
  `session-reminders`), resztę uruchamiaj ręcznie lub zewnętrznym
  harmonogramem (np. cron-job.org uderzający w `/api/cron/...`
  z nagłówkiem `Authorization: Bearer <CRON_SECRET>`).

## Po wdrożeniu — sprawdź

1. Logowanie (`dpilc@wp.pl`) i pulpit admina.
2. Grafik: zajęcia mają pełne nazwy rodzajów i kolorowe paski.
3. Zakładka **Ustawienia → Poczta e-mail** — test wysyłki (jeśli ustawiłeś SMTP).
4. Zmienione hasła kont.
