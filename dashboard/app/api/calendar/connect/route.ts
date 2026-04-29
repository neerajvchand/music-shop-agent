import { NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const provider = searchParams.get("provider") || "google_calendar";

  const body = await request.json().catch(() => ({}));

  return fetch(`${process.env.NEXT_PUBLIC_APP_URL}/api/integrations/${provider}/connect`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).then((r) => new NextResponse(r.body, { status: r.status, headers: r.headers }));
}
