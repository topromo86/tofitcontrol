import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireLeadAccess } from "@/lib/auth/guard";
import {
  LEAD_SOURCE_LABEL,
  LEAD_STATUS_LABEL,
  LEAD_STATUS_ORDER,
  splitFullName,
} from "@/lib/domain/lead-import";
import {
  SMS_CONSENT_LABEL,
  SMS_CONSENT_SCRIPT,
  SMS_CONSENT_STYLE,
  smsConsentState,
} from "@/lib/domain/contact-consent";
import { smsConsentHistory } from "@/lib/services/contact-consent";
import { formatDate, formatDayTime } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  addLeadNoteAction,
  assignLeadAction,
  clearReminderAction,
  convertLeadToMemberAction,
  saveCallSummaryAction,
  setReminderAction,
  updateStatusAction,
} from "../actions";

const selectClass = "border-line bg-surface-2 text-text rounded-md border px-2 py-1.5 text-sm";
const fieldClass = "border-line bg-surface-2 text-text w-full rounded-md border px-2 py-2 text-sm";

export default async function LeadCardPage({
  params,
  searchParams,
}: {
  params: Promise<{ leadId: string }>;
  searchParams: Promise<{ blad?: string }>;
}) {
  await requireLeadAccess();
  const { leadId } = await params;
  const { blad } = await searchParams;

  const [lead, assignees, locations, trainers, zgodySms] = await Promise.all([
    prisma.lead.findUnique({
      where: { id: leadId },
      include: {
        assignedTo: { select: { id: true, name: true } },
        convertedMember: { select: { id: true, firstName: true, lastName: true } },
        notes: { include: { author: { select: { name: true } } }, orderBy: { createdAt: "desc" } },
        activities: {
          include: { actor: { select: { name: true } } },
          orderBy: { createdAt: "desc" },
        },
      },
    }),
    prisma.user.findMany({
      where: { OR: [{ role: "ADMIN" }, { role: "TRAINER", canAccessLeads: true }] },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
    prisma.location.findMany({ orderBy: { name: "asc" } }),
    prisma.trainer.findMany({
      where: { active: true },
      include: { user: true, location: true },
      orderBy: { user: { name: "asc" } },
    }),
    smsConsentHistory({ leadId }),
  ]);
  if (!lead) notFound();

  const stanZgody = smsConsentState(zgodySms);
  const ostatniaZgoda = zgodySms[0] ?? null;

  const raw = (lead.rawData ?? {}) as Record<string, string>;
  const suggestedName = splitFullName(lead.fullName);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href="/leady" className="text-muted-brand hover:text-brand-red text-xs">
          ← Leady
        </Link>
        <h1 className="font-display text-brand-red mt-1 text-2xl tracking-wide">{lead.fullName}</h1>
        <p className="text-muted-brand mt-1 font-mono text-xs tracking-widest uppercase">
          {LEAD_SOURCE_LABEL[lead.source]}
          {lead.campaign ? ` · ${lead.campaign}` : ""} · zaimportowano {formatDate(lead.importedAt)}
        </p>
      </div>

      {blad ? (
        <p role="alert" className="border-red/40 bg-red/10 text-red rounded-md border p-3 text-sm">
          {blad}
        </p>
      ) : null}

      {/* Dane kontaktowe */}
      <section className="border-line bg-surface grid grid-cols-1 gap-2 rounded-md border p-4 text-sm sm:grid-cols-2">
        <div>
          <span className="text-muted-brand">Telefon: </span>
          {lead.phone ? (
            <a href={`tel:${lead.phone}`} className="text-brand-red font-medium">
              {lead.phone}
            </a>
          ) : (
            <span className="text-muted-brand">brak</span>
          )}
        </div>
        <div>
          <span className="text-muted-brand">E-mail: </span>
          {lead.email ? (
            <a href={`mailto:${lead.email}`} className="text-brand-red font-medium">
              {lead.email}
            </a>
          ) : (
            <span className="text-muted-brand">brak</span>
          )}
        </div>
        {lead.convertedMember ? (
          <div className="sm:col-span-2">
            <span className="text-jade">Konto założone: </span>
            <Link
              href={`/admin/klienci/${lead.convertedMember.id}`}
              className="text-brand-red underline"
            >
              {lead.convertedMember.firstName} {lead.convertedMember.lastName}
            </Link>
          </div>
        ) : null}
        {Object.keys(raw).length > 0 ? (
          <details className="sm:col-span-2">
            <summary className="text-muted-brand cursor-pointer text-xs">
              Wszystkie pola z importu ({Object.keys(raw).length})
            </summary>
            <dl className="mt-2 grid grid-cols-1 gap-1 sm:grid-cols-2">
              {Object.entries(raw).map(([k, v]) => (
                <div key={k} className="text-xs">
                  <span className="text-muted-brand">{k}: </span>
                  <span className="text-text">{v}</span>
                </div>
              ))}
            </dl>
          </details>
        ) : null}
      </section>

      {/* Zgoda na kanał SMS. Osobno od danych kontaktowych, bo to nie jest dana
          kontaktowa, tylko odpowiedź na pytanie "czy wolno tam napisać". */}
      <section className="border-line bg-surface flex flex-col gap-2 rounded-md border p-4 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={`font-mono text-xs tracking-widest uppercase ${SMS_CONSENT_STYLE[stanZgody]}`}
          >
            {SMS_CONSENT_LABEL[stanZgody]}
          </span>
          {ostatniaZgoda ? (
            <span className="text-muted-brand text-xs">
              · {formatDayTime(ostatniaZgoda.grantedAt)}
              {ostatniaZgoda.source === "META_LEAD_ADS"
                ? " · formularz kampanii"
                : ostatniaZgoda.source === "ROZMOWA_TELEFONICZNA"
                  ? " · rozmowa telefoniczna"
                  : ""}
            </span>
          ) : null}
        </div>
        {ostatniaZgoda ? (
          <details>
            <summary className="text-muted-brand cursor-pointer text-xs">
              Na co dokładnie zgodził się ten kontakt ({zgodySms.length}{" "}
              {zgodySms.length === 1 ? "wpis" : "wpisy"})
            </summary>
            <ul className="mt-2 flex flex-col gap-2">
              {zgodySms.map((z) => (
                <li key={z.id} className="border-line bg-surface-2 rounded-md border p-2 text-xs">
                  <p className={z.granted ? "text-jade" : "text-red"}>
                    {z.granted ? "Zgoda udzielona" : "Zgoda wycofana"} ·{" "}
                    {formatDayTime(z.grantedAt)}
                  </p>
                  <p className="text-text mt-1 whitespace-pre-wrap">{z.textSnapshot}</p>
                  {z.note ? <p className="text-muted-brand mt-1">{z.note}</p> : null}
                </li>
              ))}
            </ul>
          </details>
        ) : (
          <p className="text-muted-brand text-xs">
            Ten kontakt nie ma zapisanej zgody na SMS - powstał, zanim system zaczął ją zapisywać.
            Potwierdź ją w rozmowie i zaznacz niżej przy podsumowaniu.
          </p>
        )}
      </section>

      {/* Konwersja lead -> klient (Etap 2) */}
      {lead.convertedMember ? null : (
        <section className="border-jade/40 bg-jade/5 flex flex-col gap-2 rounded-md border p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-text font-mono text-xs tracking-widest uppercase">
                Utwórz konto klienta
              </h2>
              <p className="text-muted-brand mt-1 text-sm">
                Lead potwierdził? Załóż kartotekę - historia tego leada zostanie z nią powiązana i
                będzie widoczna z karty klienta.
              </p>
            </div>
          </div>

          <details className="group mt-1">
            <summary className="bg-jade hover:bg-jade/90 inline-flex w-fit cursor-pointer list-none items-center gap-2 rounded-md px-4 py-2 text-sm font-medium text-white [&::-webkit-details-marker]:hidden">
              Utwórz konto
            </summary>

            <form action={convertLeadToMemberAction} className="mt-3 flex flex-col gap-4">
              <input type="hidden" name="leadId" value={lead.id} />

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <Label htmlFor="firstName">Imię</Label>
                  <Input
                    id="firstName"
                    name="firstName"
                    required
                    defaultValue={suggestedName.firstName}
                    className="border-line bg-surface-2"
                  />
                </div>
                <div>
                  <Label htmlFor="lastName">Nazwisko</Label>
                  <Input
                    id="lastName"
                    name="lastName"
                    required
                    defaultValue={suggestedName.lastName}
                    className="border-line bg-surface-2"
                  />
                </div>
              </div>

              <div>
                <Label htmlFor="convEmail">E-mail (kontakt)</Label>
                <Input
                  id="convEmail"
                  name="email"
                  type="email"
                  required
                  defaultValue={lead.email ?? ""}
                  className="border-line bg-surface-2"
                />
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <Label htmlFor="birthDate">Data urodzenia</Label>
                  <Input
                    id="birthDate"
                    name="birthDate"
                    type="date"
                    required
                    className="border-line bg-surface-2"
                  />
                </div>
                <div>
                  <Label htmlFor="sex">Płeć</Label>
                  <select id="sex" name="sex" required defaultValue="" className={fieldClass}>
                    <option value="" disabled>
                      Wybierz…
                    </option>
                    <option value="FEMALE">Kobieta</option>
                    <option value="MALE">Mężczyzna</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <Label htmlFor="homeLocationId">Lokalizacja domowa</Label>
                  <select
                    id="homeLocationId"
                    name="homeLocationId"
                    required
                    defaultValue=""
                    className={fieldClass}
                  >
                    <option value="" disabled>
                      Wybierz…
                    </option>
                    {locations.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <Label htmlFor="ownerTrainerId">Trener-opiekun</Label>
                  <select
                    id="ownerTrainerId"
                    name="ownerTrainerId"
                    required
                    defaultValue=""
                    className={fieldClass}
                  >
                    <option value="" disabled>
                      Wybierz…
                    </option>
                    {trainers.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.user.name} ({t.location.name})
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <Label htmlFor="weightKg">Waga (kg, opcjonalnie)</Label>
                  <Input
                    id="weightKg"
                    name="weightKg"
                    type="number"
                    step="0.1"
                    min="0"
                    className="border-line bg-surface-2"
                  />
                </div>
                <div>
                  <Label htmlFor="goal">Cel (opcjonalnie)</Label>
                  <Input id="goal" name="goal" className="border-line bg-surface-2" />
                </div>
              </div>

              <p className="text-muted-brand text-xs">
                Każdy klient ma jednego trenera-opiekuna (CLAUDE.md reguła 1). Konto logowania i
                karnet założysz później z karty klienta.
              </p>

              <Button type="submit" className="self-start">
                Utwórz konto i przejdź do karty
              </Button>
            </form>
          </details>
        </section>
      )}

      {/* Status */}
      <section className="flex flex-col gap-2">
        <h2 className="text-muted-brand font-mono text-xs tracking-widest uppercase">Status</h2>
        <div className="flex flex-wrap gap-2">
          {LEAD_STATUS_ORDER.map((s) => (
            <form key={s} action={updateStatusAction}>
              <input type="hidden" name="leadId" value={lead.id} />
              <input type="hidden" name="status" value={s} />
              <button
                type="submit"
                disabled={lead.status === s}
                className={`rounded-md border px-3 py-1.5 text-sm ${
                  lead.status === s
                    ? "border-brand-red text-brand-red font-medium"
                    : "border-line bg-surface text-text hover:border-brand-red"
                } disabled:cursor-default`}
              >
                {LEAD_STATUS_LABEL[s]}
              </button>
            </form>
          ))}
        </div>
      </section>

      {/* Przypomnienie + Przypisanie */}
      <section className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="border-line bg-surface flex flex-col gap-2 rounded-md border p-4">
          <h2 className="text-muted-brand font-mono text-xs tracking-widest uppercase">
            Ponowny kontakt
          </h2>
          {lead.reminderAt ? (
            <p className="text-amber text-sm">
              Umówiony na {formatDayTime(lead.reminderAt)}.
              <form action={clearReminderAction} className="mt-1">
                <input type="hidden" name="leadId" value={lead.id} />
                <button type="submit" className="text-muted-brand hover:text-brand-red text-xs">
                  Usuń przypomnienie
                </button>
              </form>
            </p>
          ) : (
            <p className="text-muted-brand text-xs">
              Nie może teraz rozmawiać? Ustaw termin ponownego kontaktu - lead trafi na górę listy.
            </p>
          )}
          <form action={setReminderAction} className="flex flex-wrap items-center gap-2">
            <input type="hidden" name="leadId" value={lead.id} />
            <input type="datetime-local" name="reminder" required className={selectClass} />
            <Button type="submit" size="sm" variant="outline">
              Ustaw
            </Button>
          </form>
        </div>

        <div className="border-line bg-surface flex flex-col gap-2 rounded-md border p-4">
          <h2 className="text-muted-brand font-mono text-xs tracking-widest uppercase">Opiekun</h2>
          <form action={assignLeadAction} className="flex flex-wrap items-center gap-2">
            <input type="hidden" name="leadId" value={lead.id} />
            <select
              name="assignedToUserId"
              defaultValue={lead.assignedToUserId ?? ""}
              className={selectClass}
            >
              <option value="">Nieprzypisany</option>
              {assignees.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
            <Button type="submit" size="sm" variant="outline">
              Zapisz
            </Button>
          </form>
        </div>
      </section>

      {/* Podsumowanie rozmowy + SMS powitalny (Etap 4) */}
      <section className="flex flex-col gap-3">
        <h2 className="text-muted-brand font-mono text-xs tracking-widest uppercase">
          Podsumowanie rozmowy
        </h2>
        <form action={saveCallSummaryAction} className="flex flex-col gap-3">
          <input type="hidden" name="leadId" value={lead.id} />
          <Textarea
            name="summary"
            rows={3}
            required
            placeholder="Co ustalono w rozmowie - zainteresowanie, plan, kolejny krok…"
            className="border-line bg-surface-2"
          />
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-1">
              <Label htmlFor="summaryPhone" className="font-mono text-xs tracking-widest uppercase">
                Numer telefonu
              </Label>
              <Input
                id="summaryPhone"
                name="phone"
                type="tel"
                defaultValue={lead.phone ?? ""}
                placeholder="+48…"
                className="border-line bg-surface-2 w-48"
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="summaryEmail" className="font-mono text-xs tracking-widest uppercase">
                E-mail
              </Label>
              <Input
                id="summaryEmail"
                name="email"
                type="email"
                defaultValue={lead.email ?? ""}
                placeholder="adres@…"
                className="border-line bg-surface-2 w-56"
              />
            </div>

            {/* Zgoda na SMS z rozmowy. Trzy stany, nie checkbox: "nie
                zaznaczone" musi znaczyć "nie pytałem", a nie "odmówił" -
                inaczej każda rozmowa bez tego kliknięcia zamykałaby kanał. */}
            <div className="flex flex-col gap-1">
              <Label htmlFor="zgodaSms" className="font-mono text-xs tracking-widest uppercase">
                Zgoda na SMS
              </Label>
              <select
                id="zgodaSms"
                name="zgodaSms"
                defaultValue="BEZ_ZMIAN"
                className="border-line bg-surface-2 text-text rounded-md border px-3 py-2 text-sm"
              >
                <option value="BEZ_ZMIAN">Bez zmian</option>
                <option value="UDZIELONA">Potwierdził w rozmowie</option>
                <option value="WYCOFANA">Prosi o zaprzestanie</option>
              </select>
            </div>

            {/* Powitanie jako wybór kanału, nie checkbox: klub ma dziś czynną
                pocztę, a bramkę SMS dopiero podepnie - i tak samo bywa
                z leadem, który zostawił tylko jedną daną kontaktową. */}
            <div className="flex flex-col gap-1">
              <Label
                htmlFor="welcomeChannel"
                className="font-mono text-xs tracking-widest uppercase"
              >
                Powitanie
              </Label>
              <select
                id="welcomeChannel"
                name="welcomeChannel"
                defaultValue="NONE"
                className="border-line bg-surface-2 text-text rounded-md border px-3 py-2 text-sm"
              >
                <option value="NONE">Nie wysyłaj</option>
                <option value="SMS">SMS powitalny</option>
                <option value="EMAIL">E-mail powitalny</option>
                <option value="BOTH">SMS i e-mail</option>
              </select>
            </div>
          </div>
          <p className="text-muted-brand text-xs">
            Podsumowanie zapisze się w notatkach i będzie widoczne także z karty klienta po
            założeniu konta. Powitanie wychodzi po zapisaniu notatki - jeśli bramka SMS albo poczta
            nie są podłączone, notatka i tak zostanie, a nieudana próba trafi do historii kontaktu.
          </p>
          <p className="text-muted-brand text-xs">
            Gdy rozmówca sam wróci do tematu wiadomości, wystarczy zapytać:{" "}
            <span className="text-text">&bdquo;{SMS_CONSENT_SCRIPT}&rdquo;</span> Odmowa jest tak
            samo warta zapisania jak zgoda - chroni przed wysłaniem czegoś, czego ktoś sobie nie
            życzy.
          </p>
          <Button type="submit" size="sm" className="self-start">
            Zapisz podsumowanie
          </Button>
        </form>
      </section>

      {/* Notatki */}
      <section className="flex flex-col gap-3">
        <h2 className="text-muted-brand font-mono text-xs tracking-widest uppercase">
          Notatki (widoczne tylko dla zespołu)
        </h2>
        <form action={addLeadNoteAction} className="flex flex-col gap-2">
          <input type="hidden" name="leadId" value={lead.id} />
          <Textarea
            name="body"
            rows={2}
            required
            placeholder="Co ustalono w rozmowie…"
            className="border-line bg-surface-2"
          />
          <Button type="submit" size="sm" className="self-start">
            Dodaj notatkę
          </Button>
        </form>
        {lead.notes.length > 0 ? (
          <ul className="flex flex-col gap-2">
            {lead.notes.map((n) => (
              <li key={n.id} className="border-line bg-surface rounded-md border p-3">
                <p className="text-text text-sm whitespace-pre-wrap">{n.body}</p>
                <p className="text-muted-brand mt-1 font-mono text-[10px] uppercase">
                  {n.author.name} · {formatDayTime(n.createdAt)}
                </p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-brand text-sm">Brak notatek.</p>
        )}
      </section>

      {/* Historia */}
      <section className="flex flex-col gap-3">
        <h2 className="text-muted-brand font-mono text-xs tracking-widest uppercase">
          Historia aktywności
        </h2>
        <ul className="flex flex-col gap-1.5">
          {lead.activities.map((a) => (
            <li key={a.id} className="text-muted-brand flex flex-wrap gap-x-2 text-xs">
              <span className="font-mono">{formatDayTime(a.createdAt)}</span>
              <span className="text-text">{a.summary}</span>
              {a.actor ? <span>· {a.actor.name}</span> : null}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
