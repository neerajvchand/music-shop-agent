import { createServiceClient } from "@/lib/supabase";
import { ShopSettings, ShopSettingsSchema } from "./schema";

function normalizeServices(raw: unknown[]): ShopSettings["services"] {
  return raw.map((s: any) => ({
    id: s.id || s.slug,
    name: s.name,
    duration_minutes: s.duration_minutes || s.duration_min || 60,
    price: s.price ?? null,
    active: s.active !== false,
    instructor: s.instructor ?? null,
    mode: s.mode || "both",
    is_lesson: s.is_lesson ?? (typeof s.name === "string" && s.name.toLowerCase().includes("lesson")),
  }));
}

const DEFAULTS = {
  languages: { mirrors: [] },
  rentals: {
    short_term: { enabled: false, day_rate: 0, deposit: 0 },
    monthly_student: { enabled: false, rate: 0 },
  },
  cancellation_policy: {
    enabled: false,
    hours_before: 48,
    percent_charge: 50,
    mention_when: "asked_only" as const,
  },
  payment_portal: { url: null, mention_autopay: false },
  escalation: { live_person_callback: false, callback_sla_text: "shortly" },
  talent_on_tour: { instructors: [] },
  age_policy: { minimum_age: 0, mode: "soft" as const },
};

export async function getSettings(
  shopId: string
): Promise<{ settings: ShopSettings | null; parseError?: string }> {
  const supabase = createServiceClient();

  const { data, error } = await supabase
    .from("shops")
    .select(
      "greeting, voice_id, business_hours_json, services_json, booking_buffer_minutes, off_hours_behavior, public_phone, address, languages_json, rentals_json, cancellation_policy_json, payment_portal_json, escalation_json, talent_on_tour_json, age_policy_json"
    )
    .eq("id", shopId)
    .single();

  if (error || !data) return { settings: null };

  const row = data as any;
  const rawServices = row.services_json || [];
  const normalizedServices = normalizeServices(rawServices);

  const parsed = ShopSettingsSchema.safeParse({
    greeting: row.greeting,
    voice_id: row.voice_id,
    business_hours: row.business_hours_json,
    services: normalizedServices,
    booking_buffer_minutes: row.booking_buffer_minutes,
    off_hours_behavior: row.off_hours_behavior,
    public_phone: row.public_phone,
    address: row.address,
    languages: row.languages_json ?? DEFAULTS.languages,
    rentals: row.rentals_json ?? DEFAULTS.rentals,
    cancellation_policy: row.cancellation_policy_json ?? DEFAULTS.cancellation_policy,
    payment_portal: row.payment_portal_json ?? DEFAULTS.payment_portal,
    escalation: row.escalation_json ?? DEFAULTS.escalation,
    talent_on_tour: row.talent_on_tour_json ?? DEFAULTS.talent_on_tour,
    age_policy: row.age_policy_json ?? DEFAULTS.age_policy,
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
  if (partial.public_phone !== undefined) allowed.public_phone = partial.public_phone;
  if (partial.address !== undefined) allowed.address = partial.address;
  if (partial.languages !== undefined) allowed.languages_json = partial.languages;
  if (partial.rentals !== undefined) allowed.rentals_json = partial.rentals;
  if (partial.cancellation_policy !== undefined)
    allowed.cancellation_policy_json = partial.cancellation_policy;
  if (partial.payment_portal !== undefined) allowed.payment_portal_json = partial.payment_portal;
  if (partial.escalation !== undefined) allowed.escalation_json = partial.escalation;
  if (partial.talent_on_tour !== undefined) allowed.talent_on_tour_json = partial.talent_on_tour;
  if (partial.age_policy !== undefined) allowed.age_policy_json = partial.age_policy;

  // Merge services with original to preserve voice-bridge fields (slug,
  // teacher) and write through every editable field — including price,
  // which the previous version silently dropped.
  if (partial.services !== undefined) {
    const { data: original } = await supabase
      .from("shops")
      .select("services_json")
      .eq("id", shopId)
      .single();

    const originalMap = new Map(
      (original?.services_json || []).map((s: any) => [s.slug || s.id, s])
    );

    allowed.services_json = partial.services.map((newSvc: ShopSettings["services"][number]) => {
      const oldSvc = (originalMap.get(newSvc.id) as any) || {};
      return {
        ...oldSvc,
        id: newSvc.id,
        slug: oldSvc.slug || newSvc.id,
        name: newSvc.name,
        duration_min: newSvc.duration_minutes,
        duration_minutes: newSvc.duration_minutes,
        price: newSvc.price ?? null,
        active: newSvc.active,
        instructor: newSvc.instructor ?? null,
        mode: newSvc.mode || "both",
        is_lesson: newSvc.is_lesson,
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
