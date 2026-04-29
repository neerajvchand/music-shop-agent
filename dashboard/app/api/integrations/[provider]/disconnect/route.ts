import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase";
import { getProvider } from "@/lib/integrations/registry";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ provider: string }> }
) {
  const { provider: providerSlug } = await params;

  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: shop } = await supabase
    .from("shops")
    .select("id")
    .eq("owner_email", user.email)
    .single();

  if (!shop) {
    return NextResponse.json({ error: "Shop not found" }, { status: 404 });
  }

  const service = createServiceClient();

  // Optional: call provider revoke if available
  const provider = getProvider(providerSlug);
  if (provider?.revoke) {
    const { data: row } = await service
      .from("shop_integrations")
      .select("*")
      .eq("shop_id", shop.id)
      .eq("provider", providerSlug)
      .single();

    if (row) {
      try {
        await provider.revoke(row);
      } catch (e) {
        console.error("Revoke failed (non-critical):", e);
      }
    }
  }

  await service
    .from("shop_integrations")
    .update({
      status: "disconnected",
      access_token: null,
      refresh_token: null,
      token_expires_at: null,
      last_error: null,
    })
    .eq("shop_id", shop.id)
    .eq("provider", providerSlug);

  return NextResponse.json({ ok: true });
}
