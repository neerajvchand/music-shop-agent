import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase";
import {
  decodeState,
  exchangeCodeForTokens,
  getGoogleUserInfo,
} from "@/lib/google-oauth";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const error = searchParams.get("error");

  const origin = process.env.NEXT_PUBLIC_APP_URL || "";

  if (error) {
    return NextResponse.redirect(`${origin}/?error=google_auth_denied`);
  }

  if (!code || !state) {
    return NextResponse.redirect(`${origin}/?error=missing_params`);
  }

  // Decode state to get shop_id
  let shopId: string;
  try {
    const decoded = decodeState(state);
    shopId = decoded.shop_id;
  } catch {
    return NextResponse.redirect(`${origin}/?error=invalid_state`);
  }

  // Verify user is authenticated
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.redirect(`${origin}/?error=unauthorized`);
  }

  // Exchange code for tokens
  const clientId = process.env.GOOGLE_CLIENT_ID!;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET!;
  const redirectUri = `${origin}/api/calendar/callback`;

  try {
    const tokenData = await exchangeCodeForTokens({
      code,
      clientId,
      clientSecret,
      redirectUri,
    });

    const userInfo = await getGoogleUserInfo(tokenData.access_token);

    const expiresAt = new Date(
      Date.now() + tokenData.expires_in * 1000
    ).toISOString();

    // Upsert integration record using service role (bypasses RLS)
    const service = createServiceClient();
    await service.from("shop_integrations").upsert(
      {
        shop_id: shopId,
        provider: "google_calendar",
        provider_account_email: userInfo.email,
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token,
        token_expires_at: expiresAt,
        scopes: tokenData.scope.split(" "),
        status: "connected",
        last_error: null,
      },
      { onConflict: "shop_id,provider" }
    );

    return NextResponse.redirect(`${origin}/?connected=1`);
  } catch (e: any) {
    console.error("Calendar callback error:", e);
    return NextResponse.redirect(`${origin}/?error=token_exchange_failed`);
  }
}
