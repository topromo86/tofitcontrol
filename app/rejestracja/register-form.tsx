"use client";

import Link from "next/link";
import Image from "next/image";
import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { calculateAge } from "@/lib/domain/booking";
import { PASSWORD_MIN_LENGTH, SELF_REGISTER_MIN_AGE } from "@/lib/domain/registration";
import { GoogleButton } from "../google-button";
import { registerAction, type RegisterState } from "./actions";
import { PHONE_HINT } from "@/lib/domain/phone";

const initialState: RegisterState = {};

const fieldClass = "border-line bg-surface-2";
const labelClass = "font-mono text-xs tracking-widest uppercase";

type Option = { id: string; name: string };

export function RegisterForm({
  locations,
  trainers,
  googleEnabled,
}: {
  locations: Option[];
  trainers: Option[];
  googleEnabled?: boolean;
}) {
  const [state, formAction, isPending] = useActionState(registerAction, initialState);

  // Podpowiedź na żywo: gdy wybrana data daje wiek poniżej granicy samodzielnej
  // rejestracji, od razu mówimy, że to konto małoletniego - zamiast czekać na
  // odrzucenie po wysłaniu. Ten sam calculateAge co na serwerze, więc granica
  // jest liczona identycznie.
  const [isMinor, setIsMinor] = useState(false);
  function handleBirthDateChange(value: string) {
    if (!value) {
      setIsMinor(false);
      return;
    }
    const birthDate = new Date(value);
    if (Number.isNaN(birthDate.getTime())) {
      setIsMinor(false);
      return;
    }
    setIsMinor(calculateAge(birthDate, new Date()) < SELF_REGISTER_MIN_AGE);
  }

  return (
    <Card className="border-line bg-surface w-full max-w-md">
      <CardHeader className="items-center justify-items-center">
        <span className="inline-flex rounded-md px-3 py-2 dark:bg-white">
          <Image src="/logo.png" alt="Czapla Boxing" width={180} height={99} priority />
        </span>
        <p className="text-muted-brand mt-2 font-mono text-xs tracking-widest uppercase">
          Rejestracja
        </p>
      </CardHeader>
      <CardContent>
        <form action={formAction} className="flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <Label htmlFor="firstName" className={labelClass}>
                Imię
              </Label>
              <Input id="firstName" name="firstName" required className={fieldClass} />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="lastName" className={labelClass}>
                Nazwisko
              </Label>
              <Input id="lastName" name="lastName" required className={fieldClass} />
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <Label htmlFor="birthDate" className={labelClass}>
                Data urodzenia
              </Label>
              <Input
                id="birthDate"
                name="birthDate"
                type="date"
                required
                className={fieldClass}
                aria-describedby={isMinor ? "birthDate-minor" : undefined}
                onChange={(e) => handleBirthDateChange(e.target.value)}
              />
              {isMinor ? (
                <p
                  id="birthDate-minor"
                  role="status"
                  className="border-amber bg-surface-2 text-text rounded-md border px-2 py-1.5 text-xs"
                >
                  <b>Użytkownik niepełnoletni.</b> Konto możesz założyć, ale wymaga zatwierdzenia
                  przez klub - aktywujemy je po akceptacji. Do tego czasu logowanie działa, ale
                  zapis na zajęcia jest zablokowany.
                </p>
              ) : null}
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="sex" className={labelClass}>
                Płeć
              </Label>
              <select
                id="sex"
                name="sex"
                required
                defaultValue=""
                className="border-line bg-surface-2 text-text h-9 rounded-md border px-2 text-sm"
              >
                <option value="" disabled>
                  Wybierz
                </option>
                <option value="FEMALE">Kobieta</option>
                <option value="MALE">Mężczyzna</option>
              </select>
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="homeLocationId" className={labelClass}>
              Lokalizacja
            </Label>
            <select
              id="homeLocationId"
              name="homeLocationId"
              required
              defaultValue=""
              className="border-line bg-surface-2 text-text h-9 rounded-md border px-2 text-sm"
            >
              <option value="" disabled>
                Wybierz lokalizację
              </option>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="ownerTrainerId" className={labelClass}>
              Trener prowadzący
            </Label>
            <select
              id="ownerTrainerId"
              name="ownerTrainerId"
              required
              defaultValue=""
              className="border-line bg-surface-2 text-text h-9 rounded-md border px-2 text-sm"
            >
              <option value="" disabled>
                Wybierz trenera
              </option>
              {trainers.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
            <p className="text-muted-brand text-xs">
              Nie wiesz, kogo wybrać? Zapytaj w klubie - trenera zawsze da się później zmienić.
            </p>
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="email" className={labelClass}>
              E-mail
            </Label>
            <Input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              required
              className={fieldClass}
            />
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="phone" className={labelClass}>
              Telefon
            </Label>
            <Input
              id="phone"
              name="phone"
              type="tel"
              autoComplete="tel"
              required
              placeholder="500 600 700"
              className={fieldClass}
            />
            <p className="text-muted-brand text-xs">{PHONE_HINT}</p>
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="password" className={labelClass}>
              Hasło
            </Label>
            <Input
              id="password"
              name="password"
              type="password"
              autoComplete="new-password"
              required
              minLength={PASSWORD_MIN_LENGTH}
              className={fieldClass}
            />
            <p className="text-muted-brand text-xs">
              Min. {PASSWORD_MIN_LENGTH} znaków, w tym litera i cyfra.
            </p>
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="confirmPassword" className={labelClass}>
              Powtórz hasło
            </Label>
            <Input
              id="confirmPassword"
              name="confirmPassword"
              type="password"
              autoComplete="new-password"
              required
              minLength={PASSWORD_MIN_LENGTH}
              className={fieldClass}
            />
          </div>

          {state.error ? (
            <p role="alert" className="text-red text-sm">
              {state.error}
            </p>
          ) : null}

          <Button type="submit" disabled={isPending} className="mt-1">
            {isPending ? "Zakładanie konta..." : "Załóż konto"}
          </Button>

          <p className="text-muted-brand text-center text-sm">
            Masz już konto?{" "}
            <Link href="/login" className="hover:text-brand-red underline">
              Zaloguj się
            </Link>
          </p>
        </form>

        {googleEnabled ? (
          <>
            <div className="my-4 flex items-center gap-3">
              <span className="border-line h-px flex-1 border-t" />
              <span className="text-muted-brand font-mono text-[10px] tracking-widest uppercase">
                albo
              </span>
              <span className="border-line h-px flex-1 border-t" />
            </div>
            <GoogleButton label="Zarejestruj przez Google" />
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}
