import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { sessionReminders } from "@/lib/jobs/session-reminders";
import { cronRequestAuthorized } from "@/lib/auth/cron";

// Vercel Cron, codziennie rano (patrz vercel.json - harmonogram w UTC,
// przybliżenie jak w innych jobach).
export async function GET(request: Request) {
  if (!cronRequestAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const result = await sessionReminders(prisma, new Date());
  return NextResponse.json({ ok: true, ...result });
}
