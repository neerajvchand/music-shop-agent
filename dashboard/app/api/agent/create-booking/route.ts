import { NextRequest, NextResponse } from "next/server";
import { verifyAgentRequest } from "../_auth";
import { refreshIfNeeded } from "@/lib/integrations/refresh";
import { getProvider } from "@/lib/integrations/registry";
import { createServiceClient } from "@/lib/supabase";
import { logIntegrationEvent } from "@/lib/integrations/events";
import {
  validateBookAppointmentArgs,
  type BusinessHours,
  type ServiceCatalogEntry,
} from "@/lib/booking/validation";

export async function POST(request: NextRequest) {
  const auth = verifyAgentRequest(request);
  if (!auth.ok) return auth.response;

  const body = await request.json();
  const {
    customerName,
    customerPhone,
    service,
    startTime,
    durationMinutes,
    notes,
  } = body;

  // Pull settings the validator needs + test_mode + gcal_calendar_id.
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

  // Defense-in-depth validation. Same shape as the Python validator.
  const validation = validateBookAppointmentArgs(
    {
      service,
      customerPhone,
      startTime,
      durationMinutes,
    },
    shop,
    null,
  );
  if (!validation.ok) {
    return NextResponse.json(validation.error, { status: 400 });
  }

  const finalDuration = validation.durationMinutes;

  // Atomic guard: insert reserved → write Google → confirm.
  const { data: bookingRow, error: insertError } = await supabase
    .from("bookings")
    .insert({
      shop_id: auth.shopId,
      service,
      scheduled_at: startTime,
      duration_min: finalDuration,
      customer_name: customerName,
      customer_phone: customerPhone || null,
      notes: notes || null,
      status: "reserved",
    })
    .select("id")
    .single();

  if (insertError) {
    if (insertError.code === "23505") {
      return NextResponse.json(
        {
          error: "slot_taken",
          message: "That time was just booked. Want to pick another?",
        },
        { status: 409 }
      );
    }
    return NextResponse.json(
      { error: "insert_failed", message: insertError.message },
      { status: 500 }
    );
  }

  const bookingId = bookingRow.id;

  // Test mode short-circuit: no Google call, mark test_confirmed.
  if (shop.test_mode) {
    await supabase
      .from("bookings")
      .update({ status: "test_confirmed" })
      .eq("id", bookingId);

    return NextResponse.json({
      success: true,
      bookingId,
      test_mode: true,
    });
  }

  // Real Google write.
  try {
    await refreshIfNeeded(auth.shopId, "google_calendar");
    const provider = getProvider("google_calendar")!;

    const result = await provider.createBooking(auth.shopId, {
      customerName,
      customerPhone: customerPhone || "",
      service,
      startTime,
      durationMinutes: finalDuration,
      notes,
    });

    if (!result.success) {
      throw new Error(result.error || "Google Calendar booking failed");
    }

    await supabase
      .from("bookings")
      .update({
        status: "confirmed",
        gcal_event_id: result.providerEventId,
      })
      .eq("id", bookingId);

    return NextResponse.json({
      success: true,
      bookingId,
      providerEventId: result.providerEventId,
    });
  } catch (e: any) {
    // TODO(phase-3b): surface pending_sync rows in dashboard "Needs Attention"
    // list with a retry action. For now, leave the booking reserved and mark
    // it pending_sync so it doesn't disappear from the owner's view.
    await supabase
      .from("bookings")
      .update({ status: "pending_sync" })
      .eq("id", bookingId);

    await logIntegrationEvent(auth.shopId, "google_calendar", "booking_failed", {
      error: e?.message || "Unknown error",
      booking_id: bookingId,
      start_time: startTime,
      service,
    });

    // The Supabase reservation succeeded, so the slot is held; tell the agent
    // the booking is recorded but flag the sync issue for ops follow-up.
    return NextResponse.json({
      success: true,
      bookingId,
      pending_sync: true,
      message: "Booking recorded; calendar sync queued.",
    });
  }
}
