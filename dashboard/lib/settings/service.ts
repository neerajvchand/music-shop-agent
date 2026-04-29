import { createServiceClient } from "@/lib/supabase";
import { ShopSettings, ShopSettingsSchema } from "./schema";

function normalizeServices(raw: unknown[]): ShopSettings["services"] {
  return raw.map((s: any) => ({
    id: s.id || s.slug,
    name: s.name,
    duration_minutes: s.duration_minutes || s.duration_min || 60,
    price: s.price ?? null,
    active: s.active !== false,
  }));
}

export async function getSettings(
  shopId: string
): Promise<{ settings: ShopSettings | null; parseError?: string }> {
  const supabase = createServiceClient();

  const { data, error } = await supabase
    .from("shops")
    .select(
      "greeting, voice_id, business_hours_json, services_json, booking_buffer_minutes, off_hours_behavior"
    )
    .eq("id", shopId)
    .single();

  if (error || !data) return { settings: null };

  const parsed = ShopSettingsSchema.safeParse({
    greeting: data.greeting,
    voice_id: data.voice_id,
    business_hours: data.business_hours_json,
    services: normalizeServices(data.services_json || []),
    booking_buffer_minutes: data.booking_buffer_minutes,
    off_hours_behavior: data.off_hours_behavior,
  });

  if (!parsed.success) {
    const err = JSON.stringify(parsed.error.flatten());
    console.error("Settings parse error:", err);
    return { settings: null, parseError: err };
  }

  return { settings: parsed.data };
}

export async function updateSettings(
  shopId: string,
  partial: Partial<ShopSettings>
): Promise<{ success: boolean; error?: string }> {
  const supabase = createServiceClient();

  const allowed: Record<string, unknown> = {};
  if (partial.greeting !== undefined) allowed.greeting = partial.greeting;
  if (partial.voice_id !== undefined) allowed.voice_id = partial.voice_id;
  if (partial.business_hours !== undefined)
    allowed.business_hours_json = partial.business_hours;
  if (partial.booking_buffer_minutes !== undefined)
    allowed.booking_buffer_minutes = partial.booking_buffer_minutes;
  if (partial.off_hours_behavior !== undefined)
    allowed.off_hours_behavior = partial.off_hours_behavior;

  // Merge services with original to preserve voice-bridge fields (slug, teacher)
  if (partial.services !== undefined) {
    const { data: original } = await supabase
      .from("shops")
      .select("services_json")
      .eq("id", shopId)
      .single();

    const originalMap = new Map(
      (original?.services_json || []).map((s: any) => [s.slug || s.id, s])
    );

    allowed.services_json = partial.services.map((newSvc) => {
      const oldSvc = originalMap.get(newSvc.id) || {};
      return {
        ...oldSvc,
        name: newSvc.name,
        duration_min: newSvc.duration_minutes,
        active: newSvc.active,
      };
    });
  }

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
