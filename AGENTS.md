<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Baza danych — zawsze na serwerze

**Nie ma bazy lokalnej i nie wolno jej zakładać.** Wszystko żyje w chmurze:

| Baza | Do czego | Kto jej dotyka |
| --- | --- | --- |
| **produkcyjna** | prawdziwi klienci, karnety, płatności, grafik | aplikacja na Vercelu |
| **deweloperska** | praca nad kodem, migracje, testy na danych | `npm run dev` u programisty |

Obie stoją u tego samego dostawcy (Prisma Postgres). Praca lokalna łączy się
z **deweloperską** — nigdy z produkcyjną. Adresy są w `.env` (poza repo).

Uruchomienie aplikacji to jedno polecenie, bez osobnego okna na bazę:

```
npm run dev
```

## Dlaczego nie ma bazy lokalnej

Wcześniej projekt używał `prisma dev` (lokalny Postgres w WASM). Skończyło się
to uszkodzeniem katalogu danych i odtwarzaniem klubu od zera. Powody były dwa
i oba wracały:

- silnik prowadził obok danych strumień zdarzeń, który urósł do 9,7 GB
  (przy 94 MB realnych danych) i wywracał bazę przy starcie,
- twarde ubicie procesu w trakcie zapisu psuło pliki nieodwracalnie
  (`Aborted()` z `@electric-sql/pglite`).

Do tego każdy programista miał własną kopię danych, więc „u mnie działa"
znaczyło co innego u każdego. Jedna baza na serwerze usuwa wszystkie te
problemy naraz.

## Migracje na produkcji

Wgrywa je **build na Vercelu**, nie człowiek z laptopa. Odpowiada za to
`scripts/deploy-migrations.ts` wpięty w `npm run build`:

- rusza wyłącznie przy wdrożeniu produkcyjnym (`VERCEL_ENV=production`) —
  podglądy i buildy lokalne nie dotykają bazy,
- adres wybiera tak samo jak aplikacja (`pickConnectionString`), bo pod
  `DATABASE_URL` potrafi siedzieć adres przez Accelerate,
- nieudana migracja wywraca build: nowy kod na starym schemacie jest gorszy
  niż wdrożenie, które się nie udało.

Powód jest z doświadczenia: kod raz poszedł na produkcję przed migracją i klub
zobaczył „The table `public.ClubSettings` does not exist". Krok, o którym
trzeba pamiętać, prędzej czy później zostanie pominięty.

## Odtworzenie stanu klubu

Cały stan klubu jest w skryptach — nic nie trzeba odtwarzać z pamięci:

```
npx prisma migrate deploy   # schemat
npx prisma db seed          # konfiguracja: lokalizacje, plany, zgody (+ dane testowe)
npm run db:setup            # kadra, superadmin, kategorie i grafik 22 zajęć
```

`db:setup` jest idempotentny — można go puszczać na pełnej bazie, nic nie
zdubluje. Odtwarza: 6 realnych trenerów (Daniel jako ADMIN z rekordem trenera,
czyli z przełącznikiem Admin/Trener), konto superadmina, kategorie zajęć oraz
grafik tygodniowy Tychy + Mikołów wraz z terminami na 8 tygodni.

**Uruchamiaj to wyłącznie na bazie deweloperskiej.** `db seed` dokłada dane
testowe (klienci, historia), więc na produkcji zaśmieciłby kartotekę klubu.

## Kopie zapasowe

Kopie bazy produkcyjnej trafiają na zewnętrzny serwer (Unixstorm) — poza
dostawcę bazy, żeby awaria po jego stronie nie zabrała ze sobą kopii.

## Wybór adresu połączenia

`lib/domain/connection-string.ts` wybiera pierwszy adres w formacie
`postgresql://`, bo hosting podstawia kilka zmiennych naraz i pod
`DATABASE_URL` potrafi wstawić adres przez Accelerate (`prisma+postgres://`),
którego sterownik `node-postgres` nie otworzy. Tam też jest jawne
`sslmode=verify-full`, żeby aktualizacja `pg` nie wyłączyła po cichu
sprawdzania certyfikatu.

## Cennik karnetów

Rodzaje karnetów żyją w `prisma/club-plans.ts` - jedno miejsce, z którego
korzysta seed i skrypt wymiany cennika. Wcześniej seed miał własne, wymyślone
ceny i wracały one na każdą odtworzoną bazę.

Wymiana cennika wraz z wyczyszczeniem demonstracyjnej historii karnetów:

```
npx tsx prisma/reset-cennik.ts                        # dev, tylko podgląd
npx tsx prisma/reset-cennik.ts --usun                 # dev, wykonanie
npx tsx prisma/reset-cennik.ts --env .env.vercel      # produkcja, podgląd
npx tsx prisma/reset-cennik.ts --env .env.vercel --usun
```

Skrypt kasuje karnety, wpłaty i cennik; nie rusza klientów, zajęć, grafiku,
kont ani zamknięć kasy. Bez `--usun` nic nie robi - kasowanie `Payment`
(w normalnej pracy append-only) jest nieodwracalne.

Codzienne zmiany cen robi właściciel na ekranie **Pieniądze → Rodzaje
karnetów**, bez programisty.

## Kiosk na sali

Tablet ma własne konto (rola `KIOSK`, login `kiosk`). Po zalogowaniu widzi
wyłącznie `/kod-zajec`: kod QR najbliższych zajęć dla klubowiczów i skaner
kodów rotacyjnych dla prowadzącego. Nie widzi kartoteki, pieniędzy ani grafiku -
hasło do tego konta zna cały klub, więc uprawnienia muszą być zerowe. Dlatego
osobna rola, a nie "trener techniczny".

Założenie/zmiana hasła konta kiosku (hasło w wywołaniu, nie w repozytorium):

```
npx tsx prisma/kiosk-account.ts --haslo <haslo>
npx tsx prisma/kiosk-account.ts --env .env.vercel --haslo <haslo>
```

Kamera działa tylko po HTTPS - na Vercelu tak, na tablecie wpiętym po adresie
IP w sieci lokalnej nie. Dekodowanie ma dwie drogi: natywny `BarcodeDetector`
(Chrome/Android) i `jsQR` dla Safari na iPadzie.

## Praca bez sieci

Na sali wifi potrafi paść w środku zajęć, a odbicia muszą iść dalej. Aplikacja
nie może wtedy ani zamilknąć, ani udawać, że nic się nie stało — bo wtedy
trener liczyłby na danych sprzed zerwania, nie wiedząc o tym.

**Stan bazy widać cały czas**, w pasku nagłówka (`app/connection-badge.tsx`),
a nie w ustawieniach — w trakcie zajęć nikt tam nie zagląda. Kolory: zielony
(zapisy idą do bazy), pomarańczowy (baza odpowiada, ale coś czeka w kolejce),
czerwony (brak kontaktu). Stan liczy `lib/offline/connection.ts` z trzech
źródeł: zdarzeń `online`/`offline` przeglądarki, wyniku każdego realnego
zapisu i pingu `/api/zdrowie` co 20 s (co 5 s po zerwaniu).

Sam `navigator.onLine` nie wystarcza: wifi klubu bywa „jest", ale nie
przepuszcza ruchu. Dlatego OFFLINE zapala się dopiero, gdy serwer nie
odpowiada — a odmowa serwera (401, 403, 500) **nie** jest brakiem łącza.
Gdyby była, wskaźnik kłamałby i przestano by mu wierzyć.

### Co da się zapisać bez łącza

Wyłącznie zdarzenia z sali, bo one się **dopisują**, a nie nadpisują — dwie
osoby offline nie zrobią sobie nawzajem krzywdy:

- `/skaner` — odbicie osobistego kodu QR na stacji wejścia,
- `/kod-zajec` — kod rotacyjny na kiosku,
- panel trenera — ręczne zaznaczenie obecności i potwierdzenie listy,
- `/qr/[locationId]` — meldunek klubowicza z kodu na ścianie.

Reszta panelu bez sieci działa **tylko do odczytu** (service worker podaje
ostatnio otwarte ekrany z pamięci urządzenia). Kolejkowanie edycji karnetów,
kasy czy grafiku byłoby prostą drogą do skasowania cudzej zmiany.

### Jak wracają do bazy

Zapis bez łącza trafia do kolejki w `localStorage` (`lib/offline/queue.ts`)
razem z **godziną zdarzenia**, nie wysyłki. To nie jest kosmetyka: kod
rotacyjny żyje 30 sekund, więc sprawdzony wobec „teraz" po powrocie wifi
zawsze byłby wygasły. Serwer sprawdza go wobec momentu, w którym stanął przed
kamerą.

Data przychodzi z przeglądarki, więc nie jest zaufana — przepuszcza ją
`resolveRecordedAt` (`lib/domain/offline-queue.ts`): nie z przyszłości, nie
starsza niż doba. Starsze braki to już decyzja kadrowa i idą przez panel,
gdzie widać, kto co zmienił.

**Wysyłka rusza sama po powrocie łącza.** Pas nad treścią
(`app/offline-bar.tsx`) mówi, że zapisy jadą do bazy, i gaśnie, gdy dojadą —
nikt nic nie klika. Taka była decyzja klubu i ma oparcie w tym, jak wygląda
sala: nikt nie ma tam rąk do potwierdzania paska, a odbicie czekające na czyjąś
zgodę jest w praktyce odbiciem, o którym się zapomina.

Zabezpieczeniem zostaje to, co **nie** jest automatyczne:

- pozycja, której baza nie przyjęła, **nigdy nie znika po cichu** — zostaje na
  ekranie z powodem odmowy i czeka na człowieka (`Spróbuj jeszcze raz` albo
  `Odrzuć`),
- automat **nie ponawia** odrzuconych. Odmowa zwykle nie jest chwilowa
  (wygasła rezerwacja, brak uprawnień, zapis starszy niż doba), więc ponawianie
  oznaczałoby ten sam odrzucany zapis przy każdym pingu. Rozstrzyga to
  `autoSendable` (`lib/domain/offline-queue.ts`),
- nieudany **strzał** (padło łącze w trakcie, wygasła sesja) nie oznacza pozycji
  jako odrzuconych, więc automat wróci do nich sam — ale z rosnącym odstępem
  (1,2 s → 5 s → 15 s → 60 s). Bez tego efekt ponawiałby wysyłkę co sekundę
  w kółko; sprawdzone na żywym ekranie, to nie jest hipotetyczne,
- wysyłka jest **jedna na przeglądarkę** (`wLocie` w module), choćby pas wisiał
  w dwóch kartach naraz.

Startu pilnuje potwierdzone `online`, czyli odpowiedź z `/api/zdrowie` — nie
samo zdarzenie przeglądarki. Wifi klubu bywa „jest", ale nie przepuszcza ruchu,
a wysyłka w taką dziurę tylko naliczyłaby odmowy.

Każda pozycja przy dopisywaniu przechodzi **ponownie** przez strażnika
i tę samą regułę co zapis na żywo (`app/offline-actions.ts`). Wspólne jądro
zapisu obecności siedzi w `lib/services/attendance.ts`, żeby droga „na żywo"
i droga „z kolejki" nie miały jak się rozjechać.

Pomysł i uzasadnienie przeniesione z toPROductive (`src/sync/stanPolaczenia.js`
i kolejka w `src/sync/dbServer.js`); tam kolejka obejmuje całą warstwę danych,
bo aplikacja rozmawia z jednym `/api/dane`. Tutaj każdy zapis to osobna Server
Action z własnymi regułami, więc kolejka jest wpinana świadomie, po jednym
miejscu.

### Service worker

`public/sw.js` podaje z pamięci wyłącznie GET-y i wyłącznie te udane. Dwa
adresy są z tego **wyłączone na sztywno**: `/api/*` i `/login`. Zwłaszcza
`/api/zdrowie` — odpowiedź z cache'a znaczyłaby wskaźnik ONLINE przy
wyciągniętym kablu, czyli dokładnie to kłamstwo, przed którym cały ten
mechanizm ma chronić.

## Kto prowadzi zajecia, a kto sie odbil

Kiosk zapisywal godzine odbicia prowadzacego, ale nikt nie sprawdzal, czy
odbija sie TEN prowadzacy. Kolega, ktory wzial zajecia za chorego i nie
wyklikal zastepstwa, dostawal "nie masz zapisu na te zajecia" - zajecia
zostawaly bez sladu prowadzacego, a wlasciciel nie dowiadywal sie o niczym.

Rozstrzygniecie siedzi w `judgeTrainerScan` (`lib/domain/class-qr.ts`) i ma
cztery wyniki:

| kto stanal przed kamera | co robimy |
| --- | --- |
| prowadzacy (z grafiku albo **potwierdzony** zastepca) | odbicie jak dotad |
| inny trener, nikt sie jeszcze nie odbil | odbicie **zapisujemy** + alert do wlasciciela |
| inny trener, ale odbicie prowadzacego juz jest | odmowa, bez alertu |
| nie trener | zwykla droga klubowicza (zapis na liscie) |

**Odbicie zastepcze zapisujemy, a nie odrzucamy.** Ktos te zajecia poprowadzil
i klub ma to widziec; odmowa zostawialaby zajecia z komunikatem "brak odbicia
trenera", czyli z gorsza informacja niz zadna.

Gdy przypisany prowadzacy odbije sie pozniej, jego odbicie **nadpisuje**
zastepcze - to on prowadzi zajecia i jego godzina ma byc w bazie. Slad po
tamtym odbiciu zostaje w historii aktywnosci.

Tylko PIERWSZY zastepczy skan zaklada odbicie, wiec kamera widzaca ten sam kod
przez kilkanascie klatek nie zasypuje wlasciciela powiadomieniami.

### Jak dowiaduje sie wlasciciel

Trzema drogami, bo kazda ma inna wade:

- **push** do wszystkich kont ADMIN - przychodzi od razu, ale bywa
  niedostarczony (brak zgody w przegladarce, wygasla subskrypcja),
- **e-mail** do tych samych kont - dochodzi pozniej, za to zostaje,
- **wpis w `/admin/aktywnosc`** (`TRAINER_CHECKIN_MISMATCH`) - nie przychodzi
  nigdzie, ale nie da sie go przegapic po fakcie.

Zaden z tych kanalow nie ma prawa wywrocic samego odbicia - obecnosc na sali
jest wazniejsza niz powiadomienie o niej. Wysylka siedzi w
`lib/services/admin-alert.ts`.

### Gdzie to widac na ekranach

`classifyTrainerCheckIn` ma stan `OTHER_TRAINER` ("Odbil sie inny trener",
czerwony) - na pulpicie wlasciciela, na kiosku i w panelu trenera. Zielone
"Trener odbity" przy cudzym odbiciu byloby klamstwem, ktorego wlasciciel nie ma
jak wylapac: patrzy na kafelek, nie w baze.

## Dane demonstracyjne

Wlasciciel ma pokazac, co system potrafi, na pelnej bazie - a potem to usunac.
Ekran **Ustawienia -> Dane demonstracyjne** (`/admin/ustawienia/dane-demo`,
wylacznie rola `ADMIN`; superadmin to w tym systemie zwykly ADMIN, wiec jedna
rola pokrywa oba konta).

Cala trudnosc siedzi w slowie "usunac": ma zniknac dokladnie to, co powstalo,
i nic wiecej. Kasowanie jednej kartoteki zabiera **kaskada dziesiec tabel**,
wiec pomylka o jeden rekord to skasowana historia prawdziwego klubowicza.

### Trzy rzeczy, na ktorych to stoi

**Spis (`DemoRecord`).** Kazdy zalozony rekord jest zapisywany razem
z kolejnoscia. Usuwanie idzie wylacznie po tym spisie, wstecz - nigdy "po
ksztalcie" (po nazwisku, adresie, dacie). Klub ma prawdziwych Nowakow. Wstecz,
bo klucze obce sa tu w wiekszosci RESTRICT (`Payment -> Member`,
`Member -> Trainer`, `Trainer -> Location`) i kasowanie od rodzica by sie
wywalilo. Lista dozwolonych modeli jest w `lib/domain/demo-data.ts`; model spoza
niej nie ma jak zostac usuniety, wiec nie ma prawa powstac.

**Odmowa zamiast szkody.** Przed skasowaniem czegokolwiek sprawdzamy, czy do
danych demo nie doczepilo sie cos prawdziwego (`demoBlockers`). `Booking`,
`Attendance` i `Rating` leca **kaskada z zajec** - gdyby realny klubowicz
zapisal sie na pokazowe zajecia, usuniecie demo zabraloby jego obecnosc bez
sladu. Wtedy nie kasujemy nic i mowimy, co stoi na drodze. To samo dotyczy
prawdziwego trenera przypisanego do sali pokazowej: ukryta tabela M2M
`_TrainerLocations` kasuje sie kaskada razem z sala, wiec straciłby przypisanie
bez bledu i bez sladu.

**Zamiatanie pochodnych.** Nocne joby potrafia dolozyc rekord o kliencie demo
juz PO wgraniu (alert retencyjny, ankieta odejscia, zamkniecie kasy sali
pokazowej). Spis ich nie zna, wiec po przejsciu spisu idzie jawne czyszczenie
wszystkiego, co wisi na kartotece, zajeciach i koncie demo. Takie rekordy
z definicji nie moga byc danymi klubu - dotycza osoby, ktora nie istnieje.

### Dane demo sa SAMODZIELNE

Wlasna sala `[DEMO] Sala pokazowa`, wlasny cennik, wlasni trenerzy, wlasna
kartoteka. Nic nie dokleja sie do prawdziwych zajec ani trenerow - i to nie
jest ostroznosc na wyrost:

- `lib/services/payroll.ts` liczy do wyplaty **kazda** sesje prowadzona przez
  trenera w miesiacu, bez filtra. Demo zajecia dopiete do Daniela podbilyby
  kwote, wedlug ktorej klub placi ludziom.
- `CashDay` sumuje wplaty gotowkowe per sala i dzien, a dnia raz zamknietego
  **nie da sie w tym systemie otworzyc**. Dlatego wplaty demo nigdy nie ida
  metoda `CASH`.

### Co jest wylaczone poza demo

- **publiczny harmonogram** (`/api/publiczny/harmonogram`) pomija sale demo -
  inaczej `czaplaboxing.pl` zapraszalby obcych ludzi na trening, ktorego nie ma,
  a `/zapis/[sessionId]` pozwolilby im sie zapisac,
- **powiadomienia** (`notify`, `notifyUser`, `alertAdmins`) pomijaja konta demo -
  push nigdzie nie dojdzie, e-mail wroci odbiciem, a SMS jest platny za sztuke,
- **joby** `detect-inactive`, `churn-and-survey`, `renewal-reminders`,
  `session-reminders`, `compute-scores` i `close-cash-day` filtruja `isDemo`.
  W `compute-scores` to nie kosmetyka: `clubMatured` jest wspolnym mianownikiem
  retencji dla **kazdego** trenera, a wynik przeklada sie na realna premie.

Konta demo powstaja **bez hasla** i na domenie `demo.invalid` (RFC 2606,
nigdy nie zostanie zarejestrowana), wiec nie sa droga wejscia do kartoteki
klubu ani adresem, pod ktory cokolwiek wyjdzie.

### Zakaz mieszania demo z pieniedzmi klubu

Generator trzyma demo osobno, ale ekran **Pieniadze -> Wplaty** pozwala wybrac
dowolne polaczenie: demonstracyjnego klienta, prawdziwy cennik, prawdziwa sale
i gotowke. Kazde takie polaczenie zostawia trwaly slad po usunieciu demo, wiec
`assertNoDemoMix` (`lib/services/pass.ts`) odmawia:

| co ktos probuje | dlaczego odmowa |
| --- | --- |
| klient demo + cennik klubu | zostaje licznik sprzedazy planu i wplata w kasie klubu |
| prawdziwy klient + cennik demo | po usunieciu demo karnet nie ma sie do czego odniesc |
| klient demo + prawdziwa sala | wplata wchodzi do zamkniecia kasy, ktorego nie da sie otworzyc |
| klient demo + gotowka | jw. - kasa sumuje gotowke per sala i dzien |

Straznik siedzi w jadrze sprzedazy, a nie w akcji ekranu: `sellPass`
i `recordPassPayment` sa wolane z dwoch miejsc (`/admin/wplaty` i `/trainer/kasa`).

### Kiedy usunac cala opcje

Dane demo sa pomyslane na okres PRZED oddaniem systemu klubowi: pokaz,
zaznajomienie sie, a potem usuniecie calej opcji. Do usuniecia po starcie:

- ekran `app/admin/ustawienia/dane-demo/` i pozycja w `NAV_GROUPS`
  (`app/admin/layout.tsx`),
- `lib/services/demo-data.ts`, `lib/services/demo-dataset.ts`,
  `lib/domain/demo-data.ts` wraz z testami,
- `prisma/proba-danych-demo.ts`.

**Kolumn `isDemo` i tabeli `DemoRecord` nie ma potrzeby kasowac** - migracja
kasujaca kolumny jest nieodwracalna, a puste kolumny z `default false` nic nie
kosztuja. Filtry `isDemo: false` w jobach i w publicznym harmonogramie moga
zostac: na bazie bez danych demo nie zmieniaja wyniku, a usuwanie ich to
ryzyko bez zysku.

**Przed usunieciem opcji trzeba usunac dane demo z bazy** - inaczej zostana
w klubie na zawsze, bo zniknie jedyne narzedzie, ktore umie je skasowac.

### Sprawdzenie

```
$env:NODE_OPTIONS = "--conditions=react-server"
npx.cmd tsx prisma/proba-danych-demo.ts
```

Wgrywa, sprawdza wlasciwosci bezpieczenstwa, probuje usunac przy doczepionym
prawdziwym zapisie (ma odmowic), usuwa i **porownuje stan klubu przed i po**.
Tylko baza deweloperska - skrypt wgrywa i kasuje.

## Hasła kadry

Konta trenerów powstały ze wspólnym hasłem tymczasowym wpisanym w skrypcie
zakładającym kadrę. Jedno hasło do wszystkich kont, widoczne dla każdego, kto
zajrzy do repozytorium, otwiera kartotekę klientów - dlatego przed oddaniem
systemu klubowi trzeba je wymienić:

```
npx tsx prisma/hasla-trenerow.ts                        # podgląd listy kont
npx tsx prisma/hasla-trenerow.ts --ustaw                # dev, nowe hasła
npx tsx prisma/hasla-trenerow.ts --env .env.vercel --ustaw
```

Hasła nie trafiają na ekran ani do repozytorium - lądują w pliku
`hasla-instruktorow-<data>.txt` obok projektu (wykluczonym z gita).
Rozdaje się je osobiście, potem plik się kasuje. Wypisanie ich w konsoli
zostawiłoby je w historii terminala.

Konto z hasłem nadanym przez klub dostaje `User.mustChangePassword`. Dopóki
flaga jest zapalona, strażnik sesji (`requireSession`) przepuszcza wyłącznie
na `/zmiana-hasla` - sprawdzenie siedzi w strażniku, a nie w przekierowaniu po
zalogowaniu, bo inaczej wystarczyłoby wpisać dowolny adres. Ekran zmiany hasła
korzysta z `requireSessionRaw`, żeby nie odsyłał sam do siebie. Wpisanie z
powrotem hasła otrzymanego od klubu jest odrzucane - wtedy nadal znałoby je
dwoje ludzi.

## Kontrole przed wysłaniem

CI na GitHubie sprawdza cztery rzeczy: `format:check`, `lint`, `typecheck`,
`test`. Te same kontrole odpala hak `.githooks/pre-push` - nieudany przebieg
na GitHubie kosztuje kilka minut czekania i maila o błędzie, hak kosztuje
kilkadziesiąt sekund i nie widzi go nikt poza autorem.

Hak jest w repozytorium, więc po sklonowaniu trzeba raz wskazać katalog:

```
git config core.hooksPath .githooks
```

**Formatowanie puszczaj na całym repo** (`npx prettier --write .`), a nie na
pojedynczych plikach. Formatowanie samych zmienionych plików zostawia resztę
w rozjeździe i CI wywala się na plikach, których nikt nie ruszał - tak
uzbierało się 48 plików naraz.

## Harmonogram na stronie klubu

Witryna `czaplaboxing.pl` ma zakładkę **Harmonogram zajęć** z grafikiem
dostępnym bez logowania. Cały kod tego widoku żyje tutaj, nie w WordPressie:

- `app/api/publiczny/harmonogram` - dane (bez autoryzacji, z CORS). Wychodzą
  stąd wyłącznie informacje o zajęciach; kształt odpowiedzi jest wypisany polem
  po polu w `lib/domain/public-schedule.ts`, więc nowa kolumna w `Session` nie
  wypchnie danych klientów na zewnątrz przez przypadek. Treningi indywidualne
  są pominięte - to czyjeś prywatne terminy.
- `public/harmonogram-widget.js` - wygląd i logika grafiku na witrynie.
- `app/zapis/[sessionId]` - strona pojedynczych zajęć. Otwiera się bez
  logowania (podgląd terminu), a hasła prosi dopiero przy zapisie. Sam zapis
  idzie tą samą akcją co planner w `/app`, więc reguły (zgody, karnet, wiek,
  komplet) są sprawdzane w jednym miejscu.

W WordPressie leżą dwie linijki - pojemnik i `<script src>` (kopia w
`wordpress/harmonogram-zajec.html`). Poprawka grafiku to wdrożenie aplikacji,
bez logowania do WordPressa.

Po zalogowaniu z takiego odsyłacza użytkownik wraca na stronę zajęć dzięki
parametrowi `?powrot=`; dozwolone adresy pilnuje `lib/domain/return-path.ts`
(inaczej byłby to otwarty przekierowywacz do phishingu).

## Wygląd listów

Każdy e-mail wychodzi w dwóch wersjach naraz: zwykły tekst i ta sama treść
w barwach klubu. Opakowanie robi `lib/domain/email-template.ts`, wołane
z jednego miejsca — `sendEmail` w `lib/services/notify.ts`. Nadawca (reset
hasła, potwierdzenie adresu, dane do logowania, powiadomienia) pisze zwykły
tekst i nie dotyka HTML-a; nowy rodzaj listu wygląda dobrze bez zmian w kodzie
wyglądu.

Akapit będący samym odsyłaczem zamienia się w czerwony przycisk - napis podaje
się przez `{ buttonLabel }`. Bez obrazków: znak firmowy jest napisem, bo Gmail
domyślnie blokuje grafikę od nieznanych nadawców, a wtedy list z samym logo
w nagłówku przychodzi pusty.

Wymuszenie zmiany hasła na dowolnym koncie (skrypt kadrowy obejmuje wyłącznie
trenerów, więc konto właściciela trzeba objąć osobno):

```
npx tsx prisma/wymus-zmiane-hasla.ts --env .env.vercel --email <adres> --ustaw
```

Sama flaga nie unieważnia starego hasła - jeśli hasło zna ktoś poza
właścicielem konta, trzeba je najpierw wymienić.
