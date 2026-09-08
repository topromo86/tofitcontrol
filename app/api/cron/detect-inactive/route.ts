import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { detectInactive } from "@/lib/jobs/detect-inactive";
import { cronRequestAuthorized } from "@/lib/auth/cron";

// Vercel Cron, codziennie ok. 06:00 czasu Warszawy (patrz vercel.json).
export async function GET(request: Request) {
  if (!cronRequestAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const result = await detectInactive(prisma);
  return NextResponse.json({ ok: true, ...result });
}
