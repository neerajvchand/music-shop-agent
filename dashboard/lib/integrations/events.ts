import { createServiceClient } from "@/lib/supabase";

export async function logIntegrationEvent(
  shopId: string,
  provider: string,
  eventType: string,
  payload: Record<string, unknown> = {}
): Promise<void> {
  const supabase = createServiceClient();
  await supabase.from("integration_events").insert({
    shop_id: shopId,
    provider,
    event_type: eventType,
    payload,
    occurred_at: new Date().toISOString(),
  });
}
