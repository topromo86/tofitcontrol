import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { passLifecycle } from "@/lib/jobs/pass-lifecycle";
import { cronRequestAuthorized } from "@/lib/auth/cron";

// Vercel Cron, codziennie 3:00 czasu Warszawy (patrz vercel.json - harmonogram
// w UTC, przybliżenie jak w innych jobach).
export async function GET(request: Request) {
  if (!cronRequestAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const result = await passLifecycle(prisma, new Date());
  return NextResponse.json({ ok: true, ...result });
}
