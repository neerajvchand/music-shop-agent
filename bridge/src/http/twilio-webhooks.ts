import type { Request, Response } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Logger } from "../logger";
import { getShopByTwilioNumber } from "../supabase/shops";
import { buildTwiML } from "../twilio/twiml";

export interface TwilioWebhookContext {
  sb: SupabaseClient;
  hostname: string;
  logger: Logger;
}

// POST /twiml — Twilio incoming-call webhook.
// Resolves the shop by the `To` form field, returns TwiML with a
// <Connect><Stream url=wss://.../twilio/ws/:callId/> handoff.
export function twimlHandler(ctx: TwilioWebhookContext) {
  return async (req: Request, res: Response): Promise<void> => {
    const to = String((req.body as Record<string, unknown>).To ?? "");
    const from = String((req.body as Record<string, unknown>).From ?? "");
    ctx.logger.info("twilio.incoming", { to, from });

    const shop = await getShopByTwilioNumber(ctx.sb, to, ctx.logger);
    if (!shop) {
      ctx.logger.warn("twilio.shop_not_found", { to });
      res.status(200).type("application/xml").send(
        `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>We're sorry, we can't locate the shop for this number. Goodbye.</Say>
  <Hangup/>
</Response>`,
      );
      return;
    }

    const callId = `call_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    const wsUrl = `wss://${ctx.hostname}/twilio/ws/${callId}`;
    const twiml = buildTwiML({
      wsUrl,
      shopSlug: shop.slug,
      recordingDisclosureEnabled: false, // Phase 1 default; see twiml.ts comment.
    });

    res.status(200).type("application/xml").send(twiml);
  };
}

// POST /call-status — Twilio status callback. We just 200 and log.
export function callStatusHandler(ctx: TwilioWebhookContext) {
  return (req: Request, res: Response): void => {
    const sid = String((req.body as Record<string, unknown>).CallSid ?? "");
    const status = String((req.body as Record<string, unknown>).CallStatus ?? "");
    ctx.logger.info("twilio.status", { sid, status });
    res.status(200).end();
  };
}
