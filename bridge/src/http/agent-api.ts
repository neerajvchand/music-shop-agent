import type { Logger } from "../logger";
import { buildSignedHeaders } from "./hmac";

// Thin client for the Vercel /api/agent/* endpoints. Mirrors
// app/calendar/agent_client.py — same paths, same body shapes, same
// canonical error format the LLM consumes.

const DEFAULT_TIMEOUT_MS = 15_000;

export class AgentApiError extends Error {
  constructor(
    message: string,
    public readonly status: number | null = null,
    public readonly body: unknown = null,
  ) {
    super(message);
    this.name = "AgentApiError";
  }
}

export interface AgentApiContext {
  dashboardBaseUrl: string;
  agentApiSecret: string;
  shopId: string;
  logger: Logger;
}

async function post(
  ctx: AgentApiContext,
  path: string,
  body: Record<string, unknown>,
  timeoutMs: number,
): Promise<unknown> {
  const url = `${ctx.dashboardBaseUrl}${path}`;
  const headers = buildSignedHeaders({
    shopId: ctx.shopId,
    secret: ctx.agentApiSecret,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: headers as unknown as Record<string, string>,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === "AbortError") {
      throw new AgentApiError(`agent_api timeout (${timeoutMs}ms) on ${path}`);
    }
    throw new AgentApiError(`agent_api network error on ${path}: ${(err as Error).message}`);
  }
  clearTimeout(timer);

  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    parsed = { raw: await res.text().catch(() => "") };
  }

  if (res.status >= 400) {
    // 409 from create_booking is the slot-taken signal — surface as-is.
    ctx.logger.info("agent_api.non_2xx", { path, status: res.status, body: parsed });
    throw new AgentApiError(`${path} returned ${res.status}`, res.status, parsed);
  }
  return parsed;
}

export async function checkAvailability(
  ctx: AgentApiContext,
  args: { date: string; durationMinutes: number; timezone?: string },
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<unknown> {
  return post(ctx, "/api/agent/check-availability", args, timeoutMs);
}

export async function createBooking(
  ctx: AgentApiContext,
  args: {
    customerName: string;
    customerPhone: string;
    service: string;
    startTime: string;
    durationMinutes: number;
    notes?: string;
  },
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<unknown> {
  return post(ctx, "/api/agent/create-booking", args, timeoutMs);
}
