# Integration Framework

How to add a new provider to the voice agent SaaS.

## The Interface

Every provider implements `IntegrationProvider` from `lib/integrations/provider.ts`:

```typescript
interface IntegrationProvider {
  readonly slug: string;          // e.g. "twilio_sms"
  readonly name: string;          // e.g. "Twilio SMS"
  readonly requiredScopes: string[];

  // OAuth
  getAuthUrl(shopId: string, redirectUri: string): string;
  exchangeCode(code: string, redirectUri: string): Promise<OAuthTokenSet>;
  refreshTokens(row: ShopIntegrationRow): Promise<OAuthTokenSet>;
  revoke?(row: ShopIntegrationRow): Promise<void>;

  // Runtime — what the voice agent calls
  checkAvailability(shopId: string, query: AvailabilityQuery): Promise<TimeSlot[]>;
  createBooking(shopId: string, booking: BookingRequest): Promise<BookingResult>;
}
```

## Step-by-step: Adding Twilio SMS

### 1. Create the provider file

`lib/integrations/twilio-sms.ts`

```typescript
export const twilioSmsProvider: IntegrationProvider = {
  slug: "twilio_sms",
  name: "Twilio SMS",
  requiredScopes: [],

  getAuthUrl(shopId, redirectUri) {
    // Build Twilio Connect URL or your own auth flow
    return `https://www.twilio.com/authorize?...`;
  },

  async exchangeCode(code, redirectUri) {
    // Exchange Twilio authorization code for tokens
    return { accessToken, refreshToken, expiresAt, scopes, providerAccountEmail };
  },

  async refreshTokens(row) {
    // Refresh access token using row.refresh_token
    return { accessToken, refreshToken, expiresAt, scopes, providerAccountEmail };
  },

  async checkAvailability() {
    // SMS has no availability slots — return empty or meaningful default
    return [];
  },

  async createBooking(shopId, booking) {
    // Send an SMS confirmation to the customer
    // Return success with a message SID
    return { success: true, providerEventId: messageSid };
  },
};
```

### 2. Register it

In `lib/integrations/registry.ts`:

```typescript
import { twilioSmsProvider } from "./twilio-sms";

const registry = new Map<string, IntegrationProvider>([
  [googleCalendarProvider.slug, googleCalendarProvider],
  [twilioSmsProvider.slug, twilioSmsProvider],
]);
```

### 3. Add environment variables

Add to `.env.local` and Vercel:

```
TWILIO_ACCOUNT_SID=...
TWILIO_AUTH_TOKEN=...
```

### 4. Database

`shop_integrations` is provider-agnostic. No schema changes needed. The new provider's rows will have `provider = 'twilio_sms'`.

### 5. UI

Add an `<IntegrationCard provider="twilio_sms" name="Twilio SMS" ... />` to the dashboard. The card is generic — no component changes needed.

### 6. Agent-facing endpoints

If the voice agent needs to call the new provider at runtime:

```typescript
// In the agent bridge on Railway
const res = await fetch(`${VERCEL_URL}/api/agent/send-sms`, {
  method: "POST",
  headers: {
    "x-shop-id": shopId,
    "x-request-timestamp": String(Date.now()),
    "x-agent-signature": hmac,
  },
  body: JSON.stringify({ to, message }),
});
```

Create the matching route under `app/api/agent/send-sms/route.ts` with HMAC verification.

### 7. That's it

The generic OAuth routes (`/api/integrations/twilio_sms/connect`, `/callback`, `/disconnect`), token refresh cron, and status computation all work automatically.

## Key Principles

- **Never put provider-specific code outside the provider file.** The shared layer (`oauth-router.ts`, `refresh.ts`, `status.ts`) stays generic.
- **Provider methods read from Supabase directly.** They receive `shopId` and look up their own integration row + shop config. No state in the provider instance.
- **Token refresh is automatic.** The cron endpoint refreshes all tokens expiring within 10 minutes. Agent-facing endpoints call `refreshIfNeeded` before using a provider.
- **Errors surface as `needs_attention`.** The dashboard shows one card with a reconnect button. Technical details go to `last_error` JSONB and the operator-only `integration_events` table, not the client UI.
- **Log integration events.** Use `lib/integrations/events.ts` to log significant events (connect, disconnect, token refresh, booking failures) for operator observability.
