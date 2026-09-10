"use client";

import { useActionState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SubmitButton } from "../../submit-button";
import { createChildAction, type ChildState } from "./actions";

// Formularz dodania profilu dziecka. Klient, bo pokazuje błąd walidacji bez
// przeładowania - rodzic wypełnia to raz i nie ma wracać do pustych pól.
//
// Dziecko nie dostaje loginu ani hasła: kartoteka wisi przy koncie rodzica.
// Dlatego nie ma tu pól e-mail i hasło, choć formularz rejestracji je ma.

const SELECT = "border-line bg-surface-2 text-text h-9 rounded-md border px-2 text-base md:text-sm";

export function DodajDziecko({
  locations,
  trainers,
}: {
  locations: { id: string; name: string }[];
  trainers: { id: string; name: string }[];
}) {
  const [state, formAction] = useActionState<ChildState, FormData>(createChildAction, {});

  return (
    <section className="border-line bg-surface flex flex-col gap-3 rounded-md border p-4">
      <div>
        <h2 className="text-muted-brand font-mono text-xs tracking-widest uppercase">
          Dodaj profil dziecka
        </h2>
        <p className="text-muted-brand mt-1 text-sm">
          Dziecko nie zakłada własnego konta - jego profil wisi przy Twoim. To Ty podpisujesz zgody,
          dostajesz powiadomienia i zapisujesz je na zajęcia.
        </p>
      </div>

      {state.error ? (
        <p role="alert" className="border-red/40 bg-red/10 text-red rounded-md border p-3 text-sm">
          {state.error}
        </p>
      ) : null}

      <form action={formAction} className="flex flex-col gap-3">
        <div className="flex flex-wrap gap-3">
          <div>
            <Label htmlFor="firstName">Imię dziecka</Label>
            <Input id="firstName" name="firstName" required className="border-line bg-surface-2" />
          </div>
          <div>
            <Label htmlFor="lastName">Nazwisko</Label>
            <Input id="lastName" name="lastName" required className="border-line bg-surface-2" />
          </div>
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
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <div>
            <Label htmlFor="sex">Płeć</Label>
            <select id="sex" name="sex" required defaultValue="" className={`${SELECT} block`}>
              <option value="" disabled>
                wybierz
              </option>
              <option value="FEMALE">Dziewczynka</option>
              <option value="MALE">Chłopiec</option>
            </select>
          </div>
          <div>
            <Label htmlFor="homeLocationId">Sala</Label>
            <select
              id="homeLocationId"
              name="homeLocationId"
              required
              defaultValue=""
              className={`${SELECT} block`}
            >
              <option value="" disabled>
                wybierz
              </option>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <Label htmlFor="ownerTrainerId">Trener</Label>
            <select
              id="ownerTrainerId"
              name="ownerTrainerId"
              required
              defaultValue=""
              className={`${SELECT} block`}
            >
              <option value="" disabled>
                wybierz
              </option>
              {trainers.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </div>
          <SubmitButton pendingLabel="Dodaję...">Dodaj dziecko</SubmitButton>
        </div>
      </form>
    </section>
  );
}
