import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";

export async function POST(request: NextRequest) {
  try {
    const { email, password } = await request.json();

    if (!email || !password || password.length < 6) {
      return NextResponse.json(
        { error: "Email and password (min 6 chars) required" },
        { status: 400 }
      );
    }

    const supabase = createServiceClient();

    const { data, error } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }

    return NextResponse.json({
      message: "Account created. You can now sign in.",
      user: { id: data.user?.id, email: data.user?.email },
    });
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message || "Signup failed" },
      { status: 500 }
    );
  }
}
