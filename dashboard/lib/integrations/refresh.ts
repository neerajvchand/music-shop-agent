import { createServiceClient } from "@/lib/supabase";
import { TokenRefreshError } from "./errors";
import { logIntegrationEvent } from "./events";
import { getProvider } from "./registry";
import { computeStatus } from "./status";

export async function refreshIfNeeded(
  shopId: string,
  providerSlug: string
): Promise<void> {
  const supabase = createServiceClient();

  // Try to acquire advisory lock
  const { data: gotLock } = await supabase.rpc("try_integration_lock", {
    p_shop_id: shopId,
    p_provider: providerSlug,
  });

  if (!gotLock) {
    // Another request is refreshing. Wait briefly and re-read.
    await new Promise((r) => setTimeout(r, 500));
    const { data: row } = await supabase
      .from("shop_integrations")
      .select("token_expires_at, status")
      .eq("shop_id", shopId)
      .eq("provider", providerSlug)
      .single();

    if (row && computeStatus(row as any) === "connected") {
      return; // someone else refreshed successfully
    }
    // proceed anyway — worst case is one wasted Google call
  }

  try {
    const { data: row, error: fetchError } = await supabase
      .from("shop_integrations")
      .select("*")
      .eq("shop_id", shopId)
      .eq("provider", providerSlug)
      .single();

    if (fetchError || !row) {
      throw new TokenRefreshError("Integration not found", providerSlug);
    }

    const expiresAt = row.token_expires_at
      ? new Date(row.token_expires_at)
      : null;
    const now = new Date();
    const bufferMs = 10 * 60 * 1000; // refresh if expires within 10 min

    if (!expiresAt || expiresAt.getTime() - now.getTime() > bufferMs) {
      return; // nothing to do
    }

    const provider = getProvider(providerSlug);
    if (!provider) {
      throw new TokenRefreshError("Unknown provider", providerSlug);
    }

    const tokens = await provider.refreshTokens(row);

    await supabase
      .from("shop_integrations")
      .update({
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
        token_expires_at: tokens.expiresAt.toISOString(),
        scopes: tokens.scopes,
        status: "connected",
        last_error: null,
        last_refreshed_at: now.toISOString(),
      })
      .eq("shop_id", shopId)
      .eq("provider", providerSlug);

    await logIntegrationEvent(shopId, providerSlug, "token_refreshed", {
      expires_at: tokens.expiresAt.toISOString(),
    });
  } catch (err: any) {
    const now = new Date();
    const errorPayload = {
      code: err.code || "refresh_failed",
      message: err.message || "Token refresh failed",
      occurred_at: now.toISOString(),
    };

    await supabase
      .from("shop_integrations")
      .update({
        status: "needs_attention",
        last_error: errorPayload,
        last_refreshed_at: now.toISOString(),
      })
      .eq("shop_id", shopId)
      .eq("provider", providerSlug);

    await logIntegrationEvent(shopId, providerSlug, "token_refresh_failed", {
      error: errorPayload,
    });

    throw new TokenRefreshError(err.message, providerSlug);
  } finally {
    if (gotLock) {
      await supabase.rpc("release_integration_lock", {
        p_shop_id: shopId,
        p_provider: providerSlug,
      });
    }
  }
}

export async function refreshAllSoonToExpire(): Promise<{
  refreshed: number;
  failed: number;
}> {
  const supabase = createServiceClient();
  const threshold = new Date(Date.now() + 10 * 60 * 1000).toISOString();

  const { data: rows } = await supabase
    .from("shop_integrations")
    .select("shop_id, provider")
    .eq("status", "connected")
    .lte("token_expires_at", threshold);

  let refreshed = 0;
  let failed = 0;

  for (const row of rows || []) {
    try {
      await refreshIfNeeded(row.shop_id, row.provider);
      refreshed++;
    } catch {
      failed++;
    }
  }

  return { refreshed, failed };
}
