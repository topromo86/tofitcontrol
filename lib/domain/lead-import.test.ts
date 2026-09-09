import { describe, expect, it } from "vitest";
import {
  buildWelcomeSms,
  buildWelcomeEmail,
  parseWelcomeChannel,
  missingWelcomeContact,
  parseLeadPhone,
  dedupeLeads,
  leadIdentity,
  parseCsv,
  parseLeadsCsv,
  splitFullName,
} from "./lead-import";

describe("parseLeadPhone", () => {
  // Wszystkie postacie pochodzą z realnego eksportu klubu (Czapla Boxing,
  // wrzesień 2026) - w jednym pliku było ich pięć naraz.
  it("ścina znacznik `p:`, którym Meta poprzedza numer", () => {
    expect(parseLeadPhone("p:+48571277686")).toBe("+48571277686");
    expect(parseLeadPhone("p:605687770")).toBe("+48605687770");
  });

  it("przyjmuje numer z kierunkowym, ale bez plusa - tak eksportuje Meta", () => {
    expect(parseLeadPhone("48661535704")).toBe("+48661535704");
  });

  it("dziewięć cyfr czyta jako polski numer", () => {
    expect(parseLeadPhone("783925065")).toBe("+48783925065");
  });

  it("nie zamienia numeru zagranicznego w polski", () => {
    expect(parseLeadPhone("31613737346")).toBe("+31613737346");
    expect(parseLeadPhone("+380671234567")).toBe("+380671234567");
  });

  it("sprowadza ten sam numer do jednej postaci, w jakikolwiek sposób zapisany", () => {
    const jeden = [
      "p:+48605687770",
      "605687770",
      "48605687770",
      "+48 605 687 770",
      "0048605687770",
    ];
    expect(new Set(jeden.map(parseLeadPhone))).toEqual(new Set(["+48605687770"]));
  });

  it("odrzuca śmieci zamiast zgadywać", () => {
    expect(parseLeadPhone("zadzwon-do-mnie")).toBeNull();
    expect(parseLeadPhone("12345")).toBeNull();
    expect(parseLeadPhone("")).toBeNull();
    expect(parseLeadPhone(null)).toBeNull();
  });
});

describe("dedupeLeads", () => {
  const lead = (fullName: string, phone: string | null, email: string | null = null) => ({
    fullName,
    email,
    phone,
    source: "META_OTHER" as const,
    campaign: null,
    externalId: null,
    rawData: {},
  });

  it("usuwa powtórzony numer w obrębie jednego pliku", () => {
    const { unique, duplicates } = dedupeLeads([
      lead("Adam Krawczyk", "+48501362278"),
      lead("Sylwia Wagstyl", "+48509993430"),
      lead("Adam Krawczyk", "+48501362278"),
    ]);
    expect(unique).toHaveLength(2);
    expect(duplicates).toBe(1);
  });

  it("nie skleja dwóch osób po samym nazwisku", () => {
    const { unique, duplicates } = dedupeLeads([
      lead("Adam Krawczyk", "+48501362278"),
      lead("Adam Krawczyk", "+48600100200"),
    ]);
    expect(unique).toHaveLength(2);
    expect(duplicates).toBe(0);
  });

  it("bez numeru i bez e-maila nie zgaduje - przepuszcza oba", () => {
    const { unique } = dedupeLeads([lead("Karolina", null), lead("Karolina", null)]);
    expect(unique).toHaveLength(2);
  });

  it("gdy numeru brak, rozstrzyga e-mail bez względu na wielkość liter", () => {
    const { duplicates } = dedupeLeads([
      lead("Jan", null, "Jan@example.com"),
      lead("Jan N.", null, "jan@example.com"),
    ]);
    expect(duplicates).toBe(1);
  });
});

describe("leadIdentity", () => {
  it("numer ma pierwszeństwo przed e-mailem", () => {
    expect(leadIdentity({ phone: "+48500600700", email: "a@b.pl" })).toBe("tel:+48500600700");
  });

  it("bez kontaktu nie ma tożsamości", () => {
    expect(leadIdentity({ phone: null, email: null })).toBeNull();
  });
});

describe("parseLeadsCsv - nagłówki z realnych eksportów", () => {
  // Plik klubu miał kolumnę "Imię Nazwisko" (bez "i"), a alias brzmiał
  // "imię i nazwisko". Kolumna nie pasowała, więc w miejsce nazwiska wchodził
  // numer telefonu - 185 osób z imieniem "p:+48571277686".
  it("rozpoznaje kolumnę 'Imię Nazwisko' bez spójnika", () => {
    const csv = ["Imię Nazwisko,Numer Telefonu", "Kamila Drab,p:+48571277686"].join("\n");
    const { leads } = parseLeadsCsv(csv);
    expect(leads[0].fullName).toBe("Kamila Drab");
    expect(leads[0].phone).toBe("+48571277686");
  });

  it("nie potyka się o ogonki ani o wielkość liter w nagłówku", () => {
    for (const naglowek of ["IMIĘ NAZWISKO", "imie nazwisko", "Imię i nazwisko", "Full Name"]) {
      const { leads } = parseLeadsCsv([`${naglowek},Telefon`, "Jan Kowalski,500600700"].join("\n"));
      expect(leads[0].fullName).toBe("Jan Kowalski");
    }
  });

  it("zachowuje odpowiedzi z formularza w rawData", () => {
    const csv = [
      "Imię Nazwisko,Numer Telefonu,Dlaczego chcialbys trenowac boks?",
      'Marek Uszok,48515948006,"Chcialbym sprobowac, a przede wszystkim zrzucic kilka kilogramow."',
    ].join("\n");
    const { leads } = parseLeadsCsv(csv);
    expect(leads[0].rawData["Dlaczego chcialbys trenowac boks?"]).toContain("zrzucic kilka");
    // Surowy zapis numeru zostaje - to jedyny ślad tego, co było w pliku.
    expect(leads[0].rawData["Numer Telefonu"]).toBe("48515948006");
  });

  it("pomija puste wiersze na końcu eksportu", () => {
    const csv = ["Imię Nazwisko,Numer Telefonu", "Jan Kowalski,500600700", ",", ",", ","].join(
      "\n",
    );
    const { leads } = parseLeadsCsv(csv);
    expect(leads).toHaveLength(1);
  });
});

describe("buildWelcomeSms", () => {
  it("zawiera imię, gdy podane", () => {
    const msg = buildWelcomeSms("Marek");
    expect(msg).toContain("Cześć Marek!");
    expect(msg).toContain("Czapla Boxing");
  });

  it("działa bez imienia", () => {
    const msg = buildWelcomeSms("");
    expect(msg.startsWith("Cześć!")).toBe(true);
  });

  it("mieści się w rozsądnej długości SMS", () => {
    expect(buildWelcomeSms("Aleksandra").length).toBeLessThanOrEqual(160);
  });
});

describe("splitFullName", () => {
  it("dzieli imię i nazwisko", () => {
    expect(splitFullName("Anna Kowalska")).toEqual({ firstName: "Anna", lastName: "Kowalska" });
  });

  it("wieloczłonowe nazwisko trafia w całości do lastName", () => {
    expect(splitFullName("Anna Kowalska-Nowak Wiśniewska")).toEqual({
      firstName: "Anna",
      lastName: "Kowalska-Nowak Wiśniewska",
    });
  });

  it("samo imię zostawia puste nazwisko", () => {
    expect(splitFullName("Madonna")).toEqual({ firstName: "Madonna", lastName: "" });
  });

  it("przycina i normalizuje wielokrotne spacje", () => {
    expect(splitFullName("  Jan   Nowak  ")).toEqual({ firstName: "Jan", lastName: "Nowak" });
  });

  it("pusty string daje puste pola", () => {
    expect(splitFullName("   ")).toEqual({ firstName: "", lastName: "" });
  });
});

describe("parseCsv", () => {
  it("dzieli proste wiersze i kolumny", () => {
    expect(parseCsv("a,b\n1,2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("obsługuje cudzysłowy z przecinkiem i nową linią w polu", () => {
    const csv = 'name,note\n"Kowalski, Jan","wiersz1\nwiersz2"';
    expect(parseCsv(csv)).toEqual([
      ["name", "note"],
      ["Kowalski, Jan", "wiersz1\nwiersz2"],
    ]);
  });

  it("podwójny cudzysłów w polu to znak dosłowny", () => {
    expect(parseCsv('x\n"ma ""cudzysłów"""')).toEqual([["x"], ['ma "cudzysłów"']]);
  });

  it("radzi sobie z CRLF i pustą linią na końcu", () => {
    expect(parseCsv("a,b\r\n1,2\r\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });
});

describe("parseLeadsCsv", () => {
  it("mapuje standardowe kolumny Meta i rozpoznaje platformę", () => {
    const csv = [
      "id,full_name,email,phone_number,platform,campaign_name",
      "L1,Jan Kowalski,jan@example.com,+48500600700,instagram,Boks jesień",
    ].join("\n");
    const { leads, skipped } = parseLeadsCsv(csv);
    expect(skipped).toBe(0);
    expect(leads).toHaveLength(1);
    expect(leads[0]).toMatchObject({
      externalId: "L1",
      fullName: "Jan Kowalski",
      email: "jan@example.com",
      phone: "+48500600700",
      source: "INSTAGRAM",
      campaign: "Boks jesień",
    });
    expect(leads[0].rawData["campaign_name"]).toBe("Boks jesień");
  });

  it("rozpoznaje polskie nagłówki i domyślną platformę", () => {
    const csv = ["Imię i nazwisko,Telefon,Adres e-mail", "Anna Nowak,111222333,"].join("\n");
    const { leads } = parseLeadsCsv(csv);
    expect(leads[0]).toMatchObject({
      fullName: "Anna Nowak",
      phone: "+48111222333",
      email: null,
      source: "META_OTHER",
    });
  });

  it("fullName ma fallback na e-mail, gdy brak imienia", () => {
    const csv = ["full_name,email", ",ktos@example.com"].join("\n");
    expect(parseLeadsCsv(csv).leads[0].fullName).toBe("ktos@example.com");
  });

  it("pomija wiersz z treścią, ale bez danych kontaktowych", () => {
    // Wiersz ma wartość w nieznanej kolumnie, ale brak imienia/e-maila/telefonu.
    const csv = ["full_name,email,phone_number,notatka", ",,,coś", "Jan,,500,"].join("\n");
    const { leads, skipped } = parseLeadsCsv(csv);
    expect(leads).toHaveLength(1);
    expect(skipped).toBe(1);
  });

  it("pusty plik / sam nagłówek → brak leadów", () => {
    expect(parseLeadsCsv("full_name,email")).toEqual({ leads: [], skipped: 0 });
  });
});

describe("buildWelcomeEmail", () => {
  it("wita po imieniu", () => {
    expect(buildWelcomeEmail("Marek").text).toContain("Cześć Marek!");
  });

  it("bez imienia nie zostawia dziury", () => {
    const mail = buildWelcomeEmail("");
    expect(mail.text).toContain("Cześć!");
    expect(mail.text).not.toContain("Cześć !");
  });

  it("ma temat z nazwą klubu", () => {
    expect(buildWelcomeEmail("Ala").subject).toContain("Czapla Boxing");
  });
});

describe("parseWelcomeChannel", () => {
  it("czyta wartości z formularza", () => {
    expect(parseWelcomeChannel("SMS")).toBe("SMS");
    expect(parseWelcomeChannel("EMAIL")).toBe("EMAIL");
    expect(parseWelcomeChannel("BOTH")).toBe("BOTH");
  });

  // Domyślnie NIC nie wysyłamy - powitanie musi być świadomym wyborem.
  it("wszystko inne to brak wysyłki", () => {
    expect(parseWelcomeChannel(null)).toBe("NONE");
    expect(parseWelcomeChannel("")).toBe("NONE");
    expect(parseWelcomeChannel("cokolwiek")).toBe("NONE");
  });
});

describe("missingWelcomeContact", () => {
  it("SMS wymaga telefonu", () => {
    expect(missingWelcomeContact("SMS", { phone: null, email: "a@b.pl" })).toContain("numer");
    expect(missingWelcomeContact("SMS", { phone: "500600700", email: null })).toBeNull();
  });

  it("e-mail wymaga adresu", () => {
    expect(missingWelcomeContact("EMAIL", { phone: "500600700", email: null })).toContain("e-mail");
    expect(missingWelcomeContact("EMAIL", { phone: null, email: "a@b.pl" })).toBeNull();
  });

  it("oba kanały wymagają obu danych", () => {
    expect(missingWelcomeContact("BOTH", { phone: "500600700", email: null })).toContain("e-mail");
    expect(missingWelcomeContact("BOTH", { phone: null, email: "a@b.pl" })).toContain("numer");
    expect(missingWelcomeContact("BOTH", { phone: "500600700", email: "a@b.pl" })).toBeNull();
  });

  it("brak powitania nie wymaga niczego", () => {
    expect(missingWelcomeContact("NONE", { phone: null, email: null })).toBeNull();
  });
});
