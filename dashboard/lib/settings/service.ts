import { createServiceClient } from "@/lib/supabase";
import { ShopSettings, ShopSettingsSchema } from "./schema";

export async function getSettings(shopId: string): Promise<ShopSettings | null> {
  const supabase = createServiceClient();

  const { data, error } = await supabase
    .from("shops")
    .select(
      "greeting, voice_id, business_hours_json, services_json, booking_buffer_minutes, off_hours_behavior"
    )
    .eq("id", shopId)
    .single();

  if (error || !data) return null;

  const parsed = ShopSettingsSchema.safeParse({
    greeting: data.greeting,
    voice_id: data.voice_id,
    business_hours: data.business_hours_json,
    services: data.services_json,
    booking_buffer_minutes: data.booking_buffer_minutes,
    off_hours_behavior: data.off_hours_behavior,
  });

  if (!parsed.success) {
    console.error("Settings parse error:", parsed.error.flatten());
    return null;
  }

  return parsed.data;
}

export async function updateSettings(
  shopId: string,
  partial: Partial<ShopSettings>
): Promise<{ success: boolean; error?: string }> {
  const supabase = createServiceClient();

  // Only allow updating client-editable fields
  const allowed: Record<string, unknown> = {};
  if (partial.greeting !== undefined) allowed.greeting = partial.greeting;
  if (partial.voice_id !== undefined) allowed.voice_id = partial.voice_id;
  if (partial.business_hours !== undefined)
    allowed.business_hours_json = partial.business_hours;
  if (partial.services !== undefined) allowed.services_json = partial.services;
  if (partial.booking_buffer_minutes !== undefined)
    allowed.booking_buffer_minutes = partial.booking_buffer_minutes;
  if (partial.off_hours_behavior !== undefined)
    allowed.off_hours_behavior = partial.off_hours_behavior;

  if (Object.keys(allowed).length === 0) {
    return { success: true };
  }

  const { error } = await supabase
    .from("shops")
    .update({ ...allowed, updated_at: new Date().toISOString() })
    .eq("id", shopId);

  if (error) {
    return { success: false, error: error.message };
  }

  return { success: true };
}
