import { NextRequest, NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "crypto";

const SECRET = process.env.AGENT_API_SECRET || "";
const MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes

export function verifyAgentRequest(request: NextRequest): {
  shopId: string;
  ok: true;
} | {
  ok: false;
  response: NextResponse;
} {
  const shopId = request.headers.get("x-shop-id");
  const timestamp = request.headers.get("x-request-timestamp");
  const signature = request.headers.get("x-agent-signature");

  if (!shopId || !timestamp || !signature) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Missing auth headers" },
        { status: 401 }
      ),
    };
  }

  const ts = parseInt(timestamp, 10);
  if (isNaN(ts) || Date.now() - ts > MAX_AGE_MS) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Request expired" },
        { status: 401 }
      ),
    };
  }

  const payload = `${shopId}:${timestamp}`;
  const expected = createHmac("sha256", SECRET).update(payload).digest("hex");

  try {
    const sigBuf = Buffer.from(signature, "hex");
    const expBuf = Buffer.from(expected, "hex");
    if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
      throw new Error("Signature mismatch");
    }
  } catch {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Invalid signature" },
        { status: 401 }
      ),
    };
  }

  return { ok: true, shopId };
}
