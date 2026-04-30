import { DateTime } from "luxon";
import { createServiceClient } from "@/lib/supabase";
import {
  buildGoogleOAuthUrl,
  exchangeCodeForTokens,
  getGoogleUserInfo,
} from "@/lib/google-oauth";
import { ProviderApiError } from "./errors";
import {
  AvailabilityQuery,
  BookingRequest,
  BookingResult,
  IntegrationProvider,
  OAuthTokenSet,
  ShopIntegrationRow,
  TimeSlot,
} from "./provider";

const GOOGLE_CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/userinfo.email openid";

function getCredentials() {
  const clientId = process.env.GOOGLE_CLIENT_ID!;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET!;
  if (!clientId || !clientSecret) {
    throw new Error("Google OAuth credentials not configured");
  }
  return { clientId, clientSecret };
}

async function getIntegration(shopId: string) {
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("shop_integrations")
    .select("*")
    .eq("shop_id", shopId)
    .eq("provider", "google_calendar")
    .single();

  if (error || !data) throw new ProviderApiError("Google Calendar not connected");
  return data as ShopIntegrationRow;
}

async function getShopConfig(shopId: string) {
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("shops")
    .select("timezone, business_hours_json, booking_buffer_minutes")
    .eq("id", shopId)
    .single();

  if (error || !data) throw new ProviderApiError("Shop not found");
  return data;
}

function dayName(dateStr: string, tz: string): string {
  const days = [
    "sunday",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
  ];
  const dt = DateTime.fromISO(dateStr, { zone: tz });
  const jsWeekday = dt.weekday === 7 ? 0 : dt.weekday;
  return days[jsWeekday];
}

function parseTime(timeStr: string, dateStr: string, tz: string): Date {
  const [h, m] = timeStr.split(":").map(Number);
  return DateTime.fromISO(dateStr, { zone: tz })
    .set({ hour: h, minute: m, second: 0, millisecond: 0 })
    .toJSDate();
}

export const googleCalendarProvider: IntegrationProvider = {
  slug: "google_calendar",
  name: "Google Calendar",
  requiredScopes: [GOOGLE_CALENDAR_SCOPE],

  getAuthUrl(shopId: string, redirectUri: string): string {
    const { clientId } = getCredentials();
    return buildGoogleOAuthUrl({
      clientId,
      redirectUri,
      scope: GOOGLE_CALENDAR_SCOPE,
      state: Buffer.from(JSON.stringify({ shop_id: shopId, nonce: crypto.randomUUID() })).toString("base64url"),
    });
  },

  async exchangeCode(code: string, redirectUri: string): Promise<OAuthTokenSet> {
    const { clientId, clientSecret } = getCredentials();
    const tokenData = await exchangeCodeForTokens({
      code,
      clientId,
      clientSecret,
      redirectUri,
    });

    const userInfo = await getGoogleUserInfo(tokenData.access_token);

    return {
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token || "",
      expiresAt: new Date(Date.now() + tokenData.expires_in * 1000),
      scopes: tokenData.scope.split(" "),
      providerAccountEmail: userInfo.email,
    };
  },

  async refreshTokens(row: ShopIntegrationRow): Promise<OAuthTokenSet> {
    const { clientId, clientSecret } = getCredentials();

    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: row.refresh_token || "",
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new ProviderApiError(`Refresh failed: ${text}`, res.status);
    }

    const data = await res.json() as {
      access_token: string;
      expires_in: number;
      scope: string;
    };

    return {
      accessToken: data.access_token,
      refreshToken: row.refresh_token || "",
      expiresAt: new Date(Date.now() + data.expires_in * 1000),
      scopes: data.scope.split(" "),
      providerAccountEmail: row.provider_account_email || "",
    };
  },

  async checkAvailability(
    shopId: string,
    query: AvailabilityQuery
  ): Promise<TimeSlot[]> {
    const integration = await getIntegration(shopId);
    const shop = await getShopConfig(shopId);

    const tz = shop.timezone || query.timezone || "America/Los_Angeles";
    const day = dayName(query.date, tz);
    const hours = shop.business_hours_json?.[day];
    if (!hours) return [];

    const open = parseTime(hours.open, query.date, tz);
    const close = parseTime(hours.close, query.date, tz);

    const timeMin = open.toISOString();
    const timeMax = close.toISOString();

    const url = new URL("https://www.googleapis.com/calendar/v3/calendars/primary/events");
    url.searchParams.set("timeMin", timeMin);
    url.searchParams.set("timeMax", timeMax);
    url.searchParams.set("singleEvents", "true");
    url.searchParams.set("orderBy", "startTime");

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${integration.access_token}` },
    });

    if (!res.ok) {
      throw new ProviderApiError("Failed to fetch calendar events", res.status);
    }

    const data = await res.json() as {
      items: Array<{
        start: { dateTime?: string };
        end: { dateTime?: string };
      }>;
    };

    const events = (data.items || [])
      .map((e) => ({
        start: new Date(e.start?.dateTime || 0),
        end: new Date(e.end?.dateTime || 0),
      }))
      .filter((e) => !isNaN(e.start.getTime()));

    const bufferMs = (shop.booking_buffer_minutes || 0) * 60 * 1000;
    const durationMs = query.durationMinutes * 60 * 1000;
    const slots: TimeSlot[] = [];

    let cursor = open.getTime();

    for (const evt of events) {
      const avail = evt.start.getTime() - cursor - bufferMs;
      if (avail >= durationMs) {
        slots.push({
          start: new Date(cursor).toISOString(),
          end: new Date(cursor + durationMs).toISOString(),
        });
      }
      cursor = Math.max(cursor, evt.end.getTime() + bufferMs);
    }

    if (close.getTime() - cursor >= durationMs) {
      slots.push({
        start: new Date(cursor).toISOString(),
        end: new Date(cursor + durationMs).toISOString(),
      });
    }

    return slots;
  },

  async createBooking(
    shopId: string,
    booking: BookingRequest
  ): Promise<BookingResult> {
    const integration = await getIntegration(shopId);
    const shop = await getShopConfig(shopId);
    const tz = shop.timezone || "America/Los_Angeles";

    const start = new Date(booking.startTime);
    const end = new Date(start.getTime() + booking.durationMinutes * 60 * 1000);

    const event = {
      summary: `Booking: ${booking.service}`,
      description: `Customer: ${booking.customerName}\nPhone: ${booking.customerPhone}${
        booking.notes ? `\nNotes: ${booking.notes}` : ""
      }`,
      start: { dateTime: start.toISOString(), timeZone: tz },
      end: { dateTime: end.toISOString(), timeZone: tz },
    };

    const res = await fetch(
      "https://www.googleapis.com/calendar/v3/calendars/primary/events",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${integration.access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(event),
      }
    );

    if (!res.ok) {
      const text = await res.text();
      throw new ProviderApiError("Failed to create calendar event", res.status, text);
    }

    const data = await res.json() as { id: string };

    return {
      success: true,
      providerEventId: data.id,
    };
  },
};
