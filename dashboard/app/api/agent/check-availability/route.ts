import { NextRequest, NextResponse } from "next/server";
import { verifyAgentRequest } from "../_auth";
import { refreshIfNeeded } from "@/lib/integrations/refresh";
import { getProvider } from "@/lib/integrations/registry";

export async function POST(request: NextRequest) {
  const auth = verifyAgentRequest(request);
  if (!auth.ok) return auth.response;

  const body = await request.json();
  const { date, durationMinutes, timezone } = body;

  if (!date || !durationMinutes) {
    return NextResponse.json(
      { error: "date and durationMinutes required" },
      { status: 400 }
    );
  }

  try {
    await refreshIfNeeded(auth.shopId, "google_calendar");
    const provider = getProvider("google_calendar")!;
    const slots = await provider.checkAvailability(auth.shopId, {
      date,
      durationMinutes: parseInt(durationMinutes, 10),
      timezone: timezone || "America/Los_Angeles",
    });

    return NextResponse.json({ slots });
  } catch (e: any) {
    console.error("Check availability error:", e);
    return NextResponse.json(
      { error: e?.message || "Availability check failed" },
      { status: 500 }
    );
  }
}
