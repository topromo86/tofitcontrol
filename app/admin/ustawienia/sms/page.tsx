import { Check, X } from "lucide-react";
import { requireRole } from "@/lib/auth/guard";
import { describeSmsStatus, isSmsConfigured, readSmsConfig } from "@/lib/services/notify";
import { getClubSettings } from "@/lib/services/settings";
import { prisma } from "@/lib/prisma";
import {
  LEAD_CONSENT_TEXT_MISSING,
  SMS_CONSENT_MISSING_CONTROLLER,
  SMS_MARKETING_TEST,
  buildSmsConsentText,
} from "@/lib/domain/contact-consent";
import {
  DEFAULT_SMS_SENDER,
  SMS_SENDER_MAX_LENGTH,
  smsCost,
  toGsmAlphabet,
} from "@/lib/domain/sms";
import { buildWelcomeSms } from "@/lib/domain/lead-import";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { PROSE_WIDTH } from "../../../shell";
import { saveConsentSettingsAction, sendTestSmsAction } from "./actions";

export default async function SmsSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; blad?: string }>;
}) {
  await requireRole("ADMIN");
  const { ok, blad } = await searchParams;

  const fields = describeSmsStatus();
  const configured = isSmsConfigured();
  const config = readSmsConfig();
  const { dataController, leadConsentText } = await getClubSettings();

  // Ile zgód na SMS klub ma zapisanych - liczba mówi więcej niż zapewnienie,
  // że "leady mają zgodę": widać, czy zapis realnie działa.
  const [zgodyUdzielone, zgodyWycofane] = await Promise.all([
    prisma.contactConsent.count({ where: { channel: "SMS", granted: true } }),
    prisma.contactConsent.count({ where: { channel: "SMS", granted: false } }),
  ]);

  // Podgląd kosztu na treści, która realnie idzie do leadów.
  const powitanie = buildWelcomeSms("Katarzyna");
  const powitanieGsm = toGsmAlphabet(powitanie);
  const kosztZOgonkami = smsCost(powitanie);
  const kosztBezOgonkow = smsCost(powitanieGsm);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-brand-red font-[family-name:var(--font-anton)] text-2xl uppercase">
          Wiadomości SMS
        </h1>
        <p className="text-muted-brand mt-1 text-sm">
          Bramka SMSAPI.pl, przez którą idą powitania leadów oraz wiadomości serwisowe, gdy
          powiadomienie push i e-mail nie dotrą.
        </p>
      </div>

      {ok ? (
        <p className="border-jade bg-surface text-text rounded-md border p-3 text-sm">{ok}</p>
      ) : null}
      {blad ? (
        <p role="alert" className="border-red bg-surface text-text rounded-md border p-3 text-sm">
          <b className="text-red">Błąd:</b> {blad}
        </p>
      ) : null}

      <section
        className={`rounded-md border p-4 ${configured ? "border-jade bg-surface" : "border-amber bg-surface"}`}
      >
        <p className="text-text text-sm font-medium">
          {configured ? (
            <>
              <Check className="text-jade mr-1 inline size-4" />
              Bramka SMS jest podłączona.
            </>
          ) : (
            <>
              <X className="text-amber mr-1 inline size-4" />
              Bramka SMS nie jest jeszcze gotowa - brakuje tokenu albo nazwa nadawcy jest
              niepoprawna.
            </>
          )}
        </p>
        {configured && config ? (
          <p className="text-muted-brand mt-1 font-mono text-xs">
            Wiadomości wychodzą jako: {config.sender}
          </p>
        ) : null}
      </section>

      <section>
        <h2 className="text-muted-brand font-mono text-xs tracking-widest uppercase">
          Stan konfiguracji
        </h2>
        <ul className="mt-2 flex flex-col gap-2">
          {fields.map((field) => (
            <li
              key={field.key}
              className="border-line bg-surface flex flex-wrap items-center justify-between gap-2 rounded-md border p-3"
            >
              <div className="min-w-0">
                <p className="text-text text-sm font-medium">
                  {field.label}
                  {!field.required ? (
                    <span className="text-muted-brand ml-2 font-mono text-[10px] tracking-widest uppercase">
                      opcjonalne
                    </span>
                  ) : null}
                </p>
                <p className="text-muted-brand font-mono text-xs">
                  {field.key}
                  {field.value ? ` = ${field.value}` : ""}
                </p>
              </div>
              {field.set ? (
                <span className="text-jade font-mono text-xs tracking-widest uppercase">
                  <Check className="mr-1 inline size-3" />
                  ustawione
                </span>
              ) : (
                <span
                  className={`font-mono text-xs tracking-widest uppercase ${field.required ? "text-red" : "text-muted-brand"}`}
                >
                  <X className="mr-1 inline size-3" />
                  {field.required ? "brak - wymagane" : `brak - użyje ${DEFAULT_SMS_SENDER}`}
                </span>
              )}
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2 className="text-muted-brand font-mono text-xs tracking-widest uppercase">
          Sprawdź, czy działa
        </h2>
        <p className="text-muted-brand mt-1 text-sm">
          <b className="text-text">Próba</b> przepuszcza wiadomość przez pełną kontrolę bramki
          (token, nazwa nadawcy, numer), ale nic nie wysyła i nic nie kosztuje.{" "}
          <b className="text-text">Wyślij</b> pokazuje to, czego próba nie pokaże: jak wiadomość
          wygląda na telefonie i jaka nazwa nadawcy się na nim wyświetla.
        </p>
        <form action={sendTestSmsAction} className="mt-3 flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <Label htmlFor="testPhone" className="font-mono text-xs tracking-widest uppercase">
              Numer do testu
            </Label>
            <Input
              id="testPhone"
              name="phone"
              type="tel"
              required
              placeholder="+48…"
              className="border-line bg-surface-2 w-48"
            />
          </div>
          <Button type="submit" name="tryb" value="proba" variant="outline" disabled={!configured}>
            Próba (bez wysyłki)
          </Button>
          <Button type="submit" name="tryb" value="wyslij" disabled={!configured}>
            Wyślij SMS testowy
          </Button>
        </form>
      </section>

      <section>
        <h2 className="text-muted-brand font-mono text-xs tracking-widest uppercase">
          Zgody na SMS
        </h2>
        <p className="text-muted-brand mt-1 text-sm">
          Zapisanych zgód: <b className="text-jade">{zgodyUdzielone}</b> · wycofanych:{" "}
          <b className={zgodyWycofane > 0 ? "text-red" : "text-text"}>{zgodyWycofane}</b>. Każdy
          lead zaimportowany z kampanii dostaje zgodę na SMS w chwili importu - to on sam zostawił
          numer w formularzu klubu, prosząc o kontakt w sprawie oferty. Wycofanie zgody w rozmowie
          zamyka kanał i powitanie już nie wyjdzie.
        </p>

        <form action={saveConsentSettingsAction} className="mt-3 flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <Label htmlFor="dataController" className="font-mono text-xs tracking-widest uppercase">
              Administrator danych
            </Label>
            <Input
              id="dataController"
              name="dataController"
              defaultValue={dataController ?? ""}
              placeholder="Pełna nazwa podmiotu, NIP, adres"
              className="border-line bg-surface-2"
            />
            <p className="text-muted-brand text-xs">
              {dataController ? (
                <>Wchodzi dosłownie do klauzuli zgody zbieranej w rozmowie telefonicznej.</>
              ) : (
                <span className="text-amber">{SMS_CONSENT_MISSING_CONTROLLER}</span>
              )}
            </p>
          </div>

          <div className="flex flex-col gap-1">
            <Label
              htmlFor="leadConsentText"
              className="font-mono text-xs tracking-widest uppercase"
            >
              Treść formularza kampanii
            </Label>
            <Textarea
              id="leadConsentText"
              name="leadConsentText"
              rows={3}
              defaultValue={leadConsentText ?? ""}
              placeholder="Wklej treść pytań i klauzuli z formularza Meta Lead Ads…"
              className="border-line bg-surface-2"
            />
            <p className="text-muted-brand text-xs">
              {leadConsentText ? (
                <>Zapisywana dosłownie przy każdym imporcie jako dowód, na co lead się zgodził.</>
              ) : (
                <span className="text-amber">{LEAD_CONSENT_TEXT_MISSING}</span>
              )}
            </p>
          </div>

          <Button type="submit" size="sm" className="self-start">
            Zapisz
          </Button>
        </form>

        {dataController ? (
          <div className="border-line bg-surface-2 mt-3 rounded-md border p-3">
            <p className="text-muted-brand font-mono text-[10px] tracking-widest uppercase">
              Klauzula, która trafi do bazy przy zgodzie z rozmowy
            </p>
            <p className="text-text mt-1 text-xs">{buildSmsConsentText(dataController)}</p>
          </div>
        ) : null}
      </section>

      <section>
        <h2 className="text-muted-brand font-mono text-xs tracking-widest uppercase">
          Ile to kosztuje
        </h2>
        <div className={`${PROSE_WIDTH} text-muted-brand mt-2 flex flex-col gap-3 text-sm`}>
          <p>
            Operator liczy <b className="text-text">segmenty</b>, nie wiadomości. Wiadomość bez
            polskich ogonków mieści 160 znaków w jednym segmencie; wystarczy jedno &bdquo;ż&rdquo;,
            żeby próg spadł do 70 i ta sama treść kosztowała dwa albo trzy razy tyle. Dlatego system
            zdejmuje ogonki przed wysyłką - klient dostaje &bdquo;Czesc&rdquo; zamiast
            &bdquo;Cześć&rdquo;, ale klub płaci raz.
          </p>
          <div className="border-line bg-surface-2 rounded-md border p-3 text-xs">
            <p className="text-muted-brand font-mono text-[10px] tracking-widest uppercase">
              Powitanie leada - to samo zdanie, dwa rachunki
            </p>
            <p className="text-text mt-2">
              Z ogonkami: {kosztZOgonkami.units} znaków, {kosztZOgonkami.encoding},{" "}
              <b className="text-red">{kosztZOgonkami.segments} segm.</b>
            </p>
            <p className="text-text">
              Po zdjęciu ogonków: {kosztBezOgonkow.units} znaków, {kosztBezOgonkow.encoding},{" "}
              <b className="text-jade">{kosztBezOgonkow.segments} segm.</b>
            </p>
            <p className="text-muted-brand mt-2 whitespace-pre-wrap">{powitanieGsm}</p>
          </div>
          <p>
            Nazwa nadawcy może mieć najwyżej {SMS_SENDER_MAX_LENGTH} znaków i nie przyjmuje ogonków
            - stąd <b className="text-text">{DEFAULT_SMS_SENDER}</b>, a nie
            &bdquo;CzaplaBoxing&rdquo;, które ma dwanaście.
          </p>
        </div>
      </section>

      <section>
        <h2 className="text-muted-brand font-mono text-xs tracking-widest uppercase">
          Kiedy zgoda jest potrzebna
        </h2>
        <div className={`${PROSE_WIDTH} text-muted-brand mt-2 flex flex-col gap-3 text-sm`}>
          <p>{SMS_MARKETING_TEST}</p>
          <p>
            <b className="text-text">Bez zgody:</b> odwołane zajęcia, zmiana godziny lub sali,
            potwierdzenie zapisu i wpłaty, zaległa płatność, kończące się badania zawodnika, sprawy
            dziecka do rodzica, reset hasła. To nie są informacje handlowe - obsługują coś, co już
            się wydarzyło.
          </p>
          <p>
            <b className="text-text">Ze zgodą:</b> powitanie, oferta, promocja, zaproszenie na
            trening. Leady z kampanii klubu tę zgodę mają od chwili importu; kto poprosi o
            zaprzestanie, ma zapisaną odmowę i nie dostanie już nic.
          </p>
        </div>
      </section>

      <section>
        <h2 className="text-muted-brand font-mono text-xs tracking-widest uppercase">
          Co ustawić na hostingu
        </h2>
        <div className={`${PROSE_WIDTH} text-muted-brand mt-2 flex flex-col gap-3 text-sm`}>
          <p>
            Token zakłada się w panelu SMSAPI (Ustawienia → Klucze API / OAuth) i wkleja do zmiennej
            środowiskowej na hostingu. Nazwa nadawcy wymaga wcześniejszego zatwierdzenia w panelu
            SMSAPI - do jednego dnia roboczego, w godzinach pracy biura.
          </p>
          <div className="border-line bg-surface-2 overflow-x-auto rounded-md border p-3">
            <pre className="text-text font-mono text-xs whitespace-pre">
              {`SMSAPI_TOKEN="token-z-panelu-smsapi"
SMSAPI_SENDER="${DEFAULT_SMS_SENDER}"   # zatwierdzona nazwa nadawcy, max ${SMS_SENDER_MAX_LENGTH} znaków`}
            </pre>
          </div>
          <p>
            Po ustawieniu zmiennych i wdrożeniu wróć tutaj: pola powyżej pokażą się jako
            &bdquo;ustawione&rdquo;, a przyciski testu się odblokują. Bez tokenu system nie udaje,
            że wysyła - każda próba trafia do historii kontaktu jako &bdquo;nie wysłano&rdquo;.
          </p>
        </div>
      </section>
    </div>
  );
}
