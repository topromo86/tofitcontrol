import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { getAccessibleMembers } from "@/lib/auth/guard";
import { Button } from "@/components/ui/button";
import { grantConsentAction, revokeConsentAction } from "./actions";

const ORDER = ["reg", "rodo", "health", "guardian", "image"];

function formatDate(date: Date): string {
  return new Intl.DateTimeFormat("pl-PL", {
    timeZone: "Europe/Warsaw",
    dateStyle: "medium",
  }).format(date);
}

export default async function ConsentsPage({
  searchParams,
}: {
  searchParams: Promise<{ member?: string; blad?: string }>;
}) {
  const params = await searchParams;
  const members = await getAccessibleMembers();
  if (members.length === 0) return null;

  const activeMember = members.find((m) => m.id === params.member) ?? members[0];

  const [consentTypes, consents] = await Promise.all([
    prisma.consentType.findMany(),
    prisma.consent.findMany({
      where: { memberId: activeMember.id, revokedAt: null },
      orderBy: { grantedAt: "desc" },
    }),
  ]);

  const applicable = consentTypes
    .filter((ct) => !ct.forMinorsOnly || activeMember.isMinor)
    .sort((a, b) => ORDER.indexOf(a.key) - ORDER.indexOf(b.key));

  const grantedByType = new Map(consents.map((c) => [c.consentTypeId, c]));

  return (
    <div className="flex flex-col gap-4">
      {params.blad ? (
        <p role="alert" className="border-red/40 bg-red/10 text-red rounded-md border p-3 text-sm">
          {params.blad}
        </p>
      ) : null}
      {members.length > 1 ? (
        <div className="flex gap-2">
          {members.map((m) => (
            <Link key={m.id} href={`/app/zgody?member=${m.id}`}>
              <Button
                type="button"
                variant={m.id === activeMember.id ? "default" : "outline"}
                size="sm"
              >
                {m.firstName}
              </Button>
            </Link>
          ))}
        </div>
      ) : null}

      <section className="border-line bg-surface flex flex-col gap-3 rounded-md border p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-muted-brand font-mono text-xs tracking-widest uppercase">
            Podpisany wydruk
          </h2>
          <Link href={`/zgody-druk/${activeMember.id}`}>
            <Button type="button" size="sm">
              Drukuj zgody do podpisu
            </Button>
          </Link>
        </div>
        {activeMember.consentsDeliveredAt ? (
          <p className="text-jade text-sm">
            Podpisane zgody potwierdzone przez klub: {formatDate(activeMember.consentsDeliveredAt)}.
          </p>
        ) : (
          <p className="text-muted-brand text-sm">
            Zaakceptuj zgody poniżej, wydrukuj, podpisz i dostarcz trenerowi lub do recepcji. Do
            potwierdzenia odbioru {activeMember.firstName} może zapisać się tylko na{" "}
            <b className="text-text">pierwsze zajęcia</b> - kolejne odblokują się po odbiorze.
          </p>
        )}
      </section>

      <ul className="flex flex-col gap-3">
        {applicable.map((ct) => {
          const granted = grantedByType.get(ct.id);
          return (
            <li key={ct.id} className="border-line bg-surface rounded-md border p-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-text font-medium">
                    {ct.label}
                    {ct.required ? "" : " (opcjonalna)"}
                  </p>
                  <div
                    className="text-muted-brand mt-1 text-sm"
                    dangerouslySetInnerHTML={{ __html: ct.bodyHtml }}
                  />
                  {granted ? (
                    <p className="text-jade mt-2 font-mono text-xs tracking-widest uppercase">
                      Podpisano {formatDate(granted.grantedAt)}
                    </p>
                  ) : null}
                </div>

                {granted ? (
                  <form action={revokeConsentAction}>
                    <input type="hidden" name="consentId" value={granted.id} />
                    <input type="hidden" name="memberId" value={activeMember.id} />
                    <Button type="submit" variant="outline" size="sm">
                      Wycofaj
                    </Button>
                  </form>
                ) : (
                  <form action={grantConsentAction}>
                    <input type="hidden" name="consentTypeId" value={ct.id} />
                    <input type="hidden" name="memberId" value={activeMember.id} />
                    <Button type="submit" size="sm">
                      Podpisz
                    </Button>
                  </form>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
