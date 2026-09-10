"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { completeProfileAction, type ProfileState } from "./actions";
import { PHONE_HINT } from "@/lib/domain/phone";

const initialState: ProfileState = {};

const fieldClass = "border-line bg-surface-2";
const labelClass = "font-mono text-xs tracking-widest uppercase";
const selectClass =
  "border-line bg-surface-2 text-text h-9 rounded-md border px-2 text-base md:text-sm";

type Option = { id: string; name: string };

export function CompleteProfileForm({
  locations,
  trainers,
  defaultFirstName,
  defaultLastName,
}: {
  locations: Option[];
  trainers: Option[];
  defaultFirstName: string;
  defaultLastName: string;
}) {
  const [state, formAction, isPending] = useActionState(completeProfileAction, initialState);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-2">
          <Label htmlFor="firstName" className={labelClass}>
            Imię
          </Label>
          <Input
            id="firstName"
            name="firstName"
            required
            defaultValue={defaultFirstName}
            className={fieldClass}
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="lastName" className={labelClass}>
            Nazwisko
          </Label>
          <Input
            id="lastName"
            name="lastName"
            required
            defaultValue={defaultLastName}
            className={fieldClass}
          />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-2">
          <Label htmlFor="birthDate" className={labelClass}>
            Data urodzenia
          </Label>
          <Input id="birthDate" name="birthDate" type="date" required className={fieldClass} />
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
          <Label htmlFor="sex" className={labelClass}>
            Płeć
          </Label>
          <select id="sex" name="sex" required defaultValue="" className={selectClass}>
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
          className={selectClass}
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
          className={selectClass}
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

      {state.error ? (
        <p role="alert" className="text-red text-sm">
          {state.error}
        </p>
      ) : null}

      <Button type="submit" disabled={isPending} className="mt-1">
        {isPending ? "Zapisywanie..." : "Zapisz i przejdź do aplikacji"}
      </Button>
    </form>
  );
}
