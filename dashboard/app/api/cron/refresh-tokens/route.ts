import { NextRequest, NextResponse } from "next/server";
import { refreshAllSoonToExpire } from "@/lib/integrations/refresh";

export async function GET(request: NextRequest) {
  // Verify cron secret to prevent unauthorized calls
  const authHeader = request.headers.get("authorization");
  const expected = `Bearer ${process.env.CRON_SECRET || ""}`;

  if (authHeader !== expected) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await refreshAllSoonToExpire();
    return NextResponse.json({ ok: true, ...result });
  } catch (e: any) {
    console.error("Cron refresh error:", e);
    return NextResponse.json(
      { error: e?.message || "Refresh failed" },
      { status: 500 }
    );
  }
}
