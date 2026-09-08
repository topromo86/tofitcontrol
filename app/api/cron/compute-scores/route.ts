import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { computeScores } from "@/lib/jobs/compute-scores";
import { cronRequestAuthorized } from "@/lib/auth/cron";

// Vercel Cron, 1. dnia miesiąca ok. 5:00 czasu Warszawy (patrz vercel.json -
// harmonogram w UTC, przybliżenie jak w innych jobach).
export async function GET(request: Request) {
  if (!cronRequestAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const result = await computeScores(prisma, new Date());
  return NextResponse.json({ ok: true, ...result });
}
