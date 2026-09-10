import { Info } from "lucide-react";
import { prisma } from "@/lib/prisma";
import { getAccessibleMembers, requireSession } from "@/lib/auth/guard";
import { visibleTypes, wantsNotification } from "@/lib/domain/notification";
import { getPreferences } from "@/lib/services/notification";
import { isEmailConfigured, isSmsConfigured } from "@/lib/services/notify";
import { Button } from "@/components/ui/button";
import { PROSE_WIDTH } from "../../shell";
import { PushSubscribeButton } from "./push-subscribe-button";
import { saveNotificationPreferencesAction } from "./actions";

export default async function NotificationSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ zapisano?: string }>;
}) {
  const session = await requireSession();
  const { zapisano } = await searchParams;

  const members = await getAccessibleMembers();
  const isGuardian = session.user.role === "GUARDIAN" || members.some((m) => m.isMinor);

  const user = await prisma.user.findUniqueOrThrow({
    where: { id: session.user.id },
    select: { pushSubscription: true, phone: true },
  });

  const prefs = await getPreferences(session.user.id);
  const types = visibleTypes(isGuardian);

  const pushReady = user.pushSubscription != null;
  // Gdy bramka SMS nie jest podłączona, mówimy o tym wprost, zamiast pozwolić
  // klientowi włączyć przełącznik, który nic nie robi.
  const smsAvailable = isSmsConfigured();
  const emailAvailable = isEmailConfigured();

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-brand-red font-[family-name:var(--font-anton)] text-2xl uppercase">
          Powiadomienia
        </h1>
        <p className="text-muted-brand mt-1 text-sm">Sam decydujesz, o czym Cię informujemy.</p>
      </div>

      {zapisano ? (
        <p className="border-jade bg-surface text-text rounded-md border p-3 text-sm">
          Ustawienia zapisane.
        </p>
      ) : null}

      <section className="border-line bg-surface rounded-md border p-4">
        <h2 className="text-muted-brand font-mono text-xs tracking-widest uppercase">
          To urządzenie
        </h2>
        <p className="text-muted-brand mt-1 text-sm">
          Powiadomienia push trzeba włączyć osobno na każdym urządzeniu i w każdej przeglądarce.
          {pushReady ? null : " Bez tego poniższe ustawienia nie mają jak zadziałać."}
        </p>
        <div className="mt-3">
          <PushSubscribeButton isSubscribed={pushReady} />
        </div>
      </section>

      <form action={saveNotificationPreferencesAction} className="flex flex-col gap-4">
        <section>
          <h2 className="text-muted-brand font-mono text-xs tracking-widest uppercase">
            Co chcesz dostawać
          </h2>
          <ul className="mt-2 flex flex-col gap-2">
            {types.map((meta) => {
              const push = wantsNotification(prefs, meta.type, "PUSH");
              const email = wantsNotification(prefs, meta.type, "EMAIL");
              const sms = wantsNotification(prefs, meta.type, "SMS");

              return (
                <li key={meta.type} className="border-line bg-surface rounded-md border p-3">
                  <p className="text-text text-sm font-medium">{meta.label}</p>
                  <p className="text-muted-brand mt-0.5 text-sm">{meta.description}</p>

                  <div className="mt-2 flex flex-wrap items-center gap-4">
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        name="pref"
                        value={`${meta.type}:PUSH`}
                        defaultChecked={push}
                        className="size-4"
                      />
                      Push
                    </label>

                    {/* "Dziecko weszło na salę" celowo bez maila - ta
                        informacja ma sens wyłącznie natychmiast. */}
                    {meta.emailSupported ? (
                      <label className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          name="pref"
                          value={`${meta.type}:EMAIL`}
                          defaultChecked={email}
                          disabled={!emailAvailable}
                          className="size-4"
                        />
                        E-mail
                        {!emailAvailable ? (
                          <span className="text-amber font-mono text-[10px] tracking-widest uppercase">
                            niedostępny
                          </span>
                        ) : null}
                      </label>
                    ) : null}

                    <label className="text-muted-brand flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        name="pref"
                        value={`${meta.type}:SMS`}
                        defaultChecked={sms}
                        disabled={!smsAvailable}
                        className="size-4"
                      />
                      SMS
                      {!smsAvailable ? (
                        <span className="text-amber font-mono text-[10px] tracking-widest uppercase">
                          niedostępny
                        </span>
                      ) : null}
                    </label>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>

        <Button type="submit" className="self-start">
          Zapisz ustawienia
        </Button>
      </form>

      <details className="border-line bg-surface rounded-md border p-3">
        <summary className="text-muted-brand hover:text-text cursor-pointer font-mono text-xs tracking-widest uppercase">
          <Info className="mr-1 inline size-3" />
          Jak to działa
        </summary>
        <div className={`${PROSE_WIDTH} text-muted-brand mt-3 flex flex-col gap-2 text-sm`}>
          <p>
            <b className="text-text">Push</b> to powiadomienie z przeglądarki - działa też, gdy
            aplikacja jest zamknięta, ale wymaga włączenia na każdym urządzeniu osobno.
          </p>
          <p>
            <b className="text-text">E-mail</b> działa niezależnie od push - jeśli zaznaczysz oba,
            dostaniesz i powiadomienie na ekranie, i wiadomość w skrzynce. Push znika po chwili,
            mail zostaje. Potwierdzenie zapisu i przypomnienie o zajęciach wysyłamy mailem{" "}
            <b className="text-text">domyślnie</b> - odznacz e-mail przy danej pozycji, jeśli nie
            chcesz ich dostawać.
            {emailAvailable
              ? ""
              : " Klub nie ma jeszcze skonfigurowanej poczty, więc ten kanał jest na razie nieaktywny."}
          </p>
          <p>
            <b className="text-text">SMS</b> wysyłamy tylko wtedy, gdy pozostałe kanały zawiodły -
            nigdy jako kolejny egzemplarz tej samej wiadomości, bo kosztuje za sztukę.
            {smsAvailable
              ? ""
              : " Klub nie ma jeszcze podpiętego dostawcy SMS, więc ten kanał jest na razie nieaktywny."}
          </p>
          <p>
            Niczego nie wysyłamy poza tą listą. Jeśli wszystko wyłączysz, nie dostaniesz od nas
            żadnego powiadomienia.
          </p>
        </div>
      </details>
    </div>
  );
}
