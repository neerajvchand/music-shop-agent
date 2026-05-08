import { NextRequest, NextResponse } from "next/server";
import { verifyAgentRequest } from "../_auth";
import { refreshIfNeeded } from "@/lib/integrations/refresh";
import { getProvider } from "@/lib/integrations/registry";
import { createServiceClient } from "@/lib/supabase";
import {
  DEFAULT_DURATION_MIN,
  type ServiceCatalogEntry,
  type BusinessHours,
} from "@/lib/booking/validation";

const DAY_KEYS = [
  "monday", "tuesday", "wednesday", "thursday",
  "friday", "saturday", "sunday",
] as const;

function dayKey(weekday: number): typeof DAY_KEYS[number] {
  // JS Date.getDay() returns 0=Sun..6=Sat; we want 0=Mon..6=Sun.
  return DAY_KEYS[(weekday + 6) % 7];
}

function durationFor(svc: ServiceCatalogEntry | null, fallback: number): number {
  if (!svc) return fallback;
  if (typeof svc.duration_minutes === "number" && svc.duration_minutes > 0) {
    return svc.duration_minutes;
  }
  if (typeof svc.duration_min === "number" && svc.duration_min > 0) {
    return svc.duration_min;
  }
  return fallback;
}

function findService(
  services: ServiceCatalogEntry[] | null | undefined,
  slug: string,
): ServiceCatalogEntry | null {
  if (!services) return null;
  for (const s of services) {
    if (s.slug === slug || s.id === slug) return s;
  }
  return null;
}

function generateSlots(
  date: string,
  hours: { open: string; close: string },
  durationMinutes: number,
  bufferMinutes: number,
  tz: string,
): string[] {
  // Walk from open to close in steps of duration+buffer; emit ISO date-times.
  const [openH, openM] = hours.open.split(":").map((p) => parseInt(p, 10));
  const [closeH, closeM] = hours.close.split(":").map((p) => parseInt(p, 10));

  const slots: string[] = [];
  const step = durationMinutes + bufferMinutes;
  let minute = openH * 60 + openM;
  const closeMinute = closeH * 60 + closeM;

  while (minute + durationMinutes <= closeMinute) {
    const h = Math.floor(minute / 60);
    const m = minute % 60;
    const hh = h.toString().padStart(2, "0");
    const mm = m.toString().padStart(2, "0");
    // Naive ISO local time. The agent prompt uses the shop's timezone for
    // disambiguation; we surface the wall-clock time the caller will hear.
    slots.push(`${date}T${hh}:${mm}:00`);
    minute += step;
  }
  return slots;
}

export async function POST(request: NextRequest) {
  const auth = verifyAgentRequest(request);
  if (!auth.ok) return auth.response;

  const body = await request.json();
  const { date, durationMinutes: durationArg, timezone, service: serviceSlug } = body;

  if (!date) {
    return NextResponse.json(
      { error: "missing_date", message: "Date is required." },
      { status: 400 }
    );
  }

  // Pull the catalog + business_hours + test_mode + gcal_calendar_id from shop.
  const supabase = createServiceClient();
  const { data: shopRow, error: shopErr } = await supabase
    .from("shops")
    .select("timezone, business_hours_json, services_json, booking_buffer_minutes, gcal_calendar_id, test_mode")
    .eq("id", auth.shopId)
    .single();

  if (shopErr || !shopRow) {
    return NextResponse.json(
      { error: "shop_not_found", message: "Shop not found." },
      { status: 404 }
    );
  }

  const shop = shopRow as {
    timezone: string | null;
    business_hours_json: BusinessHours | null;
    services_json: ServiceCatalogEntry[] | null;
    booking_buffer_minutes: number | null;
    gcal_calendar_id: string | null;
    test_mode: boolean | null;
  };

  const tz = shop.timezone || timezone || "America/Los_Angeles";

  // Resolve duration: prefer catalog by slug; then explicit arg; then default.
  let duration = DEFAULT_DURATION_MIN;
  if (serviceSlug && shop.services_json && shop.services_json.length > 0) {
    const svc = findService(shop.services_json, serviceSlug);
    if (!svc) {
      return NextResponse.json({
        slots: [],
        durationMinutes: durationArg || DEFAULT_DURATION_MIN,
        reason: "missing_service",
      });
    }
    duration = durationFor(svc, durationArg || DEFAULT_DURATION_MIN);
  } else if (typeof durationArg === "number" && durationArg > 0) {
    duration = durationArg;
  }

  // Day-of-week lookup. JS Date constructed from "YYYY-MM-DD" alone is UTC
  // midnight; that's fine for picking the day key in any reasonable tz.
  const day = dayKey(new Date(date + "T00:00:00").getDay());
  const hours = shop.business_hours_json?.[day];
  if (!hours || typeof hours !== "object") {
    return NextResponse.json({
      slots: [],
      durationMinutes: duration,
      reason: "closed_today",
    });
  }

  const buffer = shop.booking_buffer_minutes || 0;

  // Test mode: skip Google entirely; return slots based purely on hours.
  if (shop.test_mode) {
    const candidates = generateSlots(date, hours, duration, buffer, tz);
    return NextResponse.json({
      slots: candidates.map((s) => ({ start: s })),
      durationMinutes: duration,
      test_mode: true,
    });
  }

  try {
    await refreshIfNeeded(auth.shopId, "google_calendar");
    const provider = getProvider("google_calendar")!;
    const slots = await provider.checkAvailability(auth.shopId, {
      date,
      durationMinutes: duration,
      timezone: tz,
    });

    return NextResponse.json({ slots, durationMinutes: duration });
  } catch (e: any) {
    console.error("Check availability error:", e);
    return NextResponse.json(
      {
        error: "calendar_unavailable",
        message: e?.message || "Availability check failed",
      },
      { status: 500 }
    );
  }
}
