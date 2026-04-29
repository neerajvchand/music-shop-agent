import { ShopIntegrationRow } from "./provider";

export type IntegrationStatus = "connected" | "needs_attention" | "disconnected";

const BUFFER_MS = 5 * 60 * 1000; // 5 minutes

export function computeStatus(row: ShopIntegrationRow): IntegrationStatus {
  if (row.status === "disconnected") return "disconnected";

  const expiresAt = row.token_expires_at ? new Date(row.token_expires_at) : null;
  const now = new Date();

  if (expiresAt && expiresAt.getTime() - now.getTime() < BUFFER_MS) {
    return "needs_attention";
  }

  if (row.last_error && row.status === "needs_attention") {
    return "needs_attention";
  }

  return row.status;
}

export function statusLabel(status: IntegrationStatus): string {
  switch (status) {
    case "connected":
      return "Connected";
    case "needs_attention":
      return "Needs attention";
    case "disconnected":
      return "Not connected";
  }
}
