import { NextRequest, NextResponse } from "next/server";
import { verifyAgentRequest } from "../_auth";
import { refreshIfNeeded } from "@/lib/integrations/refresh";
import { getProvider } from "@/lib/integrations/registry";
import { createServiceClient } from "@/lib/supabase";

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
      return NextResponse.json(
        { error: result.error || "Booking failed" },
        { status: 500 }
      );
    }

    // Create local booking record
    const supabase = createServiceClient();
    const { data: bookingRow, error: bookingError } = await supabase
      .from("bookings")
      .insert({
        shop_id: auth.shopId,
        service,
        scheduled_at: startTime,
        duration_min: parseInt(durationMinutes, 10),
        customer_name: customerName,
        customer_phone: customerPhone || null,
        notes: notes || null,
        gcal_event_id: result.providerEventId,
      })
      .select("id")
      .single();

    if (bookingError) {
      console.error("Local booking insert failed:", bookingError);
      // Don't fail the whole request — the GCal event was created
    }

    return NextResponse.json({
      success: true,
      bookingId: bookingRow?.id,
      providerEventId: result.providerEventId,
    });
  } catch (e: any) {
    console.error("Create booking error:", e);
    return NextResponse.json(
      { error: e?.message || "Booking failed" },
      { status: 500 }
    );
  }
}
