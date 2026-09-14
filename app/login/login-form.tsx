"use client";

import Link from "next/link";
import Image from "next/image";
import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { GoogleButton } from "../google-button";
import { loginAction, type LoginState } from "./actions";

const initialState: LoginState = {};

export function LoginForm({
  notice,
  googleEnabled,
  returnTo,
}: {
  notice?: string;
  googleEnabled?: boolean;
  // Dokąd wrócić po zalogowaniu - ustawiane, gdy ktoś przyszedł z witryny
  // klubu na konkretne zajęcia. Poprawność adresu sprawdza serwer.
  returnTo?: string;
}) {
  const [state, formAction, isPending] = useActionState(loginAction, initialState);

  return (
    <Card className="border-line bg-surface w-full max-w-sm">
      <CardHeader className="items-center justify-items-center">
        {/* Jasna podkładka w trybie ciemnym - logo ma czarny napis, patrz
            app/brand-header-logo.tsx */}
        <span className="inline-flex rounded-md px-3 py-2 dark:bg-white">
          <Image src="/logo.png" alt="Czapla Boxing" width={220} height={121} priority />
        </span>
        <p className="text-muted-brand mt-2 font-mono text-xs tracking-widest uppercase">
          Logowanie
        </p>
      </CardHeader>
      <CardContent>
        {notice ? (
          <p className="border-jade bg-surface-2 text-text mb-4 rounded-md border p-3 text-sm">
            {notice}
          </p>
        ) : null}
        <form action={formAction} className="flex flex-col gap-4">
          {returnTo ? <input type="hidden" name="powrot" value={returnTo} /> : null}
          <div className="flex flex-col gap-2">
            <Label htmlFor="email" className="font-mono text-xs tracking-widest uppercase">
              E-mail lub login
            </Label>
            <Input
              id="email"
              name="email"
              // Nie type="email": konto kiosku loguje się nazwą "kiosk", a nie
              // adresem. Poprawność i tak sprawdza serwer, wyszukując konto.
              type="text"
              // `username`, a nie `email`: to pole przyjmuje JEDNO I DRUGIE.
              // Przy `email` menedżer haseł i klawiatura tabletu zachowują się
              // tak, jakby adres był wymagany - a na sali loguje się konto
              // o nazwie "kiosk".
              autoComplete="username"
              required
              className="border-line bg-surface-2"
            />
            {/* Napis jest tu dla tabletu na sali. Pole nazywało się po prostu
                "E-mail", więc człowiek wpisujący "kiosk" miał podstawy sądzić,
                że system wymaga adresu - zwłaszcza że przy literówce w haśle
                odpowiadał komunikatem "Nieprawidłowy e-mail lub hasło". */}
            <p className="text-muted-brand text-xs">
              Tablet na sali loguje się nazwą <span className="text-text font-mono">kiosk</span>,
              bez adresu e-mail.
            </p>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="password" className="font-mono text-xs tracking-widest uppercase">
              Hasło
            </Label>
            <Input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              className="border-line bg-surface-2"
            />
          </div>
          {state.error ? (
            <p role="alert" className="text-red text-sm">
              {state.error}
            </p>
          ) : null}
          <Button type="submit" disabled={isPending} className="mt-2">
            {isPending ? "Logowanie..." : "Zaloguj się"}
          </Button>

          <div className="flex flex-col items-center gap-2 pt-1">
            <Link
              href="/rejestracja"
              className="text-brand-red font-mono text-xs tracking-widest uppercase hover:underline"
            >
              Zarejestruj się
            </Link>
            <Link
              href="/reset-hasla"
              className="text-muted-brand hover:text-brand-red text-xs underline"
            >
              Nie pamiętasz hasła?
            </Link>
          </div>
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
            <GoogleButton label="Zaloguj przez Google" />
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}
