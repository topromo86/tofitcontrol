"use server";

import { AuthError } from "next-auth";
import { redirect } from "next/navigation";
import { signIn } from "@/auth";
import { prisma } from "@/lib/prisma";
import { normalizeEmail } from "@/lib/domain/registration";
import { safeReturnPath } from "@/lib/domain/return-path";
import type { Role } from "@/app/generated/prisma/client";

const ROLE_HOME: Record<Role, string> = {
  ADMIN: "/admin/pulpit",
  TRAINER: "/trainer/pulpit",
  MEMBER: "/app/pulpit",
  GUARDIAN: "/app/pulpit",
  // Tablet na sali nie ma pulpitu - po zalogowaniu od razu kiosk.
  KIOSK: "/kod-zajec",
};

// Gałęzie, do których wolno odesłać po zalogowaniu. Klient trafia tu ze strony
// klubu ("zapisz się na te zajęcia"), więc po wpisaniu hasła ma wrócić do tych
// zajęć, a nie na ogólny pulpit - inaczej musiałby szukać terminu od nowa.
const RETURN_PREFIXES = ["/app", "/zapis"] as const;

export type LoginState = { error?: string };

export async function loginAction(_prevState: LoginState, formData: FormData): Promise<LoginState> {
  const email = formData.get("email");
  const password = formData.get("password");
  const returnTo = formData.get("powrot");

  if (typeof email !== "string" || typeof password !== "string" || !email || !password) {
    return { error: "Podaj e-mail lub login oraz hasło." };
  }

  try {
    await signIn("credentials", { email, password, redirect: false });
  } catch (err) {
    if (err instanceof AuthError) {
      // Nie "Nieprawidłowy e-mail lub hasło": kto loguje się nazwą "kiosk",
      // czytał to jako "system wymaga adresu" i szukał błędu tam, gdzie go nie
      // było. Komunikat zostaje CELOWO nierozróżniający, które z dwóch pól jest
      // złe - inaczej byłby to sposób na sprawdzanie, które konta istnieją.
      return { error: "Nieprawidłowy login lub hasło." };
    }
    throw err;
  }

  // Nie polegamy tu na auth() zaraz po signIn() - świeżo ustawiony cookie sesji
  // bywa niewidoczny w tym samym wywołaniu Server Action (potwierdzone empirycznie).
  // Ta sama normalizacja co przy sprawdzaniu hasła - inaczej "Kiosk" zalogowałby
  // się poprawnie, ale nie znaleźlibyśmy konta do wyboru ekranu startowego.
  const user = await prisma.user.findUnique({
    where: { email: normalizeEmail(email) },
    select: { role: true, mustChangePassword: true },
  });
  // Hasło nadane przez klub zna dwoje ludzi - do systemu wchodzi się dopiero
  // po ustawieniu własnego.
  if (user?.mustChangePassword) redirect("/zmiana-hasla");

  const home = ROLE_HOME[user?.role ?? "MEMBER"];
  // Adres powrotny działa wyłącznie dla kont, które faktycznie zapisują się na
  // zajęcia. Trener czy tablet kiosku po zalogowaniu ma iść na swój ekran,
  // nawet jeśli w adresie zostało "?powrot=/zapis/...".
  const canReturn = user?.role === "MEMBER" || user?.role === "GUARDIAN" || user == null;
  redirect(canReturn ? safeReturnPath(returnTo, RETURN_PREFIXES, home) : home);
}
