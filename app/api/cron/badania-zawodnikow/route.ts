import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { medicalExams } from "@/lib/jobs/medical-exams";
import { cronRequestAuthorized } from "@/lib/auth/cron";

// Vercel Cron, codziennie rano. Przypomnienie o kończących się badaniach
// lekarskich zawodnika - patrz lib/jobs/medical-exams.ts.
export async function GET(request: Request) {
  if (!cronRequestAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const result = await medicalExams(prisma);
  return NextResponse.json({ ok: true, ...result });
}
