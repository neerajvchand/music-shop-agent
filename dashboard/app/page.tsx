import Link from "next/link";
import { createClient } from "@/lib/supabase";
import { IntegrationCard } from "@/components/IntegrationCard";
import { StatsStrip } from "@/components/stats-strip";
import { DecisionsList } from "@/components/decisions-list";
import { LogoutButton } from "@/components/logout-button";
import { LoginForm } from "@/components/login-form";
import { Settings } from "lucide-react";

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;

  try {
    const supabase = await createClient();

    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return <LoginScreen />;
    }

    // Find shop by owner email
    const { data: shop, error: shopError } = await supabase
      .from("shops")
      .select("id, name, slug, owner_email, owner_name")
      .eq("owner_email", user.email)
      .single();

    if (shopError || !shop) {
      return (
        <div className="flex min-h-screen items-center justify-center">
          <div className="text-center">
            <h1 className="text-xl font-semibold">No shop found</h1>
            <p className="text-muted-foreground mt-2">
              Your account ({user.email}) is not linked to any shop yet.
            </p>
            <LogoutButton className="mt-4" />
          </div>
        </div>
      );
    }

    // Fetch calendar integration status
    const { data: integration } = await supabase
      .from("shop_integrations")
      .select("status, provider_account_email, updated_at")
      .eq("shop_id", shop.id)
      .eq("provider", "google_calendar")
      .single();

    // Fetch today's stats
    const today = new Date().toISOString().split("T")[0];
    const dayStart = `${today}T00:00:00Z`;
    const dayEnd = `${today}T23:59:59Z`;

    const { count: callsCount } = await supabase
      .from("calls")
      .select("*", { count: "exact", head: true })
      .eq("shop_id", shop.id)
      .gte("started_at", dayStart)
      .lte("started_at", dayEnd);

    const { count: bookingsCount } = await supabase
      .from("bookings")
      .select("*", { count: "exact", head: true })
      .eq("shop_id", shop.id)
      .eq("status", "confirmed")
      .gte("created_at", dayStart)
      .lte("created_at", dayEnd);

    const { count: missedCount } = await supabase
      .from("calls")
      .select("*", { count: "exact", head: true })
      .eq("shop_id", shop.id)
      .eq("outcome", "abandoned")
      .gte("started_at", dayStart)
      .lte("started_at", dayEnd);

    // Fetch pending decisions
    const { data: decisions } = await supabase
      .from("owner_decisions")
      .select("id, decision_type, title, body, created_at")
      .eq("shop_id", shop.id)
      .eq("status", "pending")
      .order("created_at", { ascending: false })
      .limit(5);

    return (
      <main className="max-w-3xl mx-auto p-6 space-y-6">
        <header className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">{shop.name}</h1>
            <p className="text-sm text-muted-foreground">
              Signed in as {user.email}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Link
              href="/settings"
              className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm font-medium hover:bg-muted transition-colors"
            >
              <Settings className="h-4 w-4" />
              Settings
            </Link>
            <LogoutButton />
          </div>
        </header>

        {(params.error || params.connected) && (
          <Banner
            type={params.connected ? "success" : "error"}
            message={
              params.connected
                ? "Google Calendar connected successfully."
                : String(params.error)
            }
          />
        )}

        <IntegrationCard
          provider="google_calendar"
          name="Google Calendar"
          status={integration?.status || "disconnected"}
          accountEmail={integration?.provider_account_email}
        />

        <StatsStrip
          calls={callsCount ?? 0}
          bookings={bookingsCount ?? 0}
          missed={missedCount ?? 0}
        />

        <DecisionsList decisions={decisions ?? []} />
      </main>
    );
  } catch (err: any) {
    console.error("Dashboard error:", err);
    return (
      <div className="flex min-h-screen items-center justify-center p-6">
        <div className="max-w-lg w-full rounded-xl border border-red-200 bg-red-50 p-6">
          <h1 className="text-lg font-semibold text-red-800">Server Error</h1>
          <p className="mt-2 text-sm text-red-700">{err?.message || "Unknown error"}</p>
          <pre className="mt-4 text-xs text-red-600 overflow-auto">{err?.stack || ""}</pre>
        </div>
      </div>
    );
  }
}

function LoginScreen() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-muted">
      <div className="w-full max-w-sm bg-card rounded-xl border border-border p-6 shadow-sm">
        <h1 className="text-xl font-semibold text-center">Riyaaz Dashboard</h1>
        <p className="text-sm text-muted-foreground text-center mt-2">
          Sign in with your email to manage your shop.
        </p>
        <LoginForm />
      </div>
    </div>
  );
}

function Banner({
  type,
  message,
}: {
  type: "success" | "error";
  message: string;
}) {
  return (
    <div
      className={`rounded-lg px-4 py-3 text-sm font-medium ${
        type === "success"
          ? "bg-green-50 text-green-800 border border-green-200"
          : "bg-red-50 text-red-800 border border-red-200"
      }`}
    >
      {message}
    </div>
  );
}
