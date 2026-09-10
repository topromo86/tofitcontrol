import { prisma } from "@/lib/prisma";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createMemberAction } from "./actions";

export default async function NewClientPage() {
  const [locations, trainers] = await Promise.all([
    prisma.location.findMany({ orderBy: { name: "asc" } }),
    prisma.trainer.findMany({
      where: { active: true },
      include: { user: true, location: true },
      orderBy: { user: { name: "asc" } },
    }),
  ]);

  return (
    <div className="max-w-lg">
      <h1 className="font-display text-brand-red mb-4 text-2xl">Dodaj klienta</h1>
      <form action={createMemberAction} className="flex flex-col gap-4">
        <div className="flex gap-3">
          <div className="flex-1">
            <Label htmlFor="firstName">Imię</Label>
            <Input id="firstName" name="firstName" required className="border-line bg-surface-2" />
          </div>
          <div className="flex-1">
            <Label htmlFor="lastName">Nazwisko</Label>
            <Input id="lastName" name="lastName" required className="border-line bg-surface-2" />
          </div>
        </div>

        <div className="flex gap-3">
          <div className="flex-1">
            <Label htmlFor="birthDate">Data urodzenia</Label>
            <Input
              id="birthDate"
              name="birthDate"
              type="date"
              required
              className="border-line bg-surface-2"
            />
          </div>
          <div className="flex-1">
            <Label htmlFor="sex">Płeć</Label>
            <select
              id="sex"
              name="sex"
              required
              className="border-line bg-surface-2 text-text w-full rounded-md border px-2 py-2 text-base md:text-sm"
            >
              <option value="FEMALE">Kobieta</option>
              <option value="MALE">Mężczyzna</option>
            </select>
          </div>
        </div>

        <div>
          <Label htmlFor="email">E-mail</Label>
          <Input
            id="email"
            name="email"
            type="email"
            required
            className="border-line bg-surface-2"
          />
        </div>

        <div>
          <Label htmlFor="weightKg">Waga (kg, opcjonalnie)</Label>
          <Input
            id="weightKg"
            name="weightKg"
            type="number"
            step="0.1"
            min="0"
            className="border-line bg-surface-2"
          />
        </div>

        <div>
          <Label htmlFor="goal">Cel (opcjonalnie)</Label>
          <Input id="goal" name="goal" className="border-line bg-surface-2" />
        </div>

        <div>
          <Label htmlFor="homeLocationId">Lokalizacja domowa</Label>
          <select
            id="homeLocationId"
            name="homeLocationId"
            required
            className="border-line bg-surface-2 text-text w-full rounded-md border px-2 py-2 text-base md:text-sm"
          >
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </div>

        <div>
          <Label htmlFor="ownerTrainerId">Trener-opiekun</Label>
          <select
            id="ownerTrainerId"
            name="ownerTrainerId"
            required
            defaultValue=""
            className="border-line bg-surface-2 text-text w-full rounded-md border px-2 py-2 text-base md:text-sm"
          >
            <option value="" disabled>
              Wybierz trenera...
            </option>
            {trainers.map((t) => (
              <option key={t.id} value={t.id}>
                {t.user.name} ({t.location.name})
              </option>
            ))}
          </select>
          <p className="text-muted-brand mt-1 text-xs">
            Każdy klient musi mieć jednego odpowiedzialnego trenera (CLAUDE.md reguła 1).
          </p>
        </div>

        <div>
          <Label htmlFor="referralCode">Kod polecenia (opcjonalnie)</Label>
          <Input
            id="referralCode"
            name="referralCode"
            placeholder="np. AB12CD"
            className="border-line bg-surface-2 uppercase"
          />
          <p className="text-muted-brand mt-1 text-xs">
            Jeśli ważny, klient trafi automatycznie do tego samego trenera co polecający.
          </p>
        </div>

        <Button type="submit">Dodaj klienta</Button>
      </form>
    </div>
  );
}
