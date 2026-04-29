import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase";
import { getProvider } from "@/lib/integrations/registry";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ provider: string }> }
) {
  const { provider: providerSlug } = await params;
  const origin = process.env.NEXT_PUBLIC_APP_URL || "";

  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: shop } = await supabase
    .from("shops")
    .select("id, owner_email")
    .eq("owner_email", user.email)
    .single();

  if (!shop) {
    return NextResponse.json({ error: "Shop not found" }, { status: 404 });
  }

  const provider = getProvider(providerSlug);
  if (!provider) {
    return NextResponse.json({ error: "Unknown provider" }, { status: 400 });
  }

  const redirectUri = `${origin}/api/integrations/${providerSlug}/callback`;
  const url = provider.getAuthUrl(shop.id, redirectUri);

  return NextResponse.json({ url });
}
