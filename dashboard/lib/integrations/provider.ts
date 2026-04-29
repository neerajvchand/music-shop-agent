export interface OAuthTokenSet {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  scopes: string[];
  providerAccountEmail: string;
}

export interface AvailabilityQuery {
  date: string; // ISO date, e.g. "2026-05-01"
  durationMinutes: number;
  timezone: string;
}

export interface TimeSlot {
  start: string; // ISO datetime
  end: string;
}

export interface BookingRequest {
  customerName: string;
  customerPhone: string;
  service: string;
  startTime: string; // ISO datetime
  durationMinutes: number;
  notes?: string;
}

export interface BookingResult {
  success: boolean;
  bookingId?: string;
  providerEventId?: string;
  error?: string;
}

export interface ShopIntegrationRow {
  shop_id: string;
  provider: string;
  provider_account_email: string | null;
  access_token: string | null;
  refresh_token: string | null;
  token_expires_at: string | null;
  scopes: string[];
  status: "connected" | "needs_attention" | "disconnected";
  last_error: { code: string; message: string; occurred_at: string } | null;
  last_refreshed_at: string | null;
  connected_at: string | null;
  metadata_json: Record<string, unknown>;
}

export interface IntegrationProvider {
  readonly slug: string;
  readonly name: string;
  readonly requiredScopes: string[];

  getAuthUrl(shopId: string, redirectUri: string): string;
  exchangeCode(code: string, redirectUri: string): Promise<OAuthTokenSet>;
  refreshTokens(row: ShopIntegrationRow): Promise<OAuthTokenSet>;
  revoke?(row: ShopIntegrationRow): Promise<void>;

  // Runtime — called by agent-facing endpoints
  checkAvailability(shopId: string, query: AvailabilityQuery): Promise<TimeSlot[]>;
  createBooking(shopId: string, booking: BookingRequest): Promise<BookingResult>;
}
