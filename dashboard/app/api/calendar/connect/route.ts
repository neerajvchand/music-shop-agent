import { NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const provider = searchParams.get("provider") || "google_calendar";

  const target = new URL(
    `${process.env.NEXT_PUBLIC_APP_URL}/api/integrations/${provider}/connect`
  );

  return NextResponse.redirect(target.toString(), 307);
}
