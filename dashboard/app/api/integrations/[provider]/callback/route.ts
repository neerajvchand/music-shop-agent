import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase";
import { getProvider } from "@/lib/integrations/registry";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ provider: string }> }
) {
  const { provider: providerSlug } = await params;
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const error = searchParams.get("error");
  const origin = process.env.NEXT_PUBLIC_APP_URL || "";

  if (error) {
    return NextResponse.redirect(`${origin}/?error=auth_denied`);
  }

  if (!code || !state) {
    return NextResponse.redirect(`${origin}/?error=missing_params`);
  }

  let shopId: string;
  try {
    const decoded = JSON.parse(
      Buffer.from(state, "base64url").toString("utf-8")
    ) as { shop_id: string };
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

  const provider = getProvider(providerSlug);
  if (!provider) {
    return NextResponse.redirect(`${origin}/?error=unknown_provider`);
  }

  const redirectUri = `${origin}/api/integrations/${providerSlug}/callback`;

  try {
    const tokens = await provider.exchangeCode(code, redirectUri);

    const service = createServiceClient();
    await service.from("shop_integrations").upsert(
      {
        shop_id: shopId,
        provider: providerSlug,
        provider_account_email: tokens.providerAccountEmail,
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
        token_expires_at: tokens.expiresAt.toISOString(),
        scopes: tokens.scopes,
        status: "connected",
        last_error: null,
        connected_at: new Date().toISOString(),
      },
      { onConflict: "shop_id,provider" }
    );

    return NextResponse.redirect(`${origin}/?connected=1`);
  } catch (e: any) {
    console.error("Integration callback error:", e);
    return NextResponse.redirect(`${origin}/?error=integration_failed`);
  }
}
