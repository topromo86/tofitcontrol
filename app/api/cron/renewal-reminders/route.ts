import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { renewalReminders } from "@/lib/jobs/renewal-reminders";
import { cronRequestAuthorized } from "@/lib/auth/cron";

// Vercel Cron, codziennie 6:30 czasu Warszawy (patrz vercel.json - harmonogram
// w UTC, przybliżenie jak w innych jobach).
export async function GET(request: Request) {
  if (!cronRequestAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const result = await renewalReminders(prisma, new Date());
  return NextResponse.json({ ok: true, ...result });
}
