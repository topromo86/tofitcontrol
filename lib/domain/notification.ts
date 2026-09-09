// Typy powiadomień i preferencje klienta.
//
// Zasada nadrzędna: na tej liście są wyłącznie powiadomienia, które system
// realnie wysyła. Ekran ustawień z przełącznikiem do czegoś, czego nikt nie
// nadaje, jest gorszy niż brak ekranu - klient włącza, czeka i traci zaufanie
// do całej reszty. Dodając nowy typ, dodaj najpierw nadawcę.

export type NotificationType =
  "BOOKING_CONFIRMATION" | "SESSION_REMINDER" | "BOOKING_SUGGESTION" | "CHECK_IN" | "MEDICAL_EXAM";

// PUSH i EMAIL są kanałami samodzielnymi - zaznaczone dostajesz zawsze.
// SMS jest wyłącznie zapasowy (wysyłany, gdy pozostałe zawiodą), bo kosztuje
// za każdą wiadomość. Patrz lib/services/notification.ts.
export type NotificationChannel = "PUSH" | "EMAIL" | "SMS";

export type NotificationMeta = {
  type: NotificationType;
  label: string;
  description: string;
  // Domyślnie włączone? Przypomnienie o zajęciach, na które ktoś sam się
  // zapisał, jest oczekiwane. Sugestie zapisu to już zachęta z naszej strony,
  // więc startują wyłączone - klient sam decyduje, czy chce być zaczepiany.
  defaultPush: boolean;
  // Czy e-mail jest domyślnie włączony (model opt-out). Potwierdzenie i
  // przypomnienie zapisu to poczta transakcyjna - klient zostawia klubowi adres
  // po to, żeby ją dostawać, więc idą mailem od razu (gdy podpięty SMTP), a
  // klient może je wyłączyć w ustawieniach. Zachęty (sugestie) startują off.
  defaultEmail: boolean;
  // Dotyczy tylko opiekunów (powiadomienie o dziecku).
  guardianOnly: boolean;
  // Czy w ogóle wysyłamy ten typ mailem. "Dziecko weszło na salę" ma sens
  // wyłącznie natychmiast - e-mail przeczytany po godzinie jest bezwartościowy,
  // a zaśmieca skrzynkę przy każdym treningu. Reszta typów mailem ma sens.
  emailSupported: boolean;
};

export const NOTIFICATION_TYPES: readonly NotificationMeta[] = [
  {
    type: "BOOKING_CONFIRMATION",
    label: "Potwierdzenie zapisu",
    description: "Zaraz po zapisaniu się na zajęcia wyślemy potwierdzenie z terminem.",
    defaultPush: true,
    defaultEmail: true,
    guardianOnly: false,
    emailSupported: true,
  },
  {
    type: "SESSION_REMINDER",
    label: "Przypomnienie o zajęciach",
    description: "Dzień wcześniej przypomnimy o zajęciach, na które jesteś zapisany.",
    defaultPush: true,
    defaultEmail: true,
    guardianOnly: false,
    emailSupported: true,
  },
  {
    type: "BOOKING_SUGGESTION",
    label: "Propozycje zapisu",
    description: "Gdy Twój stały termin jest wolny, a nie masz na niego zapisu - podpowiemy.",
    defaultPush: false,
    defaultEmail: false,
    guardianOnly: false,
    emailSupported: true,
  },
  {
    type: "MEDICAL_EXAM",
    label: "Badania lekarskie do zawodów",
    description:
      "Na dwa tygodnie przed końcem ważności badań przypomnimy, żeby umówić nowe. Dotyczy zawodników.",
    // Domyślnie oba kanały: bez ważnych badań zawodnik nie wystartuje, więc to
    // nie jest zachęta, tylko informacja, po którą sam by przyszedł.
    defaultPush: true,
    defaultEmail: true,
    guardianOnly: false,
    emailSupported: true,
  },
  {
    type: "CHECK_IN",
    label: "Wejście dziecka na salę",
    description: "Powiadomienie w momencie, gdy dziecko zeskanuje kod przy wejściu.",
    defaultPush: true,
    defaultEmail: false,
    guardianOnly: true,
    emailSupported: false,
  },
] as const;

export function notificationMeta(type: NotificationType): NotificationMeta {
  const meta = NOTIFICATION_TYPES.find((t) => t.type === type);
  if (!meta) throw new Error(`Nieznany typ powiadomienia: ${type}`);
  return meta;
}

export function isNotificationType(value: string): value is NotificationType {
  return NOTIFICATION_TYPES.some((t) => t.type === value);
}

// Typy widoczne dla danej roli. Klient bez podopiecznych nie ma po co
// oglądać przełącznika o wejściu dziecka na salę.
export function visibleTypes(isGuardian: boolean): NotificationMeta[] {
  return NOTIFICATION_TYPES.filter((t) => !t.guardianOnly || isGuardian);
}

export type StoredPreference = {
  type: NotificationType;
  push: boolean;
  email: boolean;
  sms: boolean;
};

// Rozstrzyga, czy wysłać. Brak zapisanej preferencji = wartość domyślna, więc
// nie trzeba zakładać wierszy przy tworzeniu konta.
export function wantsNotification(
  prefs: readonly StoredPreference[],
  type: NotificationType,
  channel: NotificationChannel,
): boolean {
  // Typ, którego nie wysyłamy mailem, nie da się włączyć nawet zapisaną
  // preferencją - inaczej stary wiersz w bazie ożywiłby wyłączony kanał.
  if (channel === "EMAIL" && !notificationMeta(type).emailSupported) return false;

  const stored = prefs.find((p) => p.type === type);
  if (stored) {
    if (channel === "PUSH") return stored.push;
    if (channel === "EMAIL") return stored.email;
    return stored.sms;
  }

  // Push i e-mail mają swoje domyślne (opt-out dla poczty transakcyjnej). SMS
  // domyślnie nigdy - kosztuje, więc wymaga świadomego włączenia.
  const meta = notificationMeta(type);
  if (channel === "PUSH") return meta.defaultPush;
  if (channel === "EMAIL") return meta.defaultEmail;
  return false;
}

// Odczyt formularza ustawień: zaznaczone pola przychodzą jako "TYPE:CHANNEL".
export function parsePreferenceForm(
  selected: readonly string[],
  isGuardian: boolean,
): StoredPreference[] {
  const allowed = new Set(visibleTypes(isGuardian).map((t) => t.type));
  const byType = new Map<NotificationType, StoredPreference>();

  for (const meta of visibleTypes(isGuardian)) {
    byType.set(meta.type, { type: meta.type, push: false, email: false, sms: false });
  }

  for (const raw of selected) {
    const [type, channel] = raw.split(":");
    if (!isNotificationType(type)) continue;
    if (!allowed.has(type)) continue;

    const entry = byType.get(type);
    if (!entry) continue;
    if (channel === "PUSH") entry.push = true;
    if (channel === "SMS") entry.sms = true;
    // Podrobiony formularz nie włączy maila tam, gdzie go nie wysyłamy.
    if (channel === "EMAIL" && notificationMeta(type).emailSupported) entry.email = true;
  }

  return [...byType.values()];
}
