import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase";
import { buildGoogleOAuthUrl, encodeState } from "@/lib/google-oauth";

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Find shop owned by this user (for MVP, assume one shop per owner email)
  const { data: shop } = await supabase
    .from("shops")
    .select("id, owner_email")
    .eq("owner_email", user.email)
    .single();

  if (!shop) {
    return NextResponse.json({ error: "Shop not found" }, { status: 404 });
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const redirectUri = `${process.env.NEXT_PUBLIC_APP_URL}/api/calendar/callback`;

  if (!clientId) {
    return NextResponse.json({ error: "Google OAuth not configured" }, { status: 500 });
  }

  const url = buildGoogleOAuthUrl({
    clientId,
    redirectUri,
    state: encodeState(shop.id),
  });

  return NextResponse.json({ url });
}
