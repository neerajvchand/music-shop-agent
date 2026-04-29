import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase";
import { getSettings, updateSettings } from "@/lib/settings/service";

export async function GET() {
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

  const { settings, parseError } = await getSettings(shop.id);
  if (!settings) {
    return NextResponse.json(
      { error: "Settings parse failed", details: parseError },
      { status: 500 }
    );
  }

  return NextResponse.json(settings);
}

export async function PATCH(request: NextRequest) {
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

  const body = await request.json();
  const result = await updateSettings(shop.id, body);

  if (!result.success) {
    return NextResponse.json(
      { error: result.error },
      { status: 500 }
    );
  }

  return NextResponse.json({ ok: true });
}
