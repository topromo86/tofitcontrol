import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { churnAndSurvey } from "@/lib/jobs/churn-and-survey";
import { cronRequestAuthorized } from "@/lib/auth/cron";

// Vercel Cron, codziennie ok. 7:00 czasu Warszawy (patrz vercel.json -
// harmonogram w UTC, przybliżenie jak w innych jobach).
export async function GET(request: Request) {
  if (!cronRequestAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const result = await churnAndSurvey(prisma, new Date());
  return NextResponse.json({ ok: true, ...result });
}
