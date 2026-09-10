import "server-only";
import webpush, { type PushSubscription } from "web-push";
import { renderEmailHtml } from "@/lib/domain/email-template";
import {
  DEFAULT_SMS_SENDER,
  smsCost,
  smsRecipient,
  toGsmAlphabet,
  validateSmsSender,
} from "@/lib/domain/sms";

const vapidConfigured = Boolean(
  process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY,
);

if (vapidConfigured) {
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT ?? "mailto:kontakt@czaplaboxing.pl",
    process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY!,
    process.env.VAPID_PRIVATE_KEY!,
  );
}

// Web Push nie wymaga żadnego konta zewnętrznego (VAPID to protokół
// self-hostowany) - działa od razu. Zwraca false zamiast rzucać, żeby
// wywołujący mógł spokojnie spróbować fallbacku SMS.
export async function sendPushNotification(
  subscription: PushSubscription,
  payload: { title: string; body: string },
): Promise<boolean> {
  if (!vapidConfigured) {
    console.warn("[push] Brak skonfigurowanych kluczy VAPID - powiadomienie nie wysłane.");
    return false;
  }
  try {
    await webpush.sendNotification(subscription, JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

// Wysyłka e-mail przez SMTP. Świadomie SMTP, a nie API konkretnego dostawcy:
// działa z hostingiem klubu, z Gmailem i z każdym dostawcą transakcyjnym,
// więc wybór nie zamyka drogi do żadnego z nich.
//
// Bez kompletu zmiennych nic nie wysyłamy i mówimy o tym wprost - ekran
// ustawień pokazuje wtedy kanał jako niedostępny, zamiast udawać, że działa.
export type SmtpConfig = {
  host: string;
  port: number;
  user: string;
  password: string;
  from: string;
};

// Jedno miejsce odczytu konfiguracji SMTP ze środowiska. Zwraca null, gdy
// brakuje któregoś z obowiązkowych pól - reszta kodu nie musi znać nazw
// zmiennych ani powtarzać walidacji.
export function readSmtpConfig(): SmtpConfig | null {
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const password = process.env.SMTP_PASSWORD;
  if (!host || !user || !password) return null;

  return {
    host,
    port: Number(process.env.SMTP_PORT ?? 587),
    user,
    password,
    // Gdy nadawca nie podany wprost, używamy loginu - większość hostingów i
    // tak wymaga, żeby From zgadzał się z kontem uwierzytelniającym.
    from: process.env.SMTP_FROM ?? user,
  };
}

export function isEmailConfigured(): boolean {
  return readSmtpConfig() !== null;
}

// Status pojedynczej zmiennej środowiskowej na potrzeby ekranu admina.
// Wspólny dla poczty i SMS-ów, bo oba ekrany zadają to samo pytanie: czy to
// pole jest ustawione i co w nim siedzi.
//
// Świadomie NIE zwracamy wartości sekretów (hasło SMTP, token bramki) - tylko
// informację, czy są ustawione. Host, port i nazwa nadawcy nie są tajne,
// a pokazanie ich pomaga zweryfikować literówkę.
export type EnvFieldStatus = {
  key: string;
  label: string;
  required: boolean;
  set: boolean;
  // Podgląd wartości; dla hasła zawsze pusty.
  value: string | null;
};

export function describeSmtpStatus(): EnvFieldStatus[] {
  const host = process.env.SMTP_HOST ?? "";
  const port = process.env.SMTP_PORT ?? "";
  const user = process.env.SMTP_USER ?? "";
  const password = process.env.SMTP_PASSWORD ?? "";
  const from = process.env.SMTP_FROM ?? "";

  return [
    { key: "SMTP_HOST", label: "Serwer poczty", required: true, set: !!host, value: host || null },
    {
      key: "SMTP_PORT",
      label: "Port",
      required: false,
      set: !!port,
      value: port || "587 (domyślnie)",
    },
    { key: "SMTP_USER", label: "Login", required: true, set: !!user, value: user || null },
    { key: "SMTP_PASSWORD", label: "Hasło", required: true, set: !!password, value: null },
    {
      key: "SMTP_FROM",
      label: "Adres nadawcy",
      required: false,
      set: !!from,
      value: from || (user ? `${user} (użyty login)` : null),
    },
  ];
}

async function buildTransport(config: SmtpConfig) {
  // Import w środku funkcji: nodemailer jest zależnością wyłącznie serwerową
  // i nie ma powodu ciągnąć jej do bundla, gdy poczta jest nieskonfigurowana.
  const nodemailer = (await import("nodemailer")).default;
  return nodemailer.createTransport({
    host: config.host,
    port: config.port,
    // 465 to SMTPS (szyfrowanie od pierwszego bajtu), 587 to STARTTLS.
    secure: config.port === 465,
    auth: { user: config.user, pass: config.password },
  });
}

// Każdy list wychodzi w dwóch wersjach naraz: zwykły tekst i ta sama treść
// w barwach klubu (lib/domain/email-template.ts). Program pocztowy wybiera,
// co pokazać - więc czytelnik z zablokowanym HTML-em dostaje pełną treść,
// a nie pustą wiadomość. Opakowanie siedzi TUTAJ, a nie w każdym nadawcy
// z osobna: dzięki temu nowy rodzaj listu wygląda dobrze bez dopisywania
// czegokolwiek.
export async function sendEmail(
  to: string,
  subject: string,
  text: string,
  options?: { buttonLabel?: string },
): Promise<boolean> {
  const config = readSmtpConfig();
  if (!config) {
    console.warn(`[email] Brak konfiguracji SMTP - nie wysłano do ${to}: ${subject}`);
    return false;
  }

  try {
    const transporter = await buildTransport(config);
    await transporter.sendMail({
      from: config.from,
      to,
      subject,
      text,
      html: renderEmailHtml({ subject, text, buttonLabel: options?.buttonLabel }),
    });
    return true;
  } catch (error) {
    // Nie rzucamy: nieudany e-mail nie może wywrócić check-inu ani jobu.
    console.warn(`[email] Wysyłka do ${to} nie powiodła się:`, error);
    return false;
  }
}

// Wariant dla ekranu konfiguracji: zamiast połykać błąd, zwraca jego treść.
// Przy stawianiu poczty komunikat "hasło odrzucone" albo "host nieznany" jest
// dokładnie tym, czego admin potrzebuje - inaczej zostaje z samym "nie działa".
export async function sendEmailDiagnostic(
  to: string,
  subject: string,
  text: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const config = readSmtpConfig();
  if (!config) {
    return { ok: false, error: "Brak konfiguracji SMTP - uzupełnij zmienne środowiskowe." };
  }

  try {
    const transporter = await buildTransport(config);
    // verify() sprawdza połączenie i logowanie osobno od samej wysyłki, więc
    // przy błędzie od razu wiadomo, czy problem jest w haśle, czy w treści.
    await transporter.verify();
    await transporter.sendMail({
      from: config.from,
      to,
      subject,
      text,
      html: renderEmailHtml({ subject, text }),
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// ---------------------------------------------------------------------------
// SMS (SMSAPI.pl)
// ---------------------------------------------------------------------------
//
// Zwykły POST na jeden adres, bez pakietu npm od dostawcy - świadomie, z tego
// samego powodu, dla którego poczta idzie przez SMTP, a nie przez API
// konkretnej firmy: cała rozmowa z bramką to jedno zapytanie HTTP, więc
// zależność w package.json byłaby kosztem budowania i powierzchnią ataku bez
// żadnego zysku. Zmiana dostawcy to podmiana TEJ funkcji, nie usuwanie pakietu
// i przepisywanie wywołań.

const SMSAPI_URL = "https://api.smsapi.pl/sms.do";

// Bramka po drugiej stronie bywa wolna, a wysyłka wisi w akcji serwerowej,
// na którą patrzy człowiek. Lepiej powiedzieć "nie wysłano" po dziesięciu
// sekundach niż trzymać zablokowany formularz do końca świata.
const SMSAPI_TIMEOUT_MS = 10_000;

export type SmsConfig = {
  token: string;
  sender: string;
};

export function readSmsConfig(): SmsConfig | null {
  const token = process.env.SMSAPI_TOKEN;
  if (!token) return null;
  const sender = (process.env.SMSAPI_SENDER ?? DEFAULT_SMS_SENDER).trim();
  // Zła nazwa nadawcy nie jest awarią do wykrycia w locie: operator odrzuci
  // KAŻDĄ wysyłkę, a klub zobaczy tylko "nie wysłano". Sprawdzamy przy
  // odczycie, żeby ekran ustawień mógł pokazać powód.
  if (validateSmsSender(sender)) return null;
  return { token, sender };
}

export function isSmsConfigured(): boolean {
  return readSmsConfig() !== null;
}

export function describeSmsStatus(): EnvFieldStatus[] {
  const token = process.env.SMSAPI_TOKEN ?? "";
  const sender = (process.env.SMSAPI_SENDER ?? "").trim();
  const senderProblem = sender ? validateSmsSender(sender) : null;

  return [
    {
      key: "SMSAPI_TOKEN",
      label: "Token API",
      required: true,
      set: !!token,
      // Tokenu nie pokazujemy - to hasło do konta, z którego idą pieniądze.
      value: null,
    },
    {
      key: "SMSAPI_SENDER",
      label: "Nazwa nadawcy",
      required: false,
      set: !!sender,
      value: senderProblem
        ? `${sender} - ${senderProblem}`
        : sender || `${DEFAULT_SMS_SENDER} (domyślnie)`,
    },
  ];
}

export type SmsSendResult =
  | {
      ok: true;
      // Treść realnie wysłana - po zdjęciu ogonków. Zapisujemy JĄ, a nie
      // oryginał: klub ma widzieć to, co dostał klient.
      text: string;
      segments: number;
      // Ile punktów zeszło z konta wg operatora. Null, gdy bramka nie podała
      // (np. przy wysyłce próbnej).
      points: number | null;
      providerId: string | null;
    }
  | { ok: false; text: string; error: string };

// Kody błędów SMSAPI, które klub realnie zobaczy. Reszta idzie z komunikatem
// od dostawcy - lepszy angielski oryginał niż nasze zgadywanie.
const SMSAPI_ERRORS: Record<string, string> = {
  "101": "Bramka odrzuciła token - sprawdź SMSAPI_TOKEN.",
  "102": "Bramka odrzuciła logowanie - token wygasł albo został usunięty.",
  "103": "Brak środków na koncie SMSAPI - doładuj konto.",
  "105": "Bramka odrzuciła adres IP serwera - zdejmij ograniczenie IP w panelu SMSAPI.",
  "110": "Konto SMSAPI nie ma włączonej wysyłki SMS.",
  "203": "Nazwa nadawcy nie jest zatwierdzona w panelu SMSAPI.",
  "8": "Bramka odrzuciła numer odbiorcy jako niepoprawny.",
  "13": "Bramka nie ma dokąd wysłać - pusta lista odbiorców.",
};

// Wysyłka z pełnym wynikiem: treść, liczba segmentów i koszt.
//
// `test: true` przepuszcza wiadomość przez pełną walidację bramki (token,
// nazwa nadawcy, numer), ale nic nie wysyła i nic nie kosztuje - to jedyny
// sposób sprawdzenia konfiguracji, który nie budzi nikogo telefonem.
export async function sendSmsDetailed(
  phone: string,
  message: string,
  options?: { test?: boolean },
): Promise<SmsSendResult> {
  const text = toGsmAlphabet(message);
  const config = readSmsConfig();
  if (!config) {
    console.warn(`[sms] Brak skonfigurowanej bramki - nie wysłano do ${phone}: ${text}`);
    return { ok: false, text, error: "Bramka SMS nie jest skonfigurowana." };
  }

  const body = new URLSearchParams({
    to: smsRecipient(phone),
    from: config.sender,
    message: text,
    format: "json",
    encoding: "utf-8",
    // Zabezpieczenie, nie główna droga: ogonki zdejmujemy u siebie (patrz
    // toGsmAlphabet), a to łapie znak, którego nasza tablica nie zna, zanim
    // przestawi wiadomość na UCS-2 i podwoi rachunek.
    normalize: "1",
    ...(options?.test ? { test: "1" } : {}),
  });

  try {
    const response = await fetch(SMSAPI_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.token}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
      signal: AbortSignal.timeout(SMSAPI_TIMEOUT_MS),
    });

    const data = (await response.json()) as {
      error?: number | string;
      message?: string;
      list?: { id?: string; points?: number; status?: string; error?: string | null }[];
    };

    if (data.error !== undefined && data.error !== null) {
      const code = String(data.error);
      const error =
        SMSAPI_ERRORS[code] ?? data.message ?? `Bramka odrzuciła wysyłkę (kod ${code}).`;
      console.warn(`[sms] Bramka odrzuciła wysyłkę do ${phone}: ${code} ${data.message ?? ""}`);
      return { ok: false, text, error };
    }

    const first = data.list?.[0];
    if (!first) {
      return { ok: false, text, error: "Bramka nie potwierdziła przyjęcia wiadomości." };
    }
    if (first.error) {
      return { ok: false, text, error: `Bramka odrzuciła wiadomość: ${first.error}` };
    }

    return {
      ok: true,
      text,
      segments: smsCost(text).segments,
      points: typeof first.points === "number" ? first.points : null,
      providerId: first.id ?? null,
    };
  } catch (error) {
    // Nie rzucamy: nieudany SMS nie może wywrócić zapisu podsumowania rozmowy
    // ani nocnego zadania. Ta sama zasada co przy poczcie.
    const powod =
      error instanceof Error && error.name === "TimeoutError"
        ? "Bramka SMS nie odpowiedziała w ciągu 10 sekund."
        : error instanceof Error
          ? error.message
          : String(error);
    console.warn(`[sms] Wysyłka do ${phone} nie powiodła się:`, error);
    return { ok: false, text, error: powod };
  }
}

// Wariant dla wywołujących, których interesuje wyłącznie "poszło / nie poszło"
// - nocne zadania i fallback w `notify`.
export async function sendSms(phone: string, message: string): Promise<boolean> {
  const result = await sendSmsDetailed(phone, message);
  return result.ok;
}

// Powiadomienie "dziecko weszło na salę" (SPEC.md sekcja 3: "najwyżej
// oceniana funkcja w zajęciach dziecięcych").
//
// Sama wysyłka i preferencje żyją w lib/services/notification.ts - tutaj
// zostaje wyłącznie treść. Wcześniej ta funkcja czytała własne pola z User;
// po ujednoliceniu preferencji byłaby to druga, rozjeżdżająca się ścieżka.
export async function notifyGuardianCheckIn(
  guardianUserId: string,
  memberName: string,
  // Identyfikator zdarzenia dla idempotencji - jedno wejście na te zajęcia
  // to jedno powiadomienie, nawet gdyby check-in poszedł dwa razy.
  sessionId: string,
): Promise<void> {
  const { notify } = await import("@/lib/services/notification");
  await notify({
    userId: guardianUserId,
    type: "CHECK_IN",
    subjectId: sessionId,
    title: "Czapla Boxing",
    body: `${memberName} właśnie zameldował(a) się na sali.`,
  });
}
