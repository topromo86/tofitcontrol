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
wyłącznie `/kod-zajec` i **niczego nie skanuje** - pokazuje kod QR najbliższych
zajęć. Nie widzi kartoteki, pieniędzy ani grafiku - hasło do tego konta zna cały
klub, więc uprawnienia muszą być zerowe. Dlatego osobna rola, a nie "trener
techniczny".

Założenie/zmiana hasła konta kiosku (hasło w wywołaniu, nie w repozytorium):

```
npx tsx prisma/kiosk-account.ts --haslo <haslo>
npx tsx prisma/kiosk-account.ts --env .env.vercel --haslo <haslo>
```

Ekran odświeża się sam co 30 s (`<meta refresh>`, bez grama JS), więc kod
przeskakuje na kolejne zajęcia bez dotykania tabletu. Kiedy kiosk miał jeszcze
kamerę, to odświeżanie gasiło ją w połowie skanu i odczyt przepadał bez śladu -
po usunięciu kamery problem zniknął razem z nią.

## Jeden kod na zajęcia i nic poza nim

Odbicie obecności ma **dokładnie jedną drogę**: kiosk pokazuje kod tych zajęć,
a prowadzący i klubowicze skanują go własnym telefonem i potwierdzają u siebie
(`/z/[token]` -> `scanClassQr`). Kod pojawia się 15 minut przed startem
(`qrOpensMinutesBefore`) i gaśnie z końcem zajęć; każde zajęcia mają własny,
więc zdjęcie wczorajszego ekranu nikogo nie wpuści.

Wcześniej dróg było cztery i **to był problem sam w sobie**: człowiek na sali
musiał wiedzieć, który z kilku kodów zeskanować, a każda droga miała własne
reguły i własne wady. Zniknęły:

- **osobisty kod rotacyjny** (`/kod`, „Mój kod wejścia") wraz z całą warstwą
  `rotating-code` - klubowicz nie generuje już żadnego kodu,
- **stacja wejścia** (`/skaner`), na której personel skanował kody klubowiczów.
  Czytała `User.checkInToken`, którego **żaden ekran nie wyświetlał** - była
  ślepa od dawna i nikt tego nie zauważył, bo nikt na nią nie patrzył,
- **kamera kiosku** (`checkInAtStation`) - zgadywała, których zajęć dotyczy
  skan, bo kod osobisty mówił tylko, KTO stoi przed obiektywem,
- **kod na ścianie** (`/qr/[locationId]`) - stały kod na salę, więc dawał się
  sfotografować i użyć spoza budynku, a jako "zapas" był drugim kodem, przed
  którym trzeba by stawiać tabliczkę, kiedy go używać.

Rozstrzyganie „kto się odbił" nic na tym nie straciło: całe siedzi
w `checkInUserToSession` (`lib/services/class-qr.ts`), przez którą przechodzi
jedyna pozostała droga.

**Zapasem nie jest drugi kod, tylko człowiek.** Gdy tablet nie działa, nie ma
prądu albo klubowicz przyszedł bez telefonu, obecność wpisuje trener ze swojego
panelu i zatwierdza liczbę osób na sali - i to działa bez łącza (patrz niżej).
Kolejny kod QR jako zapas oznaczałby dwa kody na ścianie i pytanie „który?"
zadawane przez ludzi w trakcie rozgrzewki.

Po tej zmianie `User.checkInToken` i tabela `FloorCheckIn` (wejście do budynku)
nie mają już żadnego ekranu. **Kolumn nie kasujemy** - z tego samego powodu co
przy `isDemo`: migracja kasująca kolumnę jest nieodwracalna, a pusta kolumna nic
nie kosztuje. Dane demonstracyjne nadal zakładają wiersze `FloorCheckIn`
i nadal je sprzątają - to nie przeszkadza, a ruszanie sprawdzonej ścieżki
usuwania demo byłoby ryzykiem bez zysku.

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
osoby offline nie zrobią sobie nawzajem krzywdy. Po sprowadzeniu odbić do
jednego kodu zostały dwa zapisy, oba z panelu trenera:

- ręczne zaznaczenie obecności na liście „Dziś" (`OBECNOSC_RECZNA`),
- zatwierdzenie policzonej na sali liczby obecnych (`POTWIERDZENIE_OBECNOSCI`).

To nie jest zubożenie, tylko przesunięcie ciężaru tam, gdzie i tak był:
klubowicz skanuje kod **własnym telefonem**, najczęściej po swoim internecie,
więc padnięte wifi klubu go nie dotyczy. A gdy nie dotrze nic - obecność wpisuje
trener, i to właśnie ten zapis musi przeżyć brak łącza.

Reszta panelu bez sieci działa **tylko do odczytu** (service worker podaje
ostatnio otwarte ekrany z pamięci urządzenia). Kolejkowanie edycji karnetów,
kasy czy grafiku byłoby prostą drogą do skasowania cudzej zmiany.

### Jak wracają do bazy

Zapis bez łącza trafia do kolejki w `localStorage` (`lib/offline/queue.ts`)
razem z **godziną zdarzenia**, nie wysyłki. To nie jest kosmetyka: obecność
z 18:05 dopisana po powrocie wifi o 21:30 rozjechałaby godziny obecności,
statystyki frekwencji i okna zapisu. Do bazy idzie moment, w którym rzecz
wydarzyła się na sali.

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

System zapisywal godzine odbicia prowadzacego, ale nikt nie sprawdzal, czy
odbija sie TEN prowadzacy. Kolega, ktory wzial zajecia za chorego i nie
wyklikal zastepstwa, dostawal "nie masz zapisu na te zajecia" - zajecia
zostawaly bez sladu prowadzacego, a wlasciciel nie dowiadywal sie o niczym.

Prowadzacy odbija sie tak samo jak klubowicz: skanuje telefonem kod zajec
z kiosku. Roznice robi konto, nie kod - dlatego jeden kod wystarcza dla obu.

Rozstrzygniecie siedzi w `judgeTrainerScan` (`lib/domain/class-qr.ts`) i ma
cztery wyniki:

| kto zeskanowal kod zajec | co robimy |
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

Tylko PIERWSZY zastepczy skan zaklada odbicie - drugi trafia juz na
`ALREADY_CHECKED_IN`, wiec podwojne klikniecie nie zasypuje wlasciciela
powiadomieniami.

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
  a `/zapis/[sessionId]` pozwolilby im sie zapisac. Filtr musi byc w **obu**
  zapytaniach tego endpointu: zajecia i osobna lista sal. Lista sal dlugo go nie
  miala i nazwa `[DEMO] Sala pokazowa` wisiala publicznie na stronie klubu jako
  przycisk filtra (widget rysuje jeden przycisk na nazwe), mimo ze same zajecia
  byly odfiltrowane od poczatku,
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

Do usuniecia po starcie jest tez `prisma/porzadki-wplat.ts` - narzedzie do
sprzatania wplat testowych przed oddaniem systemu. Kasuje `Payment` naprawde
i bezpowrotnie, razem z korektami, realizacjami kart podarunkowych i wierszami
`CashDay`. W normalnej pracy klubu pomylke poprawia sie przyciskiem "Pomylka -
anuluj wplate", ktory zostawia slad; skrypt kasujacy historie pieniedzy nie ma
prawa lezec pod reka, gdy klub juz dziala.

### Sprawdzenie

```
$env:NODE_OPTIONS = "--conditions=react-server"
npx.cmd tsx prisma/proba-danych-demo.ts
```

Wgrywa, sprawdza wlasciwosci bezpieczenstwa, probuje usunac przy doczepionym
prawdziwym zapisie (ma odmowic), usuwa i **porownuje stan klubu przed i po**.
Tylko baza deweloperska - skrypt wgrywa i kasuje.

## Jedno wejscie za jeden trening

Obecnosc zapisuje sie trzema drogami (kiosk, stacja wejscia, reka trenera),
a kazda z nich zdejmuje wejscie z karnetu. Jadro siedzi w
`lib/services/attendance.ts`.

Regula jest jedna: **wejscie schodzi za OBECNOSC, nie za klikniecie.** Dlatego
`markManualAttendance` uzywa `createMany` ze `skipDuplicates` i zdejmuje wejscie
wylacznie wtedy, gdy `count === 1`, czyli gdy obecnosc naprawde powstala.
Wczesniej byl tam `upsert` z pustym `update` i bezwarunkowe zdjecie wejscia pod
spodem - drugie wywolanie nie zmienialo obecnosci i mimo to zabieralo kolejne
wejscie.

Powtorzenie nie jest tu wyjatkiem, tylko codziennoscia: pozycja wracajaca
z kolejki po powrocie lacza, ekran trenera z lista sprzed odbicia na kiosku
(Server Component nie odswiezy sie sam), dwa klikniecia na wolnym wifi.
A skutek byl niewidoczny: w bazie zostawal JEDEN wpis obecnosci, wiec ani
kartoteka, ani historia aktywnosci nie pokazywaly, ze cos poszlo dwa razy.
Klubowicz placil dwa wejscia za jeden trening i nie bylo ekranu, na ktorym dalo
by sie to cofnac.

Rozstrzyga baza (unikat `sessionId, memberId`), a nie odczyt sprzed chwili -
dwa rownolegle zapisy nie przesliznaja sie oba.

Sprawdzenie:

```
$env:NODE_OPTIONS = "--conditions=react-server"
npx.cmd tsx prisma/proba-obecnosci.ts
```

Zaklada karnet i rezerwacje, zaznacza te sama obecnosc dwa razy, sprawdza, ze
zeszlo jedno wejscie, i sprzata po sobie. Tylko baza deweloperska.

## Zadania nocne wpuszczaja tylko Vercela

Autoryzacja crona siedzi w `cronRequestAuthorized` (`lib/auth/cron.ts`) i jest
wolana z kazdego `app/api/cron/*/route.ts`.

Osobny plik nie dla porzadku. Kazdy endpoint sprawdzal to sam:

```ts
if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) ...
```

Gdy zmienna nie jest ustawiona, `${undefined}` daje napis "undefined", wiec
warunek przepuszcza doslowny naglowek `Bearer undefined` - a prawdziwe wywolanie
z Vercela (z sekretem) dostaje 401.
Odwrotnie niz mial dzialac: obcy wchodzi, wlasciciel nie, i to po cichu.
**Brak sekretu = odmowa dla wszystkich.**

Zadania nie sa niewinne: generuja grafik, zamykaja dzien kasowy, wysylaja
przypomnienia do wszystkich klubowiczow i przeliczaja wyniki trenerow, od
ktorych zalezy premia.

## Gdy cos padnie

Trzy ekrany, bo Next ma trzy rozne momenty awarii:

- `app/not-found.tsx` - adres, ktorego nie ma. Bez tego pliku Next pokazuje
  wlasny ekran po angielsku, a wola go tez siedem stron przez `notFound()`.
- `app/error.tsx` - wyjatek w ekranie albo w akcji serwerowej, w tym
  `ForbiddenError` ze straznika. Tresc jest ogolna celowo: na produkcji Next
  nie przekazuje tu komunikatu bledu (zostaje sam `digest`), wiec nie da sie
  rozroznic "nie masz dostepu" od "baza nie odpowiedziala". `digest`
  wyswietlamy - bez niego "cos nie dziala" jest nie do odszukania w logach.
- `app/global-error.tsx` - awaria w glownym layoucie, czyli zanim powstanie
  cokolwiek wspolnego. Zastepuje cale `<html>`, wiec rysuje je sam, **bez klas
  Tailwinda**: skoro layout sie nie zbudowal, nie zakladamy, ze arkusz stylow
  dojechal. Ta sama zasada i te same barwy co ekran offline w `public/sw.js`.

Do tego glowny layout tlumi blad zapytania o ustawienia klubu
(`app/layout.tsx`). Layout opakowuje KAZDY ekran, lacznie z logowaniem, a bierze
stamtad tylko nazwe zestawu czcionek - chwilowa niedostepnosc bazy nie ma prawa
zamknac klubowi drzwi do wlasnego systemu.

## Leady z Meta

Plik z Ads Managera wgrywa sie na `/leady`. Parser (`lib/domain/lead-import.ts`)
musi znosic to, co Meta realnie eksportuje - a to nie jest czysty CSV:

**Naglowek bywa inny, niz sie zaklada.** Plik klubu ma kolumne `Imie Nazwisko`
(bez spojnika "i"), a alias brzmial `imie i nazwisko`. Kolumna nie pasowala,
wiec w miejsce nazwiska wchodzil numer telefonu: 185 osob wjezdzalo do klubu
z imieniem `p:+48571277686`. Dlatego naglowki porownujemy **bez ogonkow
i bez wielkosci liter**, a aliasy sa w wersji ASCII.

**Numer przychodzi w pieciu postaciach naraz** - w jednym pliku byly wszystkie:

| co w pliku | co to znaczy |
| --- | --- |
| `p:+48571277686` | `p:` to marker typu pola z Meta, nie czesc numeru |
| `p:605687770` | jw., do tego numer krajowy bez kierunkowego |
| `48661535704` | kierunkowy BEZ plusa - najczestsza postac w eksporcie |
| `783925065` | dziewiec cyfr, numer polski |
| `31613737346` | numer zagraniczny (Holandia), tez bez plusa |

Rozstrzyga `parseLeadPhone`, ktore scina `p:`, dokłada plus numerom
z kierunkowym i oddaje reszte wspolnemu `parsePhone` (`lib/domain/phone.ts`).
Plus dokladamy **wylacznie tutaj**: w panelu "11 cyfr bez plusa" zwykle znaczy
literowke i ma sie odbic o komunikat, a w eksporcie z Meta znaczy kierunkowy.

Wczesniej import mial wlasna, slabsza normalizacje i zapisywal numer tak, jak
przyszedl. Ten sam czlowiek lezal w bazie jako `+48605687770`, `605687770`
i `48605687770` - czyli jako trzy osoby, ktorych nie dalo sie ze soba powiazac.

**Deduplikacja idzie po NUMERZE, nie po `externalId`.** Eksport z Ads Managera
nie ma kolumny `lead_id`, wiec `externalId` byl pusty dla kazdego wiersza
i cale zabezpieczenie nie robilo nic: wgranie tego samego pliku drugi raz
zakladalo komplet leadów od nowa. Numer jest jedyna rzecza, ktora Meta zbiera
obowiazkowo i ktora nalezy do jednej osoby. E-mail jako zapas, gdy numeru brak.

**Nigdy po nazwisku.** Klub ma prawdziwych Nowakow, a w eksportach imiona bywaja
jednowyrazowe (`Karolina`), ozdobne (`𝕵𝖚𝖗𝖆𝖓𝖉`) albo sa nazwa firmy - dwie rozne
osoby potrafia wygladac identycznie.

Istniejacego leada **nie nadpisujemy**. Klub mogl juz zmienic status, dopisac
notatke albo umowic termin; swiezy wiersz z pliku cofnalby to do stanu "Nowy".

### Domyslny widok to KOLEJKA PRACY, nie cala baza

`/leady` otwiera sie na zakladce **"Do obdzwonienia"** z licznikiem, obejmujacej
statusy `NEW` **i** `CALLBACK`.

Powod z uzywania: zaimportowany lead dostaje `NEW` ("Nowy"), a zakladka
"Do oddzwonienia" pokazuje wylacznie `CALLBACK` - czyli osobny stan "dzwonilem,
nie odebral". Swiezy import wpadal wiec do zakladki, w ktora nikt nie zaglada,
i wygladalo to tak, jakby import nie zadzialal.

Dla czlowieka z telefonem w reku oba statusy znacza to samo: **jest do
obdzwonienia**. Rozroznienie ma sens dopiero w statystykach lejka, wiec zostaje
w statusach, a nie w widoku, od ktorego zaczyna sie dzien.

Komunikat po imporcie mowi teraz, KTO byl juz w bazie (do pieciu nazwisk plus
"i N innych"), a nie tylko ilu ich bylo. Sama liczba nie odpowiada na pytanie,
czy to ci sami ludzie co poprzednio, czy plik mial zla kolumne i klub wlasnie
stracil nowych chetnych.

### Naprawa tego, co juz weszlo zepsute

`rawData` od poczatku trzyma CALY wiersz z pliku, wiec prawdziwe imie i surowy
numer sa w bazie obok. Leady zaimportowane starym parserem da sie naprawic bez
ponownego wgrywania czegokolwiek:

```
npx tsx prisma/napraw-leady.ts --env .env.vercel            # podglad
npx tsx prisma/napraw-leady.ts --env .env.vercel --ustaw    # wykonanie
```

Skrypt przepisuje imie z `rawData` tam, gdzie `fullName` nie ma ani jednej
litery, i sprowadza numery do jednej postaci. **Nie kasuje** leadow zdublowanych
przez powtorny import - kazdy z nich mogl juz dostac status albo notatke, wiec
scala sie je recznie; skrypt tylko mowi, ile ich jest.

### Sprawdzenie

```
$env:NODE_OPTIONS = "--conditions=react-server"
npx.cmd tsx prisma/proba-importu-leadow.ts
```

Wgrywa syntetyczny plik odtwarzajacy wszystkie dziwactwa realnego eksportu,
wgrywa go drugi raz (ma nie zalozyc nic) i odzyskuje imie ze zepsutego wpisu.
Plik testowy jest w skrypcie - prawdziwego eksportu nie ma w repozytorium
i byc nie moze, bo to dane osobowe 185 osob.

## Wyciszenie alertu "brak odbicia prowadzacego"

Alert na pulpicie mowi: minal termin, a kodu nikt nie zeskanowal. Powodow bywa
kilka i wiekszosc nie jest awaria - trener prowadzil i zapomnial, nikt nie
przyszedl na zajecia, tablet sie nie wlaczyl. Wlasciciel sprawdza to jednym
telefonem i wtedy alert ma zniknac, bo inaczej wisi do polnocy i uczy, zeby na
niego nie patrzec. **Alert, na ktory sie nie patrzy, nie jest alertem.**

Przycisk **"Wyjasnione"** (tylko ADMIN) zapisuje `trainerCheckInWaivedAt/By/Note`
na zajeciach. Wyciszone znikaja z licznika u gory, ale **zostaja na liscie**
wyszarzone, z komentarzem i przyciskiem "Cofnij" - znikanie bez sladu po jednym
kliknieciu byloby gorsze niz sam alert. Komentarz jest opcjonalny: wymuszanie
pisania przy kazdym wyciszeniu skonczyloby sie wpisywaniem kropki. Slad
w `ActivityLog` (`TRAINER_CHECKIN_WAIVED`) zostaje tak czy tak, bo to jest
pytanie o to, kto realnie pracowal.

Wyciszenie **nie zapisuje odbicia prowadzacego** - zajecia nadal nie maja sladu,
kto je poprowadzil, i tak ma zostac. Zapis odbicia wstecz zmienialby dane, od
ktorych liczy sie wyplata (`lib/services/payroll.ts` liczy kazda sesje
prowadzona przez trenera), wiec to jest decyzja o innym ciezarze.

## Przycisk, ktory mowi "robie"

`app/submit-button.tsx` (`SubmitButton`) pokazuje kolko i blokuje sie na czas
wysylki, korzystajac z `useFormStatus`.

Powod nie jest kosmetyczny: akcja serwerowa wyglada po kliknieciu dokladnie tak
samo jak brak klikniecia. Przy imporcie stu osiemdziesieciu leadow albo przy
sprzedazy karnetu na wolnym wifi to trwa kilka sekund, w ktorych czlowiek nie
wie, czy trafil w przycisk - a naturalna reakcja, czyli klikniecie drugi raz,
kosztuje **drugi karnet i druga wplate**, bo sprzedaz nie ma idempotencji.
Dlatego przycisk jest uzyty tam, gdzie podwojne klikniecie kosztuje pieniadze
(kasa) i tam, gdzie operacja trwa (import leadow).

`useFormStatus` musi siedziec w komponencie DZIECKU formularza, nie w tym samym,
co `<form>` - stad osobny plik zamiast flagi w miejscu uzycia.

## Karta klubowicza: rodzic i historia wplat

Karta (`/admin/klienci/[memberId]`) pokazuje teraz dwie rzeczy, ktorych wczesniej
nie bylo mimo tego, ze dane od poczatku byly w bazie.

**Rodzic i powiazanie kont.** Na karcie dziecka nie bylo o rodzicu ANI SLOWA -
jedyny "Opiekun" na ekranie to trener-opiekun, co dodatkowo mylilo. Numer do
rodzica trzeba bylo szukac po calej kartotece. Teraz widac: imie i nazwisko,
**adres logowania rodzica** (czyli odpowiedz na pytanie, do ktorego konta dziecko
jest podpiete), telefon jako odsylacz `tel:` i przejscie do jego karty, jesli
rodzic tez trenuje.

Odwrotna strona jest na karcie rodzica: lista dzieci na tym koncie. Idzie
osobnym zapytaniem, bo powiazanie prowadzi przez `User`, a nie przez `Member` -
opiekunem jest konto logowania, nie kartoteka, i rodzic nie musi miec wlasnej
kartoteki.

**Historia wplat** z przyciskiem "Pomylka - anuluj". To nie jest dublowanie
ekranu Finansow, tylko naprawa realnego braku: pojedyncza wplata byla widoczna
WYLACZNIE na plaskiej liscie czterdziestu ostatnich transakcji calego klubu, bez
wyszukiwarki. Przypadek "w piatek ktos sie pomylil u tego klienta" byl przez to
nie do obsluzenia, mimo ze kod anulowania istnial. Anulowanie ma byc tam, gdzie
pomylke realnie sie znajduje.

Sama karta dostala tez `requireRole("ADMIN")`. Wczesniej polegala wylacznie na
straznku w layoucie, a layout nie przelicza sie przy kazdej nawigacji po stronie
klienta - na ekranie z danymi wrazliwymi i historia wplat to za malo.

**Czego tu nadal nie ma:** nie da sie zmienic ani odpiac opiekuna dziecka.
Zmiana powiazania to decyzja o innym ciezarze (dostep do danych dziecka), wiec
czeka na osobna prosbe.

## Sprzedaz karnetu z kartoteki

Lista klientow (`/admin`) ma przy nazwisku **"Dodaj karnet"**, a gdy karnet jest
aktywny - **"Przedluz karnet"** (z podstawionym tym samym planem) i "Inny
karnet". Wszystkie prowadza do `/admin/wplaty?klient=<id>`, czyli do JEDYNEGO
formularza sprzedazy.

Swiadomie nie ma tu wlasnego formularza sprzedazy. Powielenie go w kartotece
oznaczaloby drugie miejsce z rabatami, kartami podarunkowymi, kontrola
demo/produkcja i data wplaty - a wiec drugie miejsce do rozjechania z pierwszym.
"Przedluzenie" nie jest osobna operacja: `sellPass` sam zaczyna nowy karnet od
`endsAt` starego (SPEC.md sekcja 2), wiec przedluzenie to ta sama sprzedaz, tylko
z podpowiedzianym planem.

Parametr `klient` (id) wygrywa z wyszukiwaniem po nazwisku `q`, bo wskazuje jedna
osobe - a klub ma prawdziwych Nowakow.

## Pomylka w kasie

Wplata wpisana pomylkowo ma dac sie cofnac, a wplata z piatku wpisana
w poniedzialek ma trafic do piatkowej kasy. Obie rzeczy dotykaja tego samego
miejsca, wiec sa opisane razem.

### "Usuniecie" to wpis odwracajacy, nie DELETE

Ekran Finansow ma przycisk **"Pomylka - anuluj wplate"** (tylko ADMIN, wymagany
powod). Dla klubu to jest usuniecie: kwota schodzi do zera i znika z kasy.
W bazie powstaje wpis odwracajacy ze wskazaniem oryginalu.

To nie jest ostroznosc na wyrost. Na `Payment` wskazuja **cztery** referencje -
karnet, korekta, sprzedana karta podarunkowa i jej realizacja - i wszystkie sa
`onDelete: SetNull`. Twarde `DELETE` **nie odbiloby sie o baze**: przeszloby
i zostawilo karte podarunkowa bez zapisu przychodu oraz osierocona realizacje.

Rozstrzyga `planCancellation` (`lib/domain/payment-correction.ts`), a wykonuje
`cancelPayment` (`lib/services/payment-correction.ts`). Cztery reguly, kazda
z powodu:

| regula | dlaczego |
| --- | --- |
| kwota liczona od SALDA, nie od kwoty pierwotnej | wplata 200 zl z wczesniejszym zwrotem 50 zl ma sie wyzerowac wpisem -150, nie -200 |
| nie da sie anulowac dwa razy | drugie klikniecie zrobiloby z klienta dluznika na kwote, ktorej nikt od niego nie bral |
| nie da sie anulowac wpisu korygujacego | korekta korekty to spirala, ktorej klub nie rozplata |
| wpis odwracajacy dostaje date ORYGINALU | inaczej gotowka z wtorku znikalaby z wtorkowej kasy dopiero w czwartek i oba dni klamalyby |

Anulowanie przywraca tez to, co powstalo obok pieniedzy: **saldo karty
podarunkowej** (wpisem przeciwnym, nie skasowaniem realizacji - historia karty
zostaje) i **licznik uzyc kodu rabatowego**. Karta wydana za anulowana wplate
jest gaszona, bo nie zostala oplacona.

**Karnet zostaje** - to osobna decyzja czlowieka, wiec akcja tylko OSTRZEGA, ze
karnet jest teraz niedoplacony. Bez tego ostrzezenia kasa trenera podsunelaby
pobranie tych samych pieniedzy drugi raz.

### Data wplaty

Ekran **Pieniadze -> Wplaty** ma pole daty z podstawiona dzisiejsza data.
Widzi je **wylacznie ADMIN** - rola sprawdzana jest w akcji serwerowej
(`app/payment-actions.ts`), nie samym ukryciem pola. Kasa trenera zapisuje to,
co dzieje sie teraz; wsteczne datowanie gotowki z jego ekranu byloby dziura
w mechanizmie, ktory ma jej pilnowac.

Data idzie do bazy jako **osobny parametr `recordedAt`**, nigdy jako `params.now`.
To rozroznienie jest tu krytyczne: od `now` wisi waznosc karnetu, kontrola
terminow kodow rabatowych i `joinedAt` (a z niego terminy wdrozenia i premia
trenera). Podstawienie wybranej daty jako `now` cofneloby karnet, a nie wplate.

Granice pilnuje `resolvePaymentDate`: bez przyszlosci, najwyzej
`MAX_BACKDATE_DAYS` (7) wstecz. Dzien wsteczny zapisujemy na **poludnie czasu
klubu** - lezy bezpiecznie w srodku doby, wiec wplata nie przeskoczy do
sasiedniego dnia kasowego ani przy przeliczaniu na UTC, ani przy zmianie czasu.

`Payment` dostal obok `recordedAt` **niezmienne `createdAt`**. Bez tego, po
dopuszczeniu daty wstecznej, zniknelaby jedyna informacja pozwalajaca odroznic
poprawiona pomylke od gotowki dosypanej do dnia, ktory juz sie rozliczyl.

### Poprawienie daty juz zapisanej wplaty

Ekrany Finansow i karty klubowicza maja przy wplacie pole daty i **"Zmien date"**
(tylko ADMIN). Realny przypadek: Daniel bierze pieniadze w piatek wieczorem,
a wpisuje je w sobote rano - pole daty przy sprzedazy pokrywa to tylko wtedy,
gdy pamietal o nim w chwili wpisywania.

Zmiana daty przelicza **DWA dni kasowe**: ten, z ktorego wplata wychodzi, i ten,
do ktorego wchodzi. Oba musza byc otwarte - inaczej odmowa z komunikatem
mowiacym, ktory dzien stoi na drodze.

**Wpisy korygujace jada razem z oryginalem.** Anulowanie dostaje date oryginalu,
wiec gdyby korekta zostala na miejscu, oba dni kasowe pokazalyby nieprawde.
Samej korekty nie da sie przeniesc osobno.

`createdAt` zostaje nietkniete - to jedyny slad, kiedy wiersz naprawde powstal,
i to on odroznia poprawiona pomylke od gotowki dosypanej wstecz.

**Waznosc karnetu idzie razem z data.** Karnet jest wazny N dni OD SPRZEDAZY,
a nie od chwili wpisania do systemu - gdy wlasciciel wpisuje w sobote pieniadze
wziete w piatek, karnet ma biec od piatku, inaczej klient dostaje dzien mniej
za te same pieniadze. Dotyczy to obu drog: sprzedazy z data wsteczna
(`sellPass` liczy `startsAt` od `recordedAt`) i pozniejszej zmiany daty
(`planPassShift` w `lib/domain/payment-correction.ts`).

Jest jeden przypadek, w ktorym karnetu ruszac NIE WOLNO: gdy klient mial jeszcze
wazny karnet, nowy startuje od `endsAt` starego, a nie od sprzedazy (SPEC.md
sekcja 2: "inaczej okradasz klienta z dni"). Taki karnet stoi w kolejce i data
wplaty nie ma z jego waznoscia nic wspolnego - przesuniecie nalozyloby dwa
karnety na siebie. Rozpoznajemy to po tym, czy karnet zaczyna sie w TYM SAMYM
DNIU co wplata. Waznosc przesuwa tez wylacznie PIERWSZA wplata karnetu - doplata
do zaleglosci nie jest momentem sprzedazy.

Naprawa karnetow sprzedanych, zanim to dzialalo:
`npx tsx prisma/porzadki-wplat.ts --env .env.vercel --napraw-waznosc` (podglad,
z `--usun` wykonanie). Pomija karnety stojace w kolejce.

### Dzien kasowy jest nietykalny po zamknieciu

`closeCashDay` przelicza `expectedGross` **wylacznie dla dni z `closedAt: null`**.
Wczesniej `update` szedl bezwarunkowo, wiec kazda korekta zrobiona wieczorem
podmieniala kwote w rozliczeniu, ktorego w tym systemie NIE DA SIE otworzyc -
wlasciciel widzial nazajutrz czerwone manko, ktorego wieczorem nie bylo.

Wplata z data wsteczna nie moze czekac na nocny job: on liczy tylko dzien,
w ktorym sie odpala, i nigdy nie wraca do poprzednich. Dlatego akcja wola
`recalcCashDay` dla wskazanego dnia **w tej samej transakcji**, a gdy tamten
dzien jest juz zamkniety - **cofa cala sprzedaz** z komunikatem. Lepiej
odmowic, niz zapisac pieniadze, ktorych rozliczenie nigdy nie zobaczy.

### Sprawdzenie

```
$env:NODE_OPTIONS = "--conditions=react-server"
npx.cmd tsx prisma/proba-korekty-wplat.ts
```

Sprzedaje karnet za gotowke, anuluje, probuje anulowac drugi raz, wystawia
wplate z data sprzed trzech dni, zamyka tamten dzien i sprawdza, ze ani
anulowanie, ani nocny job juz go nie ruszaja. Tylko baza deweloperska.

## Zawodnicy i badania lekarskie

Bez waznych badan zawodnik nie wystartuje, a klub dowiaduje sie o tym zwykle na
wadze, dzien przed walka. Dlatego termin jest w systemie, widoczny dla zawodnika
i przypominany z wyprzedzeniem.

**Flaga `isCompetitor` i `medicalExamValidUntil` sa na DWOCH modelach**: `Member`
i `Trainer`. Kadra tez startuje w zawodach. To swiadome powtorzenie zamiast
trzeciej tabeli wiazacej: pol sa dwa, a osobny model kosztowalby wiecej niz
powtorzona petla w nocnym zadaniu.

**Ustawia to kadra, nie zawodnik.** Termin bierze sie z zaswiadczenia
lekarskiego, ktore ktos musial zobaczyc. Klubowicz: wlasciciel albo trener
prowadzacy (`requireOwnsMember`). Kadra: wlasciciel. Zawodnik widzi swoj termin
na pulpicie - do odczytu.

Puste pole daty znaczy "brak badan", a nie "bez zmian" - inaczej nie dalo by sie
wyczyscic blednego wpisu.

### Kiedy przypominamy

`shouldRemind` (`lib/domain/medical-exam.ts`): przez cale
`MEDICAL_EXAM_REMINDER_DAYS` (14) dni przed koncem, wlacznie z dniem
wygasniecia - badania sa wazne do konca tego dnia.

**Okno, nie pojedynczy dzien.** Gdyby warunek brzmial "dokladnie 14 dni przed",
jedno nieudane uruchomienie nocnego zadania kasowaloby przypomnienie na zawsze.
Powtorkom zapobiega idempotencja wysylki (`notify` po `subjectId`), a nie waskie
okno.

Dni liczymy KALENDARZOWO w czasie klubu, nie roznica milisekund: badania wazne
"do 20 wrzesnia" sa wazne przez caly ten dzien, niezaleznie od godziny.

### Kto dostaje

Zawodnik i wlasciciel. Gdy zawodnikiem jest dziecko bez wlasnego konta,
przypomnienie idzie do jego **opiekuna** - inaczej nie doszloby do nikogo, kto
moze umowic wizyte.

Powiadomienie wlascicieli idzie przez `notify`, a **nie** przez `alertAdmins`:
tamten nie ma idempotencji, a przypominamy przez czternascie nocy z rzedu.
Wlasciciel dostalby ten sam alert czternascie razy i przestalby na nie patrzec.

### Sprawdzenie

```
$env:NODE_OPTIONS = "--conditions=react-server"
npx.cmd tsx prisma/proba-badan-zawodnikow.ts
```

Sprawdza DOBOR osob (`due`), nie sama wysylke: `notify` zwalnia rezerwacje, gdy
zaden kanal nie zadziala, a w probie SMTP jest wylaczony. Dlatego zadanie
raportuje `due` osobno od `athletesNotified` - roznica miedzy nimi jest na
produkcji jedynym sygnalem, ze poczta padla.

## Wiadomości SMS

Bramką jest **SMSAPI.pl**, a cała rozmowa z nią to jeden POST na `sms.do`
(`sendSmsDetailed` w `lib/services/notify.ts`). Świadomie bez pakietu npm od
dostawcy - z tego samego powodu, dla którego poczta idzie przez SMTP, a nie
przez API konkretnej firmy: zależność w `package.json` kosztowałaby build
i powierzchnię ataku, a zmiana dostawcy to i tak podmiana tej jednej funkcji.

Konfiguracja siedzi w dwóch zmiennych (`SMSAPI_TOKEN`, `SMSAPI_SENDER`), a jej
stan widać na ekranie **Ustawienia → Wiadomości SMS**. Bez tokenu system **nie
udaje wysyłki** - każda próba trafia do historii kontaktu jako „nie wysłano”.

### Nazwa nadawcy ma jedenaście znaków

Operatorzy przyjmują najwyżej 11 znaków bez polskich liter. **„CzaplaBoxing"
ma dwanaście i się nie mieści** - stąd `CzaplaBox`. Sprawdza to
`validateSmsSender`, i to przy ODCZYCIE konfiguracji, a nie dopiero przy
wysyłce: zła nazwa nie jest awarią do wykrycia w locie, bo operator odrzuci
wtedy każdą wiadomość, a klub zobaczy tylko „nie wysłano".

### Ogonki podwajają rachunek

Operator rozlicza **segmenty**, nie wiadomości. Wiadomość w alfabecie GSM mieści
160 znaków w segmencie; wystarczy jedno „ż", żeby całość przeszła na UCS-2
i próg spadł do 70. Powitanie leada ma 135 znaków, czyli z ogonkami idzie jako
**trzy** segmenty, a bez nich jako **jeden** - przy 300 wiadomościach
miesięcznie to 51 zł kontra 153 zł netto.

Dlatego `toGsmAlphabet` (`lib/domain/sms.ts`) zdejmuje ogonki **u nas**, choć
SMSAPI ma własny parametr `normalize`. Powód jest jeden: w historii kontaktu ma
być zapisane DOKŁADNIE to, co poszło na telefon. Gdyby ogonki ścinał dostawca,
klub czytałby w systemie treść z ogonkami, a klient dostałby inną - i nikt by
tego nie zauważył aż do reklamacji. `normalize=1` wysyłamy mimo to, ale jako
zabezpieczenie przed znakiem, którego nasza tablica nie zna.

Tablica zamienników łapie też znaki, które wchodzą do treści niezauważone:
cudzysłowy typograficzne z Worda, półpauzę, wielokropek jednym znakiem, twardą
spację. Każdy z nich w milczeniu przełącza wiadomość na UCS-2. Litery, które
w alfabecie GSM **są** (é, ü, à), zostawiamy - kaleczenie ich byłoby psuciem
treści bez powodu.

### Zgoda dotyczy KANAŁU, nie klienta

`ContactConsent` - osobny model od `Consent`, bo tamten wisi na kartotece
(`memberId`, wymagane), a zgodę na SMS daje najczęściej lead, który kartoteki
jeszcze nie ma i może nigdy nie mieć.

Wpisy są **nienaruszalne**, jak `Payment`. Cofnięcie zgody to nowy wiersz
z `granted: false`, nie edycja starego - trzeba udowodnić stan z konkretnego
dnia („czy wolno było wysłać SMS-a trzeciego marca"), a nie stan dzisiejszy.
Rozstrzyga **najpóźniejsze** oświadczenie (`consentInForce`); bez tego jedno
„tak" sprzed roku przebijałoby wczorajsze „proszę przestać".

**Lead z kampanii ma zgodę od chwili importu.** To nie domniemanie: importer
przyjmuje wyłącznie eksport z Ads Managera kampanii klubu, a człowiek sam
zostawił tam numer, odpowiadając na pytania o dojazd, cenę pierwszego treningu
i powód, dla którego chce trenować. Kupionych ani zewnętrznych adresów tą drogą
nie ma jak wprowadzić.

`grantedAt` to czas **importu**, nie zgłoszenia - eksport z Ads Managera nie ma
ani kolumny zgody, ani czasu zgłoszenia (plik klubu ma pięć kolumn: imię,
numer i trzy pytania kwalifikujące). Zapisujemy najwcześniejszy moment, który
klub jest w stanie wykazać, zamiast wpisywać datę, której plik nie niesie.

Dowodem pozostaje treść samego formularza, więc klub wkleja ją **raz**
w Ustawieniach → Wiadomości SMS, a system zapisuje ją dosłownie przy każdym
imporcie (`textSnapshot`). Kopia, nie odsyłacz: klauzula na stronie się zmieni,
a udowodnić trzeba to, co człowiek wtedy przeczytał.

Zgoda **idzie za człowiekiem** na kartotekę przy konwersji leada na klienta
(`attachLeadConsentsToMember`) - dopinamy `memberId` do istniejących wierszy,
a nie kopiujemy ich z nową datą. Kopia cofałaby dowód do dnia konwersji.

### Kiedy zgoda jest w ogóle potrzebna

Granicę wyznacza jedno pytanie: **czy ta wiadomość zmierza do tego, żeby
odbiorca coś kupił?**

| rodzaj wiadomości | zgoda |
| --- | --- |
| odwołane zajęcia, zmiana sali, potwierdzenie zapisu i wpłaty, zaległa płatność, kończące się badania, sprawy dziecka do rodzica, reset hasła | **nie** - to nie jest informacja handlowa |
| powitanie po rozmowie, oferta, promocja, zaproszenie na trening | **tak** |

Dlatego SMS jako **zapas po nieudanym pushu i mailu** (`notify`
w `lib/services/notification.ts`) nie pyta o żadną zgodę - tam nie ma czego
sprzedawać. Pyta natomiast powitanie leada (`saveCallSummaryAction`).

Blokada stoi **przed zapisem** podsumowania, tak samo jak sprawdzenie braku
numeru: komunikat „brak zgody" po fakcie byłby bez wartości, bo notatka już by
się zapisała, a powitanie i tak by nie poszło.

Wybór w formularzu rozmowy ma **trzy stany**, a nie checkbox: „nie zaznaczone"
musi znaczyć „nie pytałem", a nie „odmówił" - inaczej każda rozmowa bez tego
kliknięcia zamykałaby kanał. Odmowa jest tak samo warta zapisania jak zgoda,
bo chroni przed wysłaniem czegoś, czego ktoś sobie nie życzy.

### Leady wgrane, zanim to działało

```
npx tsx prisma/zgody-leadow.ts --env .env.vercel            # podgląd
npx tsx prisma/zgody-leadow.ts --env .env.vercel --ustaw    # wykonanie
```

Dopisuje zgodę leadom bez wpisu, z datą ich `importedAt`. **Nie rusza** tych,
które wpis już mają - także odmów. Treść formularza kampanii trzeba uzupełnić
w ustawieniach PRZED uruchomieniem: wpisy są nienaruszalne, więc poprawianie
ich po fakcie przeczyłoby całej konstrukcji.

### Sprawdzenie

```
$env:NODE_OPTIONS = "--conditions=react-server"
npx.cmd tsx prisma/proba-sms.ts
```

Wgrywa leada z syntetycznego pliku, sprawdza zgodę z importu, wycofuje ją,
udziela ponownie i przenosi na kartotekę - pilnując przy tym, że stare wpisy
nie znikają. Tylko baza deweloperska.

Samej wysyłki ta próba nie sprawdza (wymaga tokenu i kosztuje za sztukę). Do
tego jest przycisk **„Próba (bez wysyłki)"** na ekranie ustawień: przepuszcza
wiadomość przez pełną kontrolę bramki - token, nazwę nadawcy, numer - i nic nie
wysyła.

## Dane kontaktowe konta

**E-mail i telefon sa WYMAGANE przy rejestracji.** Numer siedzi na `User.phone`
(kartoteka `Member` nie ma wlasnego pola telefonu - kontaktem jest konto).

Powod jest z sali, nie z formularza: klub dzwoni czesciej, niz pisze. Przy
odwolanych zajeciach, zaleglej wplacie i dziecku, po ktore nikt nie przyszedl,
e-mail przeczyta sie wieczorem, a telefon odbiera sie od razu.

Numer sprawdza `parsePhone` (`lib/domain/phone.ts`) - to samo miejsce, ktore
sprawdza numery lead-ow i kadry. Druga, wlasna walidacja w rejestracji
skonczylaby sie dwiema roznymi regulami dla tego samego pola. Do bazy trafia
jedna postac (`+48...`), wiec ten sam czlowiek nie wyglada w kartotece jak dwie
osoby.

Regula obowiazuje w OBU drogach zakladania konta: formularza `/rejestracja`
i dokonczenia profilu po logowaniu Google (Google daje e-mail, ale nie daje
numeru).

**Profil DZIECKA nie wymaga numeru** - dziecko nie ma wlasnego konta,
a kontaktem jest rodzic. Dlatego walidacja jest rozdzielona:
`validateProfile` (konto uzytkownika, z numerem) i `validateChildProfile`
(profil dziecka, bez numeru).

Pusty numer daje wlasny komunikat ("Podaj numer telefonu."), a nie ogolne
"uzupelnij wszystkie pola" - czlowiek ma wiedziec, ktore pole go zatrzymalo.

Konta zalozone WCZESNIEJ numeru nie maja. Ekran **Konto** ma sekcje "Dane
kontaktowe" z polem numeru i ostrzezeniem, gdy go brakuje - inaczej wymog
dotyczylby wylacznie nowych kont, a stare zostalyby bez telefonu na zawsze.

## Rodzic i dziecko

**Konto dla osoby niepelnoletniej zaklada RODZIC ze swojego konta.** Dziecko nie
rejestruje sie samo i nie dostaje wlasnego loginu - jego kartoteka wisi przy
koncie rodzica (`Member.guardianUserId` wskazuje na `User`, nie na kartoteke,
wiec rodzic nie musi sam trenowac).

Powod nie jest formalny: to rodzic podpisuje zgody, odbiera powiadomienia
i odpowiada za dziecko. Konto musi wisiec przy nim od pierwszej chwili, a nie
byc doczepiane pozniej przez klub.

### Regula stoi w domenie, nie w ekranie

`selfRegistrationAllowed` (`lib/domain/registration.ts`) i wolane jest z OBU
drog samodzielnego zakladania konta: formularza `/rejestracja` i dokonczenia
profilu po logowaniu Google (`/dokoncz-profil`). Blokada w jednej zostawialaby
identyczne wejscie w drugiej.

Przy Google konto logowania juz ISTNIEJE (zalozylo je Google, zanim ktokolwiek
poznal date urodzenia), wiec nie mowimy "zaloz konto" - mowimy, ze to konto
staje sie kontem rodzica. Inaczej czlowiek zostawalby z kontem nie do uzycia
i z adresem e-mail zajetym na cudza kartoteke.

Sciezki KLUBOWE zostaja otwarte: admin dodaje dziecko recznie, bo klub naprawde
przyjmuje dziecko na sali, zanim przyjdzie rodzic. Taka kartoteka jest widoczna
na karcie jako "Brak przypisanego rodzica" z polem do powiazania.

### Jedno miejsce, ktore nadaje i zdejmuje opiekuna

`lib/services/guardian.ts` - `linkGuardian` i `unlinkGuardian`. Wczesniej
`guardianUserId` zapisywalo tylko zatwierdzenie prosby rodzica i nie bylo ZADNEJ
drogi zmiany ani zdjecia, wiec pomylka byla trwala i naprawialna wylacznie
recznym UPDATE na bazie klubu.

Trzy warunki, ktorych tamta droga nie sprawdzala:

| warunek | co bez niego |
| --- | --- |
| kartoteka nalezy do NIEPELNOLETNIEGO | jedno klikniecie oddaje obcej osobie pelny wglad w kartoteke doroslej klubowiczki |
| kartoteka nie ma jeszcze opiekuna | cicha podmiana dostepu do danych dziecka |
| opiekun to nie konto samego dziecka | nastolatek z loginem zostaje swoim opiekunem i podpisuje sobie zgode opiekuna |

Przypisanie **uniewaznia zgode opiekuna podpisana przez kogos innego niz ten
opiekun** (`revokedAt`, nie kasowanie wiersza) - rodzic zobaczy ja u siebie jako
do udzielenia. Zmiana rodzica idzie przez odpiecie i przypisanie od nowa: dwa
swiadome kroki, dwa wpisy w `ActivityLog` (`GUARDIAN_LINKED`/`GUARDIAN_UNLINKED`).

Admin ma obie strony tej samej operacji: na karcie dziecka **"Przypisz rodzica"**
(po adresie konta), na karcie rodzica **"Przepisz konto niepelnoletniego"**
(wybor z kartotek bez opiekuna).

### Zgody dziecka

Zgode `forMinorsOnly` (w praktyce: zgoda opiekuna prawnego) podpisuje WYLACZNIE
konto opiekuna. Wczesniej czternastolatek z wlasnym loginem podpisywal ja sam -
`requireMemberAccess` przepuszczal go jako "siebie", wiec dostep byl, a podpis
nic nie znaczyl.

Wycofanie zgody sprawdza teraz, czy zgoda nalezy do TEJ kartoteki
(`where: { id, memberId }`). Wczesniej straznik sprawdzal dostep do `memberId`
z formularza, a kasowanie szlo po samym `consentId` - czyli majac dostep do
wlasnej kartoteki dalo sie wycofac cudza zgode.

### 18. urodziny: powiazanie WYGASA

Nocne zadanie `recalc-minor-status` przelicza `isMinor` po 18. urodzinach
i **zdejmuje wtedy `guardianUserId`**.

Powod jest prawny, nie techniczny. Powiazanie daje rodzicowi pelny wglad
w kartoteke, prawo wycofywania zgod i drukowania dokumentow. Wobec osoby
doroslej to juz nie jest opieka nad dzieckiem, tylko dostep do cudzych danych -
i nie ma podstawy, zeby trwal dalej bez zgody tej osoby.

**Powrotu nie ma.** `linkGuardian` dziala wylacznie dla niepelnoletnich, wiec po
18. urodzinach nikt - takze admin - nie przypnie tego konta z powrotem.

Rodzic dostaje o tym e-mail. Nie idzie to przez `notify`, bo tamta droga szanuje
preferencje powiadomien, a utrata dostepu do danych dziecka nie jest czyms,
z czego sie rezygnuje w ustawieniach.

Gdy dziecko nie mialo wlasnego konta, wpis w historii mowi to wprost: klub ma
zalozyc mu login, bo inaczej pelnoletnia juz osoba nie zaloguje sie do niczego.

### Sprawdzenie

```
$env:NODE_OPTIONS = "--conditions=react-server"
npx.cmd tsx prisma/proba-opiekuna.ts
```

Przypisuje rodzica, sprawdza uniewaznienie zgody, probuje przypisac opiekuna
osobie pelnoletniej i drugiego opiekuna bez odpiecia (ma odmowic), odpina
i przypisuje ponownie. Tylko baza deweloperska.

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
