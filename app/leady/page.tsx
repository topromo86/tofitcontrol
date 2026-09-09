import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { requireLeadAccess } from "@/lib/auth/guard";
import { LEAD_SOURCE_LABEL, LEAD_STATUS_LABEL, LEAD_STATUS_ORDER } from "@/lib/domain/lead-import";
import { formatDayTime } from "@/lib/format";
import { canFetchLeadDetails, isMetaLeadsConfigured } from "@/lib/services/meta-leads";
import { Textarea } from "@/components/ui/textarea";
import { importCsvAction } from "./actions";
import type { LeadStatus } from "@/app/generated/prisma/client";
import { SubmitButton } from "../submit-button";

const STATUS_STYLE: Record<LeadStatus, string> = {
  NEW: "bg-brand-red/10 text-brand-red",
  IN_PROGRESS: "bg-amber/10 text-amber",
  CALLBACK: "bg-amber/10 text-amber",
  CONFIRMED: "bg-jade/10 text-jade",
  CONVERTED: "bg-jade/10 text-jade",
  REJECTED: "bg-surface-2 text-muted-brand",
};

const IMPORT_MESSAGE = (p: {
  import?: string;
  created?: string;
  dup?: string;
  skip?: string;
  ktoDup?: string;
}): string | null => {
  if (p.import === "empty") return "Nie wskazano pliku ani treści CSV.";
  if (p.import !== "ok") return null;

  const nowych = Number(p.created ?? 0);
  const dubli = Number(p.dup ?? 0);
  const pominiete = Number(p.skip ?? 0);

  const czesci = [
    nowych > 0
      ? `Dodano ${nowych} nowych leadów - czekają na liście "Do obdzwonienia".`
      : "Nie dodano żadnego nowego leada.",
  ];
  if (dubli > 0) {
    // Kto konkretnie, a nie sama liczba: "duplikaty: 3" nie mówi, czy to ci
    // sami ludzie co ostatnio, czy plik miał złą kolumnę.
    const kto = p.ktoDup ? ` (${p.ktoDup}${dubli > 5 ? ` i ${dubli - 5} innych` : ""})` : "";
    czesci.push(`${dubli} osób było już w bazie${kto} - pominięte, nic im nie nadpisałem.`);
  }
  if (pominiete > 0) czesci.push(`${pominiete} wierszy bez danych kontaktowych pominiętych.`);
  return czesci.join(" ");
};

export default async function LeadsListPage({
  searchParams,
}: {
  searchParams: Promise<{
    status?: string;
    widok?: string;
    import?: string;
    created?: string;
    dup?: string;
    skip?: string;
    ktoDup?: string;
  }>;
}) {
  await requireLeadAccess();
  const params = await searchParams;
  const activeStatus = LEAD_STATUS_ORDER.includes(params.status as LeadStatus)
    ? (params.status as LeadStatus)
    : null;
  // Domyslny widok to KOLEJKA PRACY, a nie cala baza: "Nowy" (swiezo
  // zaimportowany, nikt jeszcze nie dzwonil) i "Do oddzwonienia" (dzwonil, nie
  // odebral). Obie znacza to samo dla czlowieka z telefonem w reku - jest do
  // obdzwonienia - a rozroznienie ma sens dopiero w statystykach lejka.
  // Bez tego swiezy import wpadal do "Nowy" i znikal z oczu, bo zakladka
  // "Do oddzwonienia" pokazuje wylacznie CALLBACK.
  const DO_OBDZWONIENIA: LeadStatus[] = ["NEW", "CALLBACK"];
  const widokKolejki = activeStatus === null && params.widok !== "wszystkie";
  const importMsg = IMPORT_MESSAGE(params);
  const metaConfigured = isMetaLeadsConfigured();
  // Dwa stopnie: gniazdo przyjmuje zgłoszenia (verify token + sekret), a token
  // strony dokłada automatyczne pobranie danych osoby.
  const metaFullData = canFetchLeadDetails();

  const [leads, doObdzwonienia] = await Promise.all([
    prisma.lead.findMany({
      where: activeStatus
        ? { status: activeStatus }
        : widokKolejki
          ? { status: { in: DO_OBDZWONIENIA } }
          : {},
      include: { assignedTo: { select: { name: true } } },
      orderBy: [{ reminderAt: { sort: "asc", nulls: "last" } }, { importedAt: "desc" }],
      take: 200,
    }),
    prisma.lead.count({ where: { status: { in: DO_OBDZWONIENIA } } }),
  ]);
  const now = new Date();

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="font-display text-brand-red text-2xl tracking-wide">Leady do kontaktu</h1>
        <p className="text-muted-brand mt-1 text-sm">
          Leady z kampanii Meta (Facebook / Instagram) do obdzwonienia. Importuj plik CSV
          wyeksportowany z Menedżera reklam lub formularzy Lead Ads.
        </p>
      </div>

      {importMsg ? (
        <p className="border-jade/40 bg-jade/10 text-text rounded-md border p-3 text-sm">
          {importMsg}
        </p>
      ) : null}

      {/* Import CSV */}
      <section className="border-line bg-surface flex flex-col gap-3 rounded-md border p-4">
        <h2 className="text-muted-brand font-mono text-xs tracking-widest uppercase">
          Import z Meta (CSV)
        </h2>
        <form action={importCsvAction} className="flex flex-col gap-3">
          <input
            type="file"
            name="file"
            accept=".csv,text/csv"
            className="text-text file:bg-brand-red text-sm file:mr-3 file:rounded-md file:border-0 file:px-3 file:py-1.5 file:text-white"
          />
          <details>
            <summary className="text-brand-red cursor-pointer text-sm">
              …albo wklej treść CSV
            </summary>
            <Textarea
              name="csv"
              rows={4}
              placeholder="full_name,email,phone_number,platform,campaign_name&#10;Jan Kowalski,jan@...,+48...,facebook,Boks jesień"
              className="border-line bg-surface-2 mt-2 font-mono text-xs"
            />
          </details>
          <SubmitButton pendingLabel="Wczytuję plik..." className="self-start">
            Importuj leady
          </SubmitButton>
        </form>

        {/* Gniazdo na automatyczny import z Meta Lead Ads (API). Aktywuje się po
            podłączeniu tokenu w zmiennych środowiskowych. */}
        <div className="border-line-soft mt-1 flex items-center gap-2 border-t pt-3">
          <span
            className={`inline-block size-2 rounded-full ${metaConfigured ? "bg-jade" : "bg-muted-brand"}`}
          />
          <p className="text-muted-brand text-xs">
            Automatyczny import z Meta (API Lead Ads):{" "}
            <b className={metaConfigured ? "text-jade" : "text-text"}>
              {metaConfigured ? "skonfigurowany" : "nieaktywny"}
            </b>
            .{" "}
            {metaConfigured
              ? metaFullData
                ? "Leady wpadają tu same, w sekundę po wysłaniu formularza."
                : "Zgłoszenia wpadają, ale bez tokenu strony dane osoby trzeba uzupełnić ręcznie."
              : "Gniazdo gotowe - w panelu Meta wskaż adres /api/leady/meta i uzupełnij META_VERIFY_TOKEN oraz META_APP_SECRET."}
          </p>
        </div>
      </section>

      {/* Widoki. Pierwszy jest kolejką pracy, nie filtrem statusu - to od niego
          zaczyna się dzień, więc jest domyślny i ma licznik. */}
      <div className="flex flex-wrap gap-2">
        <Link
          href="/leady"
          className={`rounded-md border px-3 py-1.5 text-sm ${widokKolejki ? "border-brand-red text-brand-red font-medium" : "border-line bg-surface text-text"}`}
        >
          Do obdzwonienia ({doObdzwonienia})
        </Link>
        <Link
          href="/leady?widok=wszystkie"
          className={`rounded-md border px-3 py-1.5 text-sm ${activeStatus === null && !widokKolejki ? "border-brand-red text-brand-red font-medium" : "border-line bg-surface text-text"}`}
        >
          Wszystkie
        </Link>
        {LEAD_STATUS_ORDER.map((s) => (
          <Link
            key={s}
            href={`/leady?status=${s}`}
            className={`rounded-md border px-3 py-1.5 text-sm ${activeStatus === s ? "border-brand-red text-brand-red font-medium" : "border-line bg-surface text-text"}`}
          >
            {LEAD_STATUS_LABEL[s]}
          </Link>
        ))}
      </div>

      {/* Lista */}
      {leads.length === 0 ? (
        <p className="text-muted-brand border-line bg-surface rounded-md border p-4 text-sm">
          {widokKolejki
            ? "Nikogo nie ma do obdzwonienia - wszyscy obsłużeni. Zaimportuj plik CSV powyżej."
            : "Brak leadów w tym widoku. Zaimportuj plik CSV powyżej."}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {leads.map((lead) => {
            const overdue = lead.reminderAt != null && lead.reminderAt <= now;
            return (
              <li
                key={lead.id}
                className="border-line bg-surface flex flex-wrap items-center justify-between gap-3 rounded-md border p-3"
              >
                <div className="min-w-0">
                  <p className="text-text font-medium">
                    {lead.fullName}
                    <span
                      className={`ml-2 rounded-full px-2 py-0.5 font-mono text-[10px] uppercase ${STATUS_STYLE[lead.status]}`}
                    >
                      {LEAD_STATUS_LABEL[lead.status]}
                    </span>
                  </p>
                  <p className="text-muted-brand mt-0.5 font-mono text-xs">
                    {lead.phone ? (
                      <a href={`tel:${lead.phone}`} className="hover:text-brand-red">
                        {lead.phone}
                      </a>
                    ) : (
                      "brak telefonu"
                    )}
                    {lead.email ? ` · ${lead.email}` : ""} · {LEAD_SOURCE_LABEL[lead.source]}
                    {lead.campaign ? ` · ${lead.campaign}` : ""}
                    {lead.assignedTo ? ` · opiekun: ${lead.assignedTo.name}` : ""}
                  </p>
                  {lead.reminderAt ? (
                    <p
                      className={`mt-0.5 font-mono text-xs ${overdue ? "text-red" : "text-amber"}`}
                    >
                      {overdue ? "⏰ zaległy kontakt: " : "przypomnienie: "}
                      {formatDayTime(lead.reminderAt)}
                    </p>
                  ) : null}
                </div>
                <Link
                  href={`/leady/${lead.id}`}
                  className="border-line bg-surface-2 text-text hover:text-brand-red shrink-0 rounded-md border px-3 py-1.5 font-mono text-xs uppercase"
                >
                  Otwórz
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
