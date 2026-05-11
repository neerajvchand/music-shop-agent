import type { SupabaseClient } from "@supabase/supabase-js";
import type { Logger } from "../logger";

// Shop type mirrors app/shops.py — only the fields the bridge consumes.
// Phase 1 reads the same `shops` row the Python bridge does; data-layer
// compatibility is required for the Phase 3 cutover.
export interface Shop {
  id: string;
  slug: string;
  name: string;
  status: string;
  twilio_number: string;
  timezone: string;
  locale: string;
  greeting: string;
  farewell: string;
  voice_id: string;
  llm_provider: string;
  llm_model: string;
  vertical_slug: string | null;
  test_mode: boolean;

  // JSON columns used by renderers
  business_hours_json: unknown;
  services_json: unknown;
  age_policy_json: unknown;
  talent_on_tour_json: unknown;
  escalation_json: unknown;

  // Optional address/phone for placeholder rendering
  address: string | null;
  public_phone: string | null;
}

const DEFAULT_FAREWELL = "Thank you for calling. Have a wonderful day!";

function rowToShop(row: Record<string, unknown>): Shop {
  return {
    id: String(row.id),
    slug: String(row.slug ?? ""),
    name: String(row.name ?? ""),
    status: String(row.status ?? ""),
    twilio_number: String(row.twilio_number ?? ""),
    timezone: String(row.timezone ?? "UTC"),
    locale: String(row.locale ?? "en-US"),
    greeting: String(row.greeting ?? ""),
    // Match Python's default (app/shops.py:21) — same fallback string.
    farewell: (row.farewell as string) || DEFAULT_FAREWELL,
    voice_id: String(row.voice_id ?? "rex"),
    llm_provider: String(row.llm_provider ?? ""),
    llm_model: String(row.llm_model ?? ""),
    vertical_slug: (row.vertical_slug as string | null) ?? null,
    test_mode: Boolean(row.test_mode),
    business_hours_json: row.business_hours_json ?? null,
    services_json: row.services_json ?? null,
    age_policy_json: row.age_policy_json ?? null,
    talent_on_tour_json: row.talent_on_tour_json ?? null,
    escalation_json: row.escalation_json ?? null,
    address: (row.address as string | null) ?? null,
    public_phone: (row.public_phone as string | null) ?? null,
  };
}

// Mirrors get_shop_by_twilio_number from app/shops.py.
// Same select * + eq(twilio_number) + eq(status='active') + limit(1).
export async function getShopByTwilioNumber(
  sb: SupabaseClient,
  twilioNumber: string,
  logger: Logger,
): Promise<Shop | null> {
  const { data, error } = await sb
    .from("shops")
    .select("*")
    .eq("twilio_number", twilioNumber)
    .eq("status", "active")
    .limit(1);
  if (error) {
    logger.error("shops.lookup.error", { twilioNumber, err: error });
    return null;
  }
  if (!data || data.length === 0) return null;
  return rowToShop(data[0] as Record<string, unknown>);
}
