import type { SupabaseClient } from "@supabase/supabase-js";
import type { Logger } from "../logger";
import type { Shop } from "../supabase/shops";
import { loadBindings, loadModule, type ShopPromptBinding, type PromptModule } from "../supabase/prompt-modules";
import {
  renderAgePolicy,
  renderBusinessHours,
  renderEscalation,
  renderServices,
  renderTalentOnTour,
} from "./renderers";

// Compose the system prompt from 8 ordered modules joined with `\n\n---\n\n`
// and rendered placeholders. Mirrors app/prompts/composer.py:compose.
//
// The composer is the place where the slug-exposure pattern reaches the
// LLM: `services_text` is rendered from shop.services_json with `[slug]`
// brackets, then substituted into the relevant module(s).

const SEPARATOR = "\n\n---\n\n";
const UNSUBSTITUTED_PATTERN = /\{\{[a-zA-Z_][a-zA-Z0-9_]*\}\}/g;

const MODULE_ORDER = [
  "persona",
  "vertical",
  "business",
  "state",
  "runtime",
  "tools",
  "guardrails",
  "few_shot",
] as const;

export interface CallContext {
  shop_id: string;
  vertical: string | null;
  caller_phone: string | null;
  today: string;
  test_mode: boolean;

  // Settings-derived placeholders. Same names as Python's CallContext so the
  // params_schema lookup in prompt modules resolves identically.
  shop_name: string;
  shop_phone: string;
  shop_address: string;
  greeting: string;
  business_hours_text: string;
  services_text: string;
  age_policy_text: string;
  talent_on_tour_text: string;
  escalation_text: string;
}

export function buildCallContext(params: {
  shop: Shop;
  callerPhone: string | null;
  today: string;
  logger: Logger;
}): CallContext {
  const { shop, callerPhone, today, logger } = params;
  return {
    shop_id: shop.id,
    vertical: shop.vertical_slug,
    caller_phone: callerPhone,
    today,
    test_mode: shop.test_mode,
    shop_name: shop.name,
    shop_phone: shop.public_phone ?? "",
    shop_address: shop.address ?? "",
    greeting: shop.greeting,
    business_hours_text: renderBusinessHours(shop.business_hours_json, logger),
    services_text: renderServices(shop.services_json, logger),
    age_policy_text: renderAgePolicy(shop.age_policy_json, logger),
    talent_on_tour_text: renderTalentOnTour(shop.talent_on_tour_json, logger),
    escalation_text: renderEscalation(shop.escalation_json, logger),
  };
}

function renderModuleContent(module: PromptModule, ctx: CallContext): string {
  let content = module.content || "";
  const propNames = Object.keys(module.params_schema?.properties ?? {});
  for (const key of propNames) {
    const value = (ctx as unknown as Record<string, unknown>)[key];
    if (value === undefined) continue;
    const placeholder = `{{${key}}}`;
    if (!content.includes(placeholder)) continue;
    const rendered = typeof value === "string" ? value : JSON.stringify(value);
    content = content.split(placeholder).join(rendered);
  }
  return content;
}

export async function composeSystemPrompt(params: {
  sb: SupabaseClient;
  shop: Shop;
  context: CallContext;
  logger: Logger;
}): Promise<string> {
  const { sb, shop, context, logger } = params;

  const bindings = await loadBindings(sb, shop.id, logger);
  const byName = new Map<string, ShopPromptBinding>(bindings.map((b) => [b.module_name, b]));

  const sections: string[] = [];
  for (const name of MODULE_ORDER) {
    const binding = byName.get(name);
    if (!binding) continue;
    const module = await loadModule(
      sb,
      {
        name: binding.module_name,
        version: binding.module_version,
        vertical: binding.vertical_slug ?? shop.vertical_slug,
      },
      logger,
    );
    if (!module) continue;
    const rendered = renderModuleContent(module, context);
    sections.push(`## ${name.toUpperCase()}\n${rendered}`);
  }

  if (context.test_mode) {
    sections.push(
      "## TEST MODE\nThis is a TEST call. Do NOT write to any calendar. Confirm verbally that this is a test.",
    );
  }

  let full = sections.join(SEPARATOR);

  const survivors = full.match(UNSUBSTITUTED_PATTERN);
  if (survivors) {
    logger.warn("compose.unsubstituted_placeholders", {
      shopId: shop.id,
      survivors: Array.from(new Set(survivors)),
    });
    full = full.replace(UNSUBSTITUTED_PATTERN, "");
  }

  return full;
}
