import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// GET /api/zdrowie - czy aplikacja żyje i czy widzi bazę.
//
// Po to jest wskaźnik ONLINE/OFFLINE w pasku: sam `navigator.onLine` mówi
// wyłącznie, czy urządzenie ma jakąkolwiek sieć, a na sali klub najczęściej
// wisi w wifi, które "jest", ale nie przepuszcza ruchu. Dopiero odpowiedź
// z serwera dowodzi, że zapis ma gdzie trafić.
//
// Bez autoryzacji, bo wskaźnik pyta też wtedy, gdy sesja właśnie umarła,
// a odpowiedź 401 byłaby wtedy nie do odróżnienia od braku łącza. Na zewnątrz
// idą wyłącznie dwie wartości logiczne - nic o klubie, kliencie ani błędzie.
export const dynamic = "force-dynamic";

export async function GET() {
  let baza = false;
  try {
    await prisma.$queryRaw`SELECT 1`;
    baza = true;
  } catch {
    // Baza nie odpowiada. Serwer żyje (skoro odpowiadamy), więc rozróżnienie
    // ma sens: aplikacja stoi, ale zapisy nie mają dokąd iść.
  }

  return NextResponse.json({ serwer: true, baza }, { headers: { "Cache-Control": "no-store" } });
}
