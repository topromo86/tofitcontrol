import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { closeCashDay } from "@/lib/jobs/close-cash-day";
import { todayInTimeZone } from "@/lib/domain/time";
import { cronRequestAuthorized } from "@/lib/auth/cron";

// Vercel Cron, codziennie 22:00 czasu Warszawy (patrz vercel.json - harmonogram
// w UTC, przybliżenie jak w generate-sessions).
export async function GET(request: Request) {
  if (!cronRequestAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const result = await closeCashDay(prisma, todayInTimeZone(new Date()));
  return NextResponse.json({ ok: true, ...result });
}
