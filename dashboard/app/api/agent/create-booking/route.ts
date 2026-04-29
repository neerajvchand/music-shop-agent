import { NextRequest, NextResponse } from "next/server";
import { verifyAgentRequest } from "../_auth";
import { refreshIfNeeded } from "@/lib/integrations/refresh";
import { getProvider } from "@/lib/integrations/registry";
import { createServiceClient } from "@/lib/supabase";
import { logIntegrationEvent } from "@/lib/integrations/events";

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

  if (!customerName || !service || !startTime || !durationMinutes) {
    return NextResponse.json(
      { error: "Missing required booking fields" },
      { status: 400 }
    );
  }

  const supabase = createServiceClient();

  // 1. Lock the slot in the database first
  const { data: bookingRow, error: insertError } = await supabase
    .from("bookings")
    .insert({
      shop_id: auth.shopId,
      service,
      scheduled_at: startTime,
      duration_min: parseInt(durationMinutes, 10),
      customer_name: customerName,
      customer_phone: customerPhone || null,
      notes: notes || null,
    })
    .select("id")
    .single();

  if (insertError) {
    // Unique violation = slot already taken
    if (insertError.code === "23505") {
      return NextResponse.json(
        { error: "slot_taken" },
        { status: 409 }
      );
    }
    return NextResponse.json(
      { error: insertError.message },
      { status: 500 }
    );
  }

  const bookingId = bookingRow.id;

  // 2. Create Google Calendar event
  try {
    await refreshIfNeeded(auth.shopId, "google_calendar");
    const provider = getProvider("google_calendar")!;

    const result = await provider.createBooking(auth.shopId, {
      customerName,
      customerPhone: customerPhone || "",
      service,
      startTime,
      durationMinutes: parseInt(durationMinutes, 10),
      notes,
    });

    if (!result.success) {
      throw new Error(result.error || "Google Calendar booking failed");
    }

    // Update local booking with GCal event ID
    await supabase
      .from("bookings")
      .update({ gcal_event_id: result.providerEventId })
      .eq("id", bookingId);

    return NextResponse.json({
      success: true,
      bookingId,
      providerEventId: result.providerEventId,
    });
  } catch (e: any) {
    // 3. Rollback: delete the local booking
    await supabase.from("bookings").delete().eq("id", bookingId);

    await logIntegrationEvent(auth.shopId, "google_calendar", "booking_failed", {
      error: e?.message || "Unknown error",
      start_time: startTime,
      service,
    });

    return NextResponse.json(
      { error: e?.message || "Booking failed" },
      { status: 500 }
    );
  }
}
