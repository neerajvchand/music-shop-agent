// TwiML response builder for the inbound voice webhook.
//
// Phase 1 defaults `recordingDisclosureEnabled` to false so test calls
// don't get a Twilio TTS preamble before the WebSocket connects. The
// Python bridge always speaks "This call may be recorded for quality
// purposes." — Phase 2 will add a `shops.recording_disclosure_enabled`
// column and flip this on per-shop before the Phase 3 cutover.

export interface BuildTwiMLParams {
  wsUrl: string;
  shopSlug: string;
  recordingDisclosureEnabled?: boolean;
  disclosureText?: string;
}

const DEFAULT_DISCLOSURE = "This call may be recorded for quality purposes.";

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function buildTwiML(params: BuildTwiMLParams): string {
  const disclosure = params.recordingDisclosureEnabled
    ? `<Say>${escapeXml(params.disclosureText ?? DEFAULT_DISCLOSURE)}</Say>`
    : "";

  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  ${disclosure}<Connect>
    <Stream url="${escapeXml(params.wsUrl)}">
      <Parameter name="shop" value="${escapeXml(params.shopSlug)}"/>
    </Stream>
  </Connect>
</Response>`;
}
