import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/auth/guard";
import { Button } from "@/components/ui/button";
import { checkScanTime, SCAN_REJECTION_MESSAGE } from "@/lib/domain/class-qr";
import { effectiveTrainerId } from "@/lib/domain/substitute";
import { getClubSettings } from "@/lib/services/settings";
import { formatDayTime } from "@/lib/format";
import { confirmScanAction } from "./actions";

// Ekran po zeskanowaniu kodu zajęć. Wchodzi się tu z telefonu, więc jest tu
// dokładnie jedno pytanie i jeden przycisk.
//
// Logowanie jest wymagane: kod mówi, JAKIE to zajęcia, a konto mówi, KTO się
// odbija. Bez tego jeden zeskanowany kod odbijałby całą salę.
export default async function ScanPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ ok?: string; blad?: string }>;
}) {
  const { token } = await params;
  const { ok, blad } = await searchParams;

  const session = await requireSession();
  const settings = await getClubSettings();
  const now = new Date();

  const klasa = await prisma.session.findUnique({
    where: { qrToken: token },
    include: {
      location: true,
      trainer: { include: { user: true } },
      substituteTrainer: { include: { user: true } },
    },
  });

  const home =
    session.user.role === "ADMIN"
      ? "/admin"
      : session.user.role === "TRAINER"
        ? "/trainer"
        : "/app";

  if (!klasa) {
    return (
      <Shell>
        <p className="text-red text-sm">{SCAN_REJECTION_MESSAGE.UNKNOWN_CODE}</p>
        <HomeLink href={home} />
      </Shell>
    );
  }

  const leadTrainerUserId =
    effectiveTrainerId(klasa) === klasa.trainerId
      ? klasa.trainer.userId
      : (klasa.substituteTrainer?.userId ?? klasa.trainer.userId);
  const asTrainer = leadTrainerUserId === session.user.id;

  const timeError = checkScanTime(klasa, now, settings.qrOpensMinutesBefore);

  return (
    <Shell>
      <div className="text-center">
        <p className="text-muted-brand font-mono text-xs tracking-widest uppercase">
          {klasa.location.name}
        </p>
        <h1 className="font-display text-brand-red mt-1 text-2xl tracking-wide">{klasa.name}</h1>
        <p className="text-muted-brand mt-1 text-sm">{formatDayTime(klasa.startsAt)}</p>
      </div>

      {ok ? (
        <p
          role="status"
          className={`w-full rounded-md border p-3 text-center text-sm ${
            ok === "trener-nie-swoje"
              ? "border-amber/50 bg-amber/10 text-amber"
              : "border-jade/40 bg-jade/10 text-jade"
          }`}
        >
          {ok === "trener"
            ? "Odbicie prowadzącego zapisane. Miłego treningu!"
            : ok === "trener-po-czasie"
              ? `Odbicie zapisane, ale po terminie (${settings.trainerCheckInMinutesBefore} min przed startem). Właściciel to zobaczy.`
              : ok === "trener-nie-swoje"
                ? "Odbicie zapisane, ale tych zajęć nie prowadzisz według grafiku i nie masz potwierdzonego zastępstwa. Klub dostał o tym powiadomienie."
                : "Obecność zaliczona. Miłego treningu!"}
        </p>
      ) : null}

      {blad ? (
        <p
          role="alert"
          className="border-red/40 bg-red/10 text-red w-full rounded-md border p-3 text-center text-sm"
        >
          {blad}
        </p>
      ) : null}

      {!ok && timeError ? (
        <p className="border-line bg-surface text-muted-brand w-full rounded-md border p-3 text-center text-sm">
          {SCAN_REJECTION_MESSAGE[timeError]}
        </p>
      ) : null}

      {!ok && !timeError ? (
        <form action={confirmScanAction} className="w-full">
          <input type="hidden" name="token" value={token} />
          <Button type="submit" className="w-full py-6 text-base">
            {asTrainer ? "Odbij się jako prowadzący" : "Potwierdzam obecność"}
          </Button>
        </form>
      ) : null}

      <p className="text-muted-brand text-center text-xs">
        Odbijasz się jako <b className="text-text">{session.user.name}</b>.
      </p>

      <HomeLink href={home} />
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto flex min-h-full w-full max-w-sm flex-1 flex-col items-center justify-center gap-4 p-4">
      {children}
    </main>
  );
}

function HomeLink({ href }: { href: string }) {
  return (
    <Link href={href} className="text-muted-brand hover:text-brand-red text-sm underline">
      Wróć do aplikacji
    </Link>
  );
}
