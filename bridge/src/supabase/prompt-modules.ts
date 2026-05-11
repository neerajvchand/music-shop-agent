import type { SupabaseClient } from "@supabase/supabase-js";
import type { Logger } from "../logger";

// Mirrors app/prompts/registry.py — same select shape, same status='live'
// filter, same NULL-vs-equal handling for vertical_slug.

export interface PromptModule {
  name: string;
  version: number;
  vertical_slug: string | null;
  content: string;
  params_schema: { properties?: Record<string, unknown> } | null;
  status: string;
}

export interface ShopPromptBinding {
  shop_id: string;
  module_name: string;
  module_version: number;
  vertical_slug: string | null;
}

export async function loadBindings(
  sb: SupabaseClient,
  shopId: string,
  logger: Logger,
): Promise<ShopPromptBinding[]> {
  const { data, error } = await sb
    .from("shop_prompt_bindings")
    .select("*")
    .eq("shop_id", shopId);
  if (error) {
    logger.error("bindings.lookup.error", { shopId, err: error });
    return [];
  }
  return (data ?? []) as ShopPromptBinding[];
}

export async function loadModule(
  sb: SupabaseClient,
  params: { name: string; version: number; vertical: string | null },
  logger: Logger,
): Promise<PromptModule | null> {
  let q = sb
    .from("prompt_modules")
    .select("name, version, vertical_slug, content, params_schema, status")
    .eq("name", params.name)
    .eq("version", params.version)
    .eq("status", "live");
  q = params.vertical ? q.eq("vertical_slug", params.vertical) : q.is("vertical_slug", null);
  const { data, error } = await q.limit(1);
  if (error) {
    logger.error("prompt_modules.lookup.error", { ...params, err: error });
    return null;
  }
  if (!data || data.length === 0) {
    logger.warn("prompt_modules.not_found", params);
    return null;
  }
  return data[0] as PromptModule;
}
